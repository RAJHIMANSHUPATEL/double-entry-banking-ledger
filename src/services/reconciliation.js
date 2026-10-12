import pino from "pino";
import { config } from "../config.js";
import { nowUtc } from "../domain/clock.js";
import { parseBankCsv } from "../importers/csvBank.js";
import { datesWithin, matchLines } from "../importers/matcher.js";
import { getAccount } from "./accounts.js";
import {
  AccountNotPostable,
  AlreadyMatched,
  CsvRejected,
  InvalidEntry,
  StatementLineNotFound,
  StatementNotFound,
} from "./exceptions.js";

const log = pino({ level: config.logLevel });

/**
 * Test seam. A concurrency test pauses here after both imports have chosen
 * the same journal line and before either update commits.
 */
export const reconciliationInternals = {
  async beforePersist() {},
};

/**
 * Import a bank CSV and classify lines. Does not post and does not take the ledger lock.
 * @param {import('pg').Pool} db
 * @param {{ bankAccountCode: string, filename: string, content: Buffer | string, actor: string }} input
 */
export async function importStatement(db, input) {
  const client = await db.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const account = await getAccount(client, input.bankAccountCode);
    if (!account.isActive || account.isGroup) {
      throw new AccountNotPostable(account.code, account.isGroup ? "group accounts are not postable" : "inactive");
    }
    if (account.type !== "asset") {
      throw new InvalidEntry("Bank statements can only be imported for an asset account.", { account_code: account.code });
    }

    const parsed = parseBankCsv(input.content);
    if (parsed.rows.length === 0) {
      throw new CsvRejected("The CSV has no usable rows.", { errors: parsed.errors });
    }

    const uploadedAt = nowUtc();
    const inserted = await client.query(
      `INSERT INTO bank_statements (bank_account_id, source_filename, uploaded_by, uploaded_at, row_count)
       VALUES ((SELECT id FROM accounts WHERE code = $1), $2, $3, $4, $5)
       RETURNING id`,
      [account.code, input.filename.slice(0, 255), input.actor, uploadedAt, parsed.rows.length],
    );
    const statementId = inserted.rows[0].id;
    await client.query("UPDATE bank_statements SET row_count = row_count WHERE id = $1", [statementId]);

    const lineIds = new Map();
    for (const row of parsed.rows) {
      const line = await client.query(
        `INSERT INTO bank_statement_lines (
           statement_id, row_number, txn_date, narration, amount_paise, bank_balance_paise,
           match_status, raw_json
         ) VALUES ($1, $2, $3, $4, $5, $6, 'unmatched', $7)
         RETURNING id`,
        [statementId, row.rowNumber, row.txnDate, row.narration, row.amountPaise, row.bankBalancePaise, JSON.stringify(row.raw)],
      );
      lineIds.set(row.rowNumber, line.rows[0].id);
    }

    const candidates = await loadOpenJournalLines(client, account.code);
    const decisions = matchLines(
      parsed.rows.map((row) => ({
        rowNumber: row.rowNumber,
        txnDate: row.txnDate,
        amountPaise: row.amountPaise,
        narration: row.narration,
      })),
      candidates,
      {
        windowDays: config.dateWindowDays,
        autoThreshold: config.fuzzyAutoThreshold,
        suggestThreshold: config.fuzzySuggestThreshold,
      },
    );

    await reconciliationInternals.beforePersist();
    for (const decision of decisions) {
      const lineId = lineIds.get(decision.rowNumber);
      const matchedId = decision.status === "matched" ? decision.journalLineId : null;
      const candidateId = decision.status === "matched" || decision.status === "suggested" ? decision.journalLineId : null;
      await client.query(
        `UPDATE bank_statement_lines
         SET match_status = $2,
             matched_journal_line_id = $3,
             candidate_journal_line_id = $4,
             match_score = $5
         WHERE id = $1`,
        [lineId, decision.status, matchedId, candidateId, decision.score],
      );
      if (decision.status === "matched" || decision.status === "suggested") {
        await client.query(
          `INSERT INTO reconciliation_events (
             statement_line_id, journal_line_id, action, score, actor, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            lineId,
            decision.journalLineId,
            decision.status === "matched" ? "auto_match" : "suggest",
            decision.score,
            input.actor,
            uploadedAt,
          ],
        );
      }
    }

    await client.query("COMMIT");
    open = false;
    const statement = await getStatement(client, statementId);
    log.info(
      {
        statement_id: statementId,
        row_count: statement.rowCount,
        matched: statement.counts.matched,
        suggested: statement.counts.suggested,
        unmatched: statement.counts.unmatched,
      },
      "bank_statement_imported",
    );
    return { ...statement, errors: parsed.errors };
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    if (error.code === "23505" && String(error.constraint ?? "").includes("matched")) {
      throw new AlreadyMatched("That journal line is already matched.", { constraint: error.constraint });
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} accountCode
 */
async function loadOpenJournalLines(client, accountCode) {
  const result = await client.query(
    `SELECT l.id AS journal_line_id,
            e.entry_date,
            CASE WHEN l.debit_paise > 0 THEN l.debit_paise ELSE -l.credit_paise END AS signed_paise,
            CASE WHEN l.line_narration IS NOT NULL AND btrim(l.line_narration) <> '' THEN l.line_narration
                 ELSE e.narration END AS narration
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE a.code = $1
       AND NOT EXISTS (
         SELECT 1 FROM bank_statement_lines b
         WHERE b.matched_journal_line_id = l.id
       )
     ORDER BY l.id`,
    [accountCode],
  );
  return result.rows.map((row) => ({
    journalLineId: row.journal_line_id,
    entryDate: row.entry_date,
    signedPaise: row.signed_paise,
    narration: row.narration,
  }));
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {number} statementId
 */
export async function getStatement(db, statementId) {
  const result = await db.query(
    `SELECT s.id, s.source_filename, s.uploaded_by, s.uploaded_at, s.row_count, a.code AS bank_account_code
     FROM bank_statements s
     JOIN accounts a ON a.id = s.bank_account_id
     WHERE s.id = $1`,
    [statementId],
  );
  if (result.rowCount === 0) throw new StatementNotFound(statementId);
  const counts = await db.query(
    `SELECT match_status, COUNT(*)::integer AS n
     FROM bank_statement_lines
     WHERE statement_id = $1
     GROUP BY match_status`,
    [statementId],
  );
  const tally = { matched: 0, suggested: 0, unmatched: 0, rejected: 0 };
  for (const row of counts.rows) tally[row.match_status] = row.n;
  const statement = result.rows[0];
  return {
    id: statement.id,
    bankAccountCode: statement.bank_account_code,
    sourceFilename: statement.source_filename,
    uploadedBy: statement.uploaded_by,
    uploadedAt: statement.uploaded_at,
    rowCount: statement.row_count,
    counts: tally,
  };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} statementId
 * @param {string | undefined} status
 */
export async function listStatementLines(client, statementId, status) {
  await getStatement(client, statementId);
  const params = [statementId];
  let filter = "";
  if (status) {
    params.push(status);
    filter = " AND match_status = $2";
  }
  const result = await client.query(
    `SELECT id, row_number, txn_date, narration, amount_paise, bank_balance_paise,
            match_status, matched_journal_line_id, candidate_journal_line_id, match_score
     FROM bank_statement_lines
     WHERE statement_id = $1${filter}
     ORDER BY row_number`,
    params,
  );
  return result.rows.map(mapLine);
}

/**
 * Confirm a suggestion, or bind an unmatched line to a journal line the reviewer names.
 * The amount and the date window still have to agree. The score does not.
 * @param {import('pg').Pool} db
 * @param {number} lineId
 * @param {string} actor
 * @param {number | null} journalLineId
 */
export async function confirmLine(db, lineId, actor, journalLineId) {
  const client = await db.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const line = await lockStatementLine(client, lineId);
    if (line.matchStatus === "matched") {
      throw new AlreadyMatched("That statement line is already matched.", { statement_line_id: lineId });
    }
    const chosen = journalLineId ?? line.candidateJournalLineId;
    if (journalLineId == null) {
      if (line.matchStatus !== "suggested" || chosen == null) {
        throw new InvalidEntry("Confirm a suggestion, or name a journal line.");
      }
    } else if (line.matchStatus !== "suggested" && line.matchStatus !== "unmatched") {
      throw new InvalidEntry("Only a suggested or unmatched line can be matched.");
    }
    const journal = await lockJournalLine(client, chosen);
    if (journal.accountId !== line.bankAccountId) {
      throw new InvalidEntry("That journal line is not on this bank account.", { journal_line_id: chosen });
    }
    if (journal.signedPaise !== line.amountPaise) {
      throw new InvalidEntry("The journal line amount does not match the statement line.", {
        statement_paise: line.amountPaise,
        journal_paise: journal.signedPaise,
      });
    }
    if (!datesWithin(line.txnDate, journal.entryDate, config.dateWindowDays)) {
      throw new InvalidEntry("The journal line is outside the date window.", {
        txn_date: line.txnDate,
        entry_date: journal.entryDate,
        window_days: config.dateWindowDays,
      });
    }
    const action = chosen === line.candidateJournalLineId ? "confirm" : "manual_match";
    await client.query(
      `UPDATE bank_statement_lines
       SET match_status = 'matched',
           matched_journal_line_id = $2,
           candidate_journal_line_id = COALESCE(candidate_journal_line_id, $2)
       WHERE id = $1`,
      [lineId, chosen],
    );
    await insertEvent(client, lineId, chosen, action, line.matchScore, actor);
    await client.query("COMMIT");
    open = false;
    return loadLine(client, lineId);
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    if (error.code === "23505" && String(error.constraint ?? "").includes("matched")) {
      throw new AlreadyMatched("That journal line is already matched.", { journal_line_id: journalLineId });
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reject a suggestion. The pair is remembered so rematch will not offer it again.
 * @param {import('pg').Pool} db
 * @param {number} lineId
 * @param {string} actor
 */
export async function rejectLine(db, lineId, actor) {
  const client = await db.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const line = await lockStatementLine(client, lineId);
    if (line.matchStatus !== "suggested" || line.candidateJournalLineId == null) {
      throw new InvalidEntry("Only a suggestion can be rejected.", { match_status: line.matchStatus });
    }
    const rejectedId = line.candidateJournalLineId;
    await client.query(
      `UPDATE bank_statement_lines
       SET match_status = 'rejected', candidate_journal_line_id = NULL, match_score = NULL
       WHERE id = $1`,
      [lineId],
    );
    await insertEvent(client, lineId, rejectedId, "reject", line.matchScore, actor);
    await client.query("COMMIT");
    open = false;
    return loadLine(client, lineId);
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Re-run the matcher for unmatched and rejected lines. Matched lines stay matched.
 * @param {import('pg').Pool} db
 * @param {number} statementId
 * @param {string} actor
 */
export async function rematchStatement(db, statementId, actor) {
  const client = await db.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const statement = await client.query("SELECT id, bank_account_id FROM bank_statements WHERE id = $1 FOR UPDATE", [
      statementId,
    ]);
    if (statement.rowCount === 0) throw new StatementNotFound(statementId);
    const account = await client.query("SELECT code FROM accounts WHERE id = $1", [statement.rows[0].bank_account_id]);
    const openLines = await client.query(
      `SELECT id, row_number, txn_date, narration, amount_paise
       FROM bank_statement_lines
       WHERE statement_id = $1 AND match_status IN ('unmatched', 'rejected')
       ORDER BY row_number
       FOR UPDATE`,
      [statementId],
    );
    const rejected = await client.query(
      `SELECT l.row_number, e.journal_line_id
       FROM reconciliation_events e
       JOIN bank_statement_lines l ON l.id = e.statement_line_id
       WHERE l.statement_id = $1 AND e.action = 'reject' AND e.journal_line_id IS NOT NULL`,
      [statementId],
    );
    const rejectedPairs = new Set(rejected.rows.map((row) => `${row.row_number}:${row.journal_line_id}`));
    const candidates = await loadOpenJournalLines(client, account.rows[0].code);
    const decisions = matchLines(
      openLines.rows.map((row) => ({
        rowNumber: row.row_number,
        txnDate: row.txn_date,
        amountPaise: row.amount_paise,
        narration: row.narration,
      })),
      candidates,
      {
        windowDays: config.dateWindowDays,
        autoThreshold: config.fuzzyAutoThreshold,
        suggestThreshold: config.fuzzySuggestThreshold,
        rejectedPairs,
      },
    );
    const idsByRow = new Map(openLines.rows.map((row) => [row.row_number, row.id]));
    const now = nowUtc();
    for (const decision of decisions) {
      const lineId = idsByRow.get(decision.rowNumber);
      if (decision.status === "matched") {
        await client.query(
          `UPDATE bank_statement_lines
           SET match_status = 'matched', matched_journal_line_id = $2,
               candidate_journal_line_id = $2, match_score = $3
           WHERE id = $1`,
          [lineId, decision.journalLineId, decision.score],
        );
        await insertEvent(client, lineId, decision.journalLineId, "auto_match", decision.score, actor, now);
      } else if (decision.status === "suggested") {
        await client.query(
          `UPDATE bank_statement_lines
           SET match_status = 'suggested', matched_journal_line_id = NULL,
               candidate_journal_line_id = $2, match_score = $3
           WHERE id = $1`,
          [lineId, decision.journalLineId, decision.score],
        );
        await insertEvent(client, lineId, decision.journalLineId, "suggest", decision.score, actor, now);
      } else {
        await client.query(
          `UPDATE bank_statement_lines
           SET match_status = 'unmatched', matched_journal_line_id = NULL,
               candidate_journal_line_id = NULL, match_score = NULL
           WHERE id = $1`,
          [lineId],
        );
      }
    }
    await client.query("COMMIT");
    open = false;
    return getStatement(client, statementId);
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    if (error.code === "23505" && String(error.constraint ?? "").includes("matched")) {
      throw new AlreadyMatched("That journal line is already matched.");
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Journal lines on the statement's bank account that are not matched yet.
 * @param {import('pg').PoolClient} client
 * @param {number} statementId
 */
export async function listOpenJournalLines(client, statementId) {
  const statement = await client.query(
    `SELECT a.code FROM bank_statements s JOIN accounts a ON a.id = s.bank_account_id WHERE s.id = $1`,
    [statementId],
  );
  if (statement.rowCount === 0) throw new StatementNotFound(statementId);
  return loadOpenJournalLines(client, statement.rows[0].code);
}

/**
 * @param {import('pg').PoolClient} client
 */
export async function listReconciliationEvents(client) {
  const result = await client.query(
    `SELECT id, statement_line_id, journal_line_id, action, score, actor, created_at, note
     FROM reconciliation_events
     ORDER BY id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    statementLineId: row.statement_line_id,
    journalLineId: row.journal_line_id,
    action: row.action,
    score: row.score,
    actor: row.actor,
    createdAt: row.created_at,
    note: row.note,
  }));
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} lineId
 */
async function lockStatementLine(client, lineId) {
  const result = await client.query(
    `SELECT l.id, l.statement_id, l.txn_date, l.amount_paise, l.match_status,
            l.candidate_journal_line_id, l.match_score, s.bank_account_id
     FROM bank_statement_lines l
     JOIN bank_statements s ON s.id = l.statement_id
     WHERE l.id = $1
     FOR UPDATE OF l`,
    [lineId],
  );
  if (result.rowCount === 0) throw new StatementLineNotFound(lineId);
  const row = result.rows[0];
  return {
    id: row.id,
    statementId: row.statement_id,
    txnDate: row.txn_date,
    amountPaise: row.amount_paise,
    matchStatus: row.match_status,
    candidateJournalLineId: row.candidate_journal_line_id,
    matchScore: row.match_score,
    bankAccountId: row.bank_account_id,
  };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} journalLineId
 */
async function lockJournalLine(client, journalLineId) {
  const result = await client.query(
    `SELECT l.id, l.account_id, e.entry_date,
            CASE WHEN l.debit_paise > 0 THEN l.debit_paise ELSE -l.credit_paise END AS signed_paise
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.id = $1
     FOR UPDATE OF l`,
    [journalLineId],
  );
  if (result.rowCount === 0) throw new InvalidEntry("Journal line was not found.", { journal_line_id: journalLineId });
  return {
    id: result.rows[0].id,
    accountId: result.rows[0].account_id,
    entryDate: result.rows[0].entry_date,
    signedPaise: result.rows[0].signed_paise,
  };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} lineId
 * @param {number} journalLineId
 * @param {string} action
 * @param {number | null} score
 * @param {string} actor
 * @param {Date} [createdAt]
 */
async function insertEvent(client, lineId, journalLineId, action, score, actor, createdAt = nowUtc()) {
  await client.query(
    `INSERT INTO reconciliation_events (
       statement_line_id, journal_line_id, action, score, actor, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [lineId, journalLineId, action, score, actor, createdAt],
  );
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} lineId
 */
async function loadLine(client, lineId) {
  const result = await client.query(
    `SELECT id, row_number, txn_date, narration, amount_paise, bank_balance_paise,
            match_status, matched_journal_line_id, candidate_journal_line_id, match_score
     FROM bank_statement_lines WHERE id = $1`,
    [lineId],
  );
  return mapLine(result.rows[0]);
}

/**
 * @param {object} row
 */
function mapLine(row) {
  return {
    id: row.id,
    rowNumber: row.row_number,
    txnDate: row.txn_date,
    narration: row.narration,
    amountPaise: row.amount_paise,
    bankBalancePaise: row.bank_balance_paise,
    matchStatus: row.match_status,
    matchedJournalLineId: row.matched_journal_line_id,
    candidateJournalLineId: row.candidate_journal_line_id,
    matchScore: row.match_score,
  };
}

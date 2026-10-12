import pino from "pino";
import { config } from "../config.js";
import { nowUtc } from "../domain/clock.js";
import { parseBankCsv } from "../importers/csvBank.js";
import { matchLines } from "../importers/matcher.js";
import { getAccount } from "./accounts.js";
import { AccountNotPostable, AlreadyMatched, CsvRejected, InvalidEntry, StatementNotFound } from "./exceptions.js";

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
  return result.rows.map((row) => ({
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
  }));
}

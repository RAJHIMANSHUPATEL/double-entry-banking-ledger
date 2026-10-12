import { nowUtc } from "../domain/clock.js";
import { money } from "../domain/money.js";
import { balancePaise } from "./balances.js";
import { canonicalV1, hashCanonical } from "./hashing.js";
import {
  AccountNotFound,
  AccountNotPostable,
  IdempotencyConflict,
  InvariantViolation,
  InvalidEntry,
  Overdraft,
  UnbalancedEntry,
} from "./exceptions.js";

const LINE_CAP = 100000000000000;
const MAX_LINES = 50;

/**
 * Test seam. The sum check is invoked through this object so a test can force
 * a failure after the insert and prove the transaction rolls back.
 */
export const postingInternals = {
  /**
   * @param {import('pg').PoolClient} client
   * @param {number} entryId
   */
  async assertEntryInvariant(client, entryId) {
    const result = await client.query(
      `SELECT e.debit_total_paise,
              e.credit_total_paise,
              COUNT(l.id)::integer AS line_count,
              COALESCE(SUM(l.debit_paise), 0)::bigint AS debit_sum,
              COALESCE(SUM(l.credit_paise), 0)::bigint AS credit_sum
       FROM journal_entries e
       LEFT JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.id = $1
       GROUP BY e.id, e.debit_total_paise, e.credit_total_paise`,
      [entryId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.line_count < 2 ||
      row.debit_sum !== row.debit_total_paise ||
      row.credit_sum !== row.credit_total_paise
    ) {
      throw new InvariantViolation("Line sums do not match the journal header.");
    }
  },
};

/**
 * Post one balanced journal entry under the ledger row lock.
 * Idempotency fields are accepted and ignored until the lookup is added;
 * a null key posts normally.
 *
 * @param {import('pg').Pool} db
 * @param {{
 *   entryDate: string,
 *   narration: string,
 *   reference?: string | null,
 *   createdBy: string,
 *   lines: Array<{ accountCode: string, debitPaise: number, creditPaise: number, lineNarration?: string | null }>,
 *   reversesEntryId?: number | null,
 *   idempotencyKey?: string | null,
 *   requestHash?: string | null,
 *   skipOverdraft?: boolean,
 * }} input
 */
export async function postEntry(db, input) {
  const client = await db.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const meta = await lockLedger(client);
    // Replay rolls back because the ledger lock is held in this transaction.
    // A retry must not advance ledger_meta or allocate another sequence.
    const replay = await findReplay(client, input);
    if (replay) {
      await client.query("ROLLBACK");
      open = false;
      const existing = await loadEntry(client, replay.entryId);
      return { ...existing, replayed: true };
    }
    const draft = validateDraft(input);
    const accounts = await resolveAccounts(client, draft.lines);
    if (!input.skipOverdraft) {
      await assertNoOverdraft(client, draft.lines, accounts);
    }
    const sequenceNo = meta.last_sequence + 1;
    const prevHash = String(meta.last_hash).trim();
    const createdAt = nowUtc();
    const entryHash = hashCanonical(
      canonicalV1({
        sequenceNo,
        entryDate: draft.entryDate,
        narration: draft.narration,
        reference: draft.reference,
        reversesEntryId: input.reversesEntryId ?? null,
        createdBy: draft.createdBy,
        createdAt,
        prevHash,
        lines: draft.lines.map((line, index) => ({
          lineNo: index + 1,
          accountId: accounts.get(line.accountCode).id,
          debitPaise: line.debitPaise,
          creditPaise: line.creditPaise,
          lineNarration: line.lineNarration,
        })),
      }),
    );
    const inserted = await client.query(
      `INSERT INTO journal_entries (
         sequence_no, entry_date, narration, reference, reverses_entry_id,
         debit_total_paise, credit_total_paise, created_by, created_at, prev_hash, entry_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        sequenceNo,
        draft.entryDate,
        draft.narration,
        draft.reference,
        input.reversesEntryId ?? null,
        draft.debitTotal,
        draft.creditTotal,
        draft.createdBy,
        createdAt,
        prevHash,
        entryHash,
      ],
    );
    const entryId = inserted.rows[0].id;
    for (let index = 0; index < draft.lines.length; index += 1) {
      const line = draft.lines[index];
      const account = accounts.get(line.accountCode);
      await client.query(
        `INSERT INTO journal_lines (
           entry_id, account_id, line_no, debit_paise, credit_paise, line_narration
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [entryId, account.id, index + 1, line.debitPaise, line.creditPaise, line.lineNarration],
      );
    }
    if (input.idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys (key, request_hash, entry_id, created_at)
         VALUES ($1, $2, $3, $4)`,
        [input.idempotencyKey, input.requestHash, entryId, createdAt],
      );
    }
    await postingInternals.assertEntryInvariant(client, entryId);
    await client.query("UPDATE ledger_meta SET last_sequence = $1, last_hash = $2 WHERE id = 1", [
      sequenceNo,
      entryHash,
    ]);
    await client.query("COMMIT");
    open = false;
    const created = await loadEntry(client, entryId);
    return { ...created, replayed: false };
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    if (isIdempotencyUniqueViolation(error) && input.idempotencyKey) {
      const winner = await loadIdempotentWinner(db, input.idempotencyKey, input.requestHash);
      if (winner) return { ...winner, replayed: true };
    }
    throw error;
  } finally {
    client.release();
  }
}

function isIdempotencyUniqueViolation(error) {
  return error?.code === "23505" && error?.table === "idempotency_keys";
}

/**
 * Backstop when two transactions pass the pre-insert lookup. The ledger lock
 * should make this rare; the primary key is what keeps a single row.
 * @param {import('pg').Pool} db
 * @param {string} key
 * @param {string | null | undefined} requestHash
 */
async function loadIdempotentWinner(db, key, requestHash) {
  const reader = await db.connect();
  try {
    const found = await reader.query("SELECT request_hash, entry_id FROM idempotency_keys WHERE key = $1", [key]);
    if (found.rowCount === 0) return null;
    if (String(found.rows[0].request_hash).trim() !== requestHash) return null;
    return loadEntry(reader, found.rows[0].entry_id);
  } finally {
    reader.release();
  }
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ idempotencyKey?: string | null, requestHash?: string | null }} input
 */
async function findReplay(client, input) {
  if (input.idempotencyKey == null) return null;
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.idempotencyKey)) {
    throw new InvalidEntry("Idempotency-Key must be 1–128 characters from [A-Za-z0-9_.:-].");
  }
  if (typeof input.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(input.requestHash)) {
    throw new InvalidEntry("A request hash is required when an idempotency key is sent.");
  }
  const found = await client.query("SELECT request_hash, entry_id FROM idempotency_keys WHERE key = $1", [
    input.idempotencyKey,
  ]);
  if (found.rowCount === 0) return null;
  const storedHash = String(found.rows[0].request_hash).trim();
  if (storedHash !== input.requestHash) throw new IdempotencyConflict();
  return { entryId: found.rows[0].entry_id };
}

/**
 * @param {import('pg').PoolClient} client
 */
async function lockLedger(client) {
  const result = await client.query("SELECT id, last_sequence, last_hash FROM ledger_meta WHERE id = 1 FOR UPDATE");
  if (result.rowCount !== 1) {
    throw new InvariantViolation("ledger_meta has no genesis row.");
  }
  return result.rows[0];
}

function validateDraft(input) {
  if (!input || typeof input.createdBy !== "string" || input.createdBy.trim().length === 0 || input.createdBy.length > 64) {
    throw new InvalidEntry("created_by is required and must be at most 64 characters.");
  }
  const entryDate = assertEntryDate(input.entryDate);
  const narration = typeof input.narration === "string" ? input.narration.trim() : "";
  if (narration.length < 1 || narration.length > 500) {
    throw new InvalidEntry("Narration must be between 1 and 500 characters.");
  }
  let reference = input.reference ?? null;
  if (reference !== null) {
    if (typeof reference !== "string") throw new InvalidEntry("Reference must be a string.");
    reference = reference.trim();
    if (reference.length === 0) reference = null;
    else if (reference.length > 64) throw new InvalidEntry("Reference must be at most 64 characters.");
  }
  if (!Array.isArray(input.lines)) throw new InvalidEntry("Lines must be a list.");
  if (input.lines.length > MAX_LINES) {
    throw new InvalidEntry(`An entry accepts at most ${MAX_LINES} lines.`);
  }
  if (input.lines.length < 2) {
    throw new UnbalancedEntry("An entry needs at least two lines.", { line_count: input.lines.length });
  }

  const lines = input.lines.map((line, index) => normalizeLine(line, index));
  const debitTotal = lines.reduce((sum, line) => sum + line.debitPaise, 0);
  const creditTotal = lines.reduce((sum, line) => sum + line.creditPaise, 0);
  if (debitTotal !== creditTotal || debitTotal <= 0) {
    throw new UnbalancedEntry(`Debits (${debitTotal} paise) do not equal credits (${creditTotal} paise).`, {
      debit_paise: debitTotal,
      credit_paise: creditTotal,
    });
  }
  return {
    entryDate,
    narration,
    reference,
    createdBy: input.createdBy.trim(),
    lines,
    debitTotal,
    creditTotal,
  };
}

function assertEntryDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidEntry("entry_date must be YYYY-MM-DD.");
  }
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new InvalidEntry("entry_date is not a calendar date.");
  }
  return value;
}

function normalizeLine(line, index) {
  if (!line || typeof line.accountCode !== "string" || line.accountCode.trim().length === 0) {
    throw new InvalidEntry(`Line ${index + 1} is missing an account code.`);
  }
  let debitPaise;
  let creditPaise;
  try {
    debitPaise = money(line.debitPaise);
    creditPaise = money(line.creditPaise);
  } catch {
    throw new InvalidEntry(`Line ${index + 1} amounts must be integer paise.`);
  }
  if (debitPaise > LINE_CAP || creditPaise > LINE_CAP) {
    throw new InvalidEntry(`Line ${index + 1} exceeds the per-line cap.`);
  }
  const debitSide = debitPaise > 0 && creditPaise === 0;
  const creditSide = creditPaise > 0 && debitPaise === 0;
  if (!debitSide && !creditSide) {
    throw new InvalidEntry(`Line ${index + 1} must set exactly one of debit_paise or credit_paise.`);
  }
  let lineNarration = line.lineNarration ?? null;
  if (lineNarration !== null) {
    if (typeof lineNarration !== "string") throw new InvalidEntry(`Line ${index + 1} narration must be a string.`);
    lineNarration = lineNarration.trim();
    if (lineNarration.length === 0) lineNarration = null;
  }
  return {
    accountCode: line.accountCode.trim(),
    debitPaise,
    creditPaise,
    lineNarration,
  };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {Array<{ accountCode: string }>} lines
 */
async function resolveAccounts(client, lines) {
  const codes = [...new Set(lines.map((line) => line.accountCode))];
  const result = await client.query(
    `SELECT id, code, name, type, is_group, is_active, prevent_overdraft
     FROM accounts
     WHERE code = ANY($1::text[])`,
    [codes],
  );
  /** @type {Map<string, { id: number, code: string, name: string, type: string, is_group: boolean, is_active: boolean, prevent_overdraft: boolean }>} */
  const byCode = new Map(result.rows.map((row) => [row.code, row]));
  for (const code of codes) {
    const account = byCode.get(code);
    if (!account) throw new AccountNotFound(code);
    if (account.is_group) throw new AccountNotPostable(code, "group accounts cannot be posted");
    if (!account.is_active) throw new AccountNotPostable(code, "account is inactive");
  }
  return byCode;
}

async function assertNoOverdraft(client, lines, accounts) {
  /** @type {Map<number, { code: string, effect: number }>} */
  const effects = new Map();
  for (const line of lines) {
    const account = accounts.get(line.accountCode);
    if (!account.prevent_overdraft) continue;
    const current = effects.get(account.id) ?? { code: account.code, effect: 0 };
    current.effect += line.debitPaise - line.creditPaise;
    effects.set(account.id, current);
  }
  for (const [accountId, effect] of effects) {
    const balance = await balancePaise(client, accountId);
    if (balance + effect.effect < 0) {
      throw new Overdraft(effect.code, balance, effect.effect);
    }
  }
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ limit: number, offset: number }} page
 */
export async function listEntries(client, page) {
  const total = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
  const ids = await client.query(
    "SELECT id FROM journal_entries ORDER BY sequence_no DESC LIMIT $1 OFFSET $2",
    [page.limit, page.offset],
  );
  const entries = [];
  for (const row of ids.rows) {
    const entry = await loadEntry(client, row.id);
    if (entry) entries.push(entry);
  }
  return { entries, total: total.rows[0].n, limit: page.limit, offset: page.offset };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} entryId
 */
export async function loadEntry(client, entryId) {
  const header = await client.query(
    `SELECT id, sequence_no, entry_date, narration, reference, reverses_entry_id,
            debit_total_paise, credit_total_paise, created_by, created_at, prev_hash, entry_hash
     FROM journal_entries
     WHERE id = $1`,
    [entryId],
  );
  const lines = await client.query(
    `SELECT l.id, l.line_no, l.account_id, l.debit_paise, l.credit_paise, l.line_narration,
            a.code AS account_code, a.name AS account_name
     FROM journal_lines l
     JOIN accounts a ON a.id = l.account_id
     WHERE l.entry_id = $1
     ORDER BY l.line_no`,
    [entryId],
  );
  const row = header.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sequenceNo: row.sequence_no,
    entryDate: row.entry_date,
    narration: row.narration,
    reference: row.reference,
    reversesEntryId: row.reverses_entry_id,
    debitTotalPaise: row.debit_total_paise,
    creditTotalPaise: row.credit_total_paise,
    createdBy: row.created_by,
    createdAt: row.created_at,
    prevHash: String(row.prev_hash).trim(),
    entryHash: String(row.entry_hash).trim(),
    lines: lines.rows.map((line) => ({
      id: line.id,
      lineNo: line.line_no,
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      debitPaise: line.debit_paise,
      creditPaise: line.credit_paise,
      lineNarration: line.line_narration,
    })),
  };
}

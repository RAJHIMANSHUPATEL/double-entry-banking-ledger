import pino from "pino";
import { config } from "../config.js";
import { balancePaise } from "./balances.js";
import { AlreadyReversed, EntryNotFound } from "./exceptions.js";
import { loadEntry, postEntry } from "./posting.js";

const logger = pino({ level: config.logLevel });

/** Wrapper so tests can observe the warning without depending on pino internals. */
export const reversalLog = {
  /**
   * @param {object} payload
   */
  warn(payload) {
    logger.warn(payload, "overdraft_on_reversal");
  },
};

/**
 * Post a new entry that swaps the original lines. The original row is not updated.
 * @param {import('pg').Pool} db
 * @param {number} entryId
 * @param {{
 *   entryDate: string,
 *   narration: string,
 *   reference?: string | null,
 *   createdBy: string,
 *   idempotencyKey?: string | null,
 *   requestHash?: string | null,
 * }} options
 */
export async function reverseEntry(db, entryId, options) {
  const client = await db.connect();
  /** @type {Awaited<ReturnType<typeof loadEntry>>} */
  let original;
  try {
    original = await loadEntry(client, entryId);
    if (!original) throw new EntryNotFound(entryId);
    const existing = await client.query("SELECT id FROM journal_entries WHERE reverses_entry_id = $1", [entryId]);
    if (existing.rowCount && !options.idempotencyKey) throw new AlreadyReversed(entryId);
    if (!existing.rowCount) await warnIfReversalOverdraws(client, original);
  } finally {
    client.release();
  }

  try {
    return await postEntry(db, {
      entryDate: options.entryDate,
      narration: options.narration,
      reference: options.reference ?? null,
      createdBy: options.createdBy,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitPaise: line.creditPaise,
        creditPaise: line.debitPaise,
        lineNarration: line.lineNarration,
      })),
      reversesEntryId: entryId,
      idempotencyKey: options.idempotencyKey ?? null,
      requestHash: options.requestHash ?? null,
      skipOverdraft: true,
    });
  } catch (error) {
    if (error?.code === "23505" && String(error.constraint ?? "").includes("reversal")) {
      throw new AlreadyReversed(entryId);
    }
    throw error;
  }
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ lines: Array<{ accountCode: string, debitPaise: number, creditPaise: number }> }} original
 */
async function warnIfReversalOverdraws(client, original) {
  const codes = [...new Set(original.lines.map((line) => line.accountCode))];
  const accounts = await client.query(
    "SELECT id, code, prevent_overdraft FROM accounts WHERE code = ANY($1::text[])",
    [codes],
  );
  /** @type {Map<string, { id: number, effect: number }>} */
  const effects = new Map();
  for (const line of original.lines) {
    const account = accounts.rows.find((row) => row.code === line.accountCode);
    if (!account?.prevent_overdraft) continue;
    const current = effects.get(account.code) ?? { id: account.id, effect: 0 };
    current.effect += line.creditPaise - line.debitPaise;
    effects.set(account.code, current);
  }
  for (const [accountCode, effect] of effects) {
    const balance = await balancePaise(client, effect.id);
    const resulting = balance + effect.effect;
    if (resulting < 0) {
      reversalLog.warn({
        event: "overdraft_on_reversal",
        account_code: accountCode,
        resulting_balance_paise: resulting,
      });
    }
  }
}

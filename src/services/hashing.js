import { createHash } from "node:crypto";

const GENESIS = "0".repeat(64);

/**
 * Percent-encode the two delimiters that appear in the canonical entry string.
 * @param {unknown} value
 */
export function encodeHashField(value) {
  return String(value ?? "").replaceAll("%", "%25").replaceAll(";", "%3B");
}

/**
 * @param {Date | string} value
 * @returns {string}
 */
export function formatHashTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("created_at is not a timestamp.");
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Canonical v1 content. Field order is part of the hash contract.
 * @param {{
 *   sequenceNo: number,
 *   entryDate: string,
 *   narration: string,
 *   reference?: string | null,
 *   reversesEntryId?: number | null,
 *   createdBy: string,
 *   createdAt: Date | string,
 *   prevHash: string,
 *   lines: Array<{ lineNo: number, accountId: number, debitPaise: number, creditPaise: number, lineNarration?: string | null }>,
 * }} entry
 */
export function canonicalV1(entry) {
  const lines = [...entry.lines]
    .sort((left, right) => left.lineNo - right.lineNo)
    .map((line) =>
      [
        line.lineNo,
        line.accountId,
        line.debitPaise,
        line.creditPaise,
        encodeHashField(line.lineNarration ?? ""),
      ].join(":"),
    )
    .join(";");
  return [
    "v1",
    entry.sequenceNo,
    entry.entryDate,
    encodeHashField(entry.narration),
    encodeHashField(entry.reference ?? ""),
    entry.reversesEntryId ?? "",
    entry.createdBy,
    formatHashTime(entry.createdAt),
    entry.prevHash,
    lines,
  ].join("|");
}

/**
 * @param {string} canonical
 * @returns {string}
 */
export function hashCanonical(canonical) {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Recompute the chain in sequence order. Read-only.
 * @param {import('pg').PoolClient} client
 */
export async function verifyChain(client) {
  const result = await client.query(
    `SELECT e.id, e.sequence_no, e.entry_date, e.narration, e.reference, e.reverses_entry_id,
            e.created_by, e.created_at, e.prev_hash, e.entry_hash,
            l.line_no, l.account_id, l.debit_paise, l.credit_paise, l.line_narration
     FROM journal_entries e
     JOIN journal_lines l ON l.entry_id = e.id
     ORDER BY e.sequence_no, l.line_no`,
  );

  /** @type {Array<{ id: number, sequenceNo: number, entryDate: string, narration: string, reference: string | null, reversesEntryId: number | null, createdBy: string, createdAt: Date, prevHash: string, entryHash: string, lines: Array<{ lineNo: number, accountId: number, debitPaise: number, creditPaise: number, lineNarration: string | null }> }>} */
  const entries = [];
  for (const row of result.rows) {
    let current = entries.at(-1);
    if (!current || current.id !== row.id) {
      current = {
        id: row.id,
        sequenceNo: row.sequence_no,
        entryDate: row.entry_date,
        narration: row.narration,
        reference: row.reference,
        reversesEntryId: row.reverses_entry_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
        prevHash: String(row.prev_hash).trim(),
        entryHash: String(row.entry_hash).trim(),
        lines: [],
      };
      entries.push(current);
    }
    current.lines.push({
      lineNo: row.line_no,
      accountId: row.account_id,
      debitPaise: row.debit_paise,
      creditPaise: row.credit_paise,
      lineNarration: row.line_narration,
    });
  }

  let previousHash = GENESIS;
  for (const entry of entries) {
    if (entry.prevHash !== previousHash) {
      return broken(entry, entry.prevHash, previousHash, entries.length);
    }
    const recomputed = hashCanonical(canonicalV1(entry));
    if (recomputed !== entry.entryHash) {
      return broken(entry, entry.entryHash, recomputed, entries.length);
    }
    previousHash = entry.entryHash;
  }

  const head = entries.at(-1);
  return {
    ok: true,
    entriesChecked: entries.length,
    headSequence: head ? head.sequenceNo : 0,
    headHash: previousHash,
  };
}

function broken(entry, storedHash, recomputedHash, entriesChecked) {
  return {
    ok: false,
    entriesChecked,
    headSequence: entry.sequenceNo,
    headHash: entry.entryHash,
    failedSequence: entry.sequenceNo,
    storedHash,
    recomputedHash,
  };
}

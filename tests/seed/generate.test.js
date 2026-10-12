import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { importStatement } from "../../src/services/reconciliation.js";
import { balanceSheet, trialBalance } from "../../src/services/reporting.js";
import { verifyChain } from "../../src/services/hashing.js";
import { generate } from "../../src/seed/generate.js";
import { splitGst } from "../../src/seed/gst.js";
import { createTestSchema } from "../helpers/db.js";

const csvPath = path.join(process.cwd(), "data", "seed", "hdfc_apr_sep_2026.csv");

describe("splitGst", () => {
  it("keeps an invoice in balance when the 18 percent total does not split evenly", () => {
    const even = splitGst(101);
    expect(even).toEqual({ cgst: 9, sgst: 9 });
    expect(101 + even.cgst + even.sgst).toBe(119);

    const odd = splitGst(111);
    expect(odd.cgst).toBe(9);
    expect(odd.sgst).toBe(10);
    expect(odd.cgst + odd.sgst).toBe(Math.floor((111 * 18) / 100));
    const debit = 111 + odd.cgst + odd.sgst;
    const credit = 111 + odd.cgst + odd.sgst;
    expect(debit).toBe(credit);
  });
});

describe("generate", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    await db?.close();
  });

  it("seeds a fictional half-year and a bank CSV with the planted discrepancies", async () => {
    db = await createTestSchema();
    const summary = await generate(db.pool, { csvPath });
    expect(summary.entries).toBeGreaterThanOrEqual(280);
    expect(summary.entries).toBeLessThanOrEqual(320);
    expect(summary.headSequence).toBe(summary.entries);

    const client = await db.pool.connect();
    try {
      const chain = await verifyChain(client);
      expect(chain.ok).toBe(true);
      const tb = await trialBalance(client, "2026-09-30");
      expect(tb.differencePaise).toBe(0);
      const bs = await balanceSheet(client, "2026-09-30");
      expect(bs.balances.differencePaise).toBe(0);
      const rent = await client.query(
        `SELECT l.id
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
         WHERE e.reference = 'RENT-2026-09' AND a.code = '1120'`,
      );
      expect(rent.rowCount).toBe(1);
      const rentId = rent.rows[0].id;

      const csv = await readFile(csvPath, "utf8");
      expect(csv.startsWith("date,narration,withdrawal,deposit,balance\n")).toBe(true);
      const imported = await importStatement(db.pool, {
        bankAccountCode: "1120",
        filename: "hdfc_apr_sep_2026.csv",
        content: csv,
        actor: "seed-bot",
      });
      expect(imported.errors).toEqual([]);
      const counts = imported.counts;
      expect(counts.matched + counts.suggested + counts.unmatched + counts.rejected).toBe(imported.rowCount);
      expect(counts.suggested).toBeGreaterThan(0);

      const lines = await client.query(
        `SELECT narration, amount_paise, match_status, matched_journal_line_id
         FROM bank_statement_lines WHERE statement_id = $1`,
        [imported.id],
      );
      expect(lines.rows.some((row) => row.narration.includes("unknown credit") && row.match_status === "unmatched")).toBe(true);
      expect(lines.rows.some((row) => [11800, 5900].includes(Math.abs(row.amount_paise)) && row.match_status === "unmatched")).toBe(true);
      const matchedIds = lines.rows.map((row) => row.matched_journal_line_id).filter((id) => id != null);
      expect(new Set(matchedIds).size).toBe(matchedIds.length);
      expect(matchedIds).not.toContain(rentId);
    } finally {
      client.release();
    }

    await expect(generate(db.pool, { csvPath })).rejects.toThrow(/already has entries/);
  }, 180000);
});

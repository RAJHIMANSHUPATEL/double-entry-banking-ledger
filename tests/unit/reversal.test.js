import { afterEach, describe, expect, it, vi } from "vitest";
import { seedChart } from "../../src/seed/chart.js";
import { balancePaise } from "../../src/services/balances.js";
import { AlreadyReversed, EntryNotFound, Overdraft } from "../../src/services/exceptions.js";
import { verifyChain } from "../../src/services/hashing.js";
import { postEntry } from "../../src/services/posting.js";
import { reversalLog, reverseEntry } from "../../src/services/reversal.js";
import { createTestSchema } from "../helpers/db.js";

describe("reverseEntry", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close();
    db = undefined;
  });

  it("swaps the lines, links the original, and leaves the original row unchanged", async () => {
    db = await createTestSchema();
    await withChart(db);
    await postEntry(db.pool, balanced("1120", "3100", 20000, "Fund the bank"));
    const original = await postEntry(db.pool, {
      entryDate: "2026-04-04",
      narration: "Studio rent",
      reference: "RENT-1",
      createdBy: "tester",
      lines: [
        { accountCode: "5200", debitPaise: 5000, creditPaise: 0, lineNarration: "April" },
        { accountCode: "1120", debitPaise: 0, creditPaise: 5000, lineNarration: "April" },
      ],
    });
    const reversal = await reverseEntry(db.pool, original.id, {
      entryDate: "2026-04-05",
      narration: "Reverse rent",
      createdBy: "reviewer",
    });
    expect(reversal.reversesEntryId).toBe(original.id);
    expect(reversal.lines.map((line) => [line.accountCode, line.debitPaise, line.creditPaise, line.lineNarration])).toEqual([
      ["5200", 0, 5000, "April"],
      ["1120", 5000, 0, "April"],
    ]);

    const client = await db.pool.connect();
    try {
      const stored = await client.query(
        "SELECT narration, entry_hash, created_at FROM journal_entries WHERE id = $1",
        [original.id],
      );
      expect(stored.rows[0].narration).toBe("Studio rent");
      expect(String(stored.rows[0].entry_hash).trim()).toBe(original.entryHash);
      expect(new Date(stored.rows[0].created_at).toISOString()).toBe(new Date(original.createdAt).toISOString());
      expect(await trialBalanceDifference(client)).toBe(0);
      const verified = await verifyChain(client);
      expect(verified.ok).toBe(true);
      expect(verified.entriesChecked).toBe(3);
    } finally {
      client.release();
    }
  });

  it("refuses a second reversal and does not add a row", async () => {
    db = await createTestSchema();
    await withChart(db);
    const original = await postEntry(db.pool, balanced("1110", "3100", 1000, "Capital"));
    await reverseEntry(db.pool, original.id, {
      entryDate: "2026-04-06",
      narration: "Reverse capital",
      createdBy: "tester",
    });
    await expect(
      reverseEntry(db.pool, original.id, {
        entryDate: "2026-04-07",
        narration: "Reverse capital again",
        createdBy: "tester",
      }),
    ).rejects.toBeInstanceOf(AlreadyReversed);
    const client = await db.pool.connect();
    try {
      const count = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(count.rows[0].n).toBe(2);
    } finally {
      client.release();
    }
  });

  it("allows a reversal to drive cash negative and still refuses a new overdraft", async () => {
    db = await createTestSchema();
    await withChart(db);
    const warnings = [];
    vi.spyOn(reversalLog, "warn").mockImplementation((payload) => {
      warnings.push(payload);
    });
    const deposit = await postEntry(db.pool, balanced("1110", "3100", 5000, "Cash deposit"));
    await postEntry(db.pool, balanced("5700", "1110", 5000, "Spend the deposit"));
    const reversal = await reverseEntry(db.pool, deposit.id, {
      entryDate: "2026-04-08",
      narration: "Reverse the deposit",
      createdBy: "tester",
    });
    expect(reversal.sequenceNo).toBe(3);
    expect(warnings).toEqual([
      expect.objectContaining({
        event: "overdraft_on_reversal",
        account_code: "1110",
        resulting_balance_paise: -5000,
      }),
    ]);
    const client = await db.pool.connect();
    try {
      const cash = await client.query("SELECT id FROM accounts WHERE code = '1110'");
      expect(await balancePaise(client, cash.rows[0].id)).toBe(-5000);
      const verified = await verifyChain(client);
      expect(verified.ok).toBe(true);
      expect(verified.entriesChecked).toBe(3);
      expect(await trialBalanceDifference(client)).toBe(0);
    } finally {
      client.release();
    }
    await expect(postEntry(db.pool, balanced("5700", "1110", 1, "One more paisa"))).rejects.toBeInstanceOf(Overdraft);
  });

  it("raises EntryNotFound for an unknown id", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(
      reverseEntry(db.pool, 999999, { entryDate: "2026-04-08", narration: "Missing", createdBy: "tester" }),
    ).rejects.toBeInstanceOf(EntryNotFound);
  });
});

async function withChart(db) {
  const client = await db.pool.connect();
  try {
    await seedChart(client);
  } finally {
    client.release();
  }
}

function balanced(debitCode, creditCode, paise, narration) {
  return {
    entryDate: "2026-04-04",
    narration,
    reference: null,
    createdBy: "tester",
    lines: [
      { accountCode: debitCode, debitPaise: paise, creditPaise: 0 },
      { accountCode: creditCode, debitPaise: 0, creditPaise: paise },
    ],
  };
}

async function trialBalanceDifference(client) {
  const result = await client.query(
    `SELECT COALESCE(SUM(debit_paise), 0)::bigint AS debits,
            COALESCE(SUM(credit_paise), 0)::bigint AS credits
     FROM journal_lines`,
  );
  return result.rows[0].debits - result.rows[0].credits;
}

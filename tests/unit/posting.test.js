import { afterEach, describe, expect, it, vi } from "vitest";
import { seedChart } from "../../src/seed/chart.js";
import { postingInternals, postEntry } from "../../src/services/posting.js";
import {
  AccountNotFound,
  AccountNotPostable,
  InvariantViolation,
  InvalidEntry,
  Overdraft,
  UnbalancedEntry,
} from "../../src/services/exceptions.js";
import { balancePaise } from "../../src/services/balances.js";
import { createTestSchema } from "../helpers/db.js";

describe("postEntry", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close();
    db = undefined;
  });

  it("posts a balanced cash and capital entry and advances the cursor", async () => {
    db = await createTestSchema();
    await withChart(db);
    const entry = await postEntry(db.pool, capitalDraft());
    expect(entry.sequenceNo).toBe(1);
    expect(entry.prevHash).toBe("0".repeat(64));
    expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.debitTotalPaise).toBe(10000);
    expect(entry.creditTotalPaise).toBe(10000);
    expect(entry.createdBy).toBe("tester");
    expect(entry.lines).toHaveLength(2);

    const client = await db.pool.connect();
    try {
      const meta = await client.query("SELECT last_sequence, last_hash FROM ledger_meta WHERE id = 1");
      expect(meta.rows[0].last_sequence).toBe(1);
      expect(String(meta.rows[0].last_hash).trim()).toBe(entry.entryHash);
      const count = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(count.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  });

  it("posts a three-line GST entry after capital and stores matching sums", async () => {
    db = await createTestSchema();
    await withChart(db);
    await postEntry(db.pool, capitalDraft({ lines: cashCapital(50000) }));
    const entry = await postEntry(
      db.pool,
      capitalDraft({
        narration: "Invoice receipt",
        lines: [
          { accountCode: "1120", debitPaise: 11800, creditPaise: 0 },
          { accountCode: "4100", debitPaise: 0, creditPaise: 10000 },
          { accountCode: "2210", debitPaise: 0, creditPaise: 900 },
          { accountCode: "2220", debitPaise: 0, creditPaise: 900 },
        ],
      }),
    );
    expect(entry.debitTotalPaise).toBe(11800);
    expect(entry.creditTotalPaise).toBe(11800);
    expect(entry.lines.map((line) => line.debitPaise + line.creditPaise)).toEqual([11800, 10000, 900, 900]);
  });

  it("rejects unequal totals and leaves the genesis cursor untouched", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(
      postEntry(
        db.pool,
        capitalDraft({
          lines: [
            { accountCode: "1110", debitPaise: 150000, creditPaise: 0 },
            { accountCode: "3100", debitPaise: 0, creditPaise: 140000 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(UnbalancedEntry);
    await expectGenesis(db);
  });

  it("rejects a one-line entry", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(
      postEntry(db.pool, capitalDraft({ lines: [{ accountCode: "1110", debitPaise: 100, creditPaise: 0 }] })),
    ).rejects.toBeInstanceOf(UnbalancedEntry);
    await expectGenesis(db);
  });

  it("rejects an empty narration as a validation error", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(postEntry(db.pool, capitalDraft({ narration: "   " }))).rejects.toBeInstanceOf(InvalidEntry);
    await expectGenesis(db);
  });

  it("rejects a line that sets both sides", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(
      postEntry(
        db.pool,
        capitalDraft({
          lines: [
            { accountCode: "1110", debitPaise: 100, creditPaise: 100 },
            { accountCode: "3100", debitPaise: 0, creditPaise: 100 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidEntry);
    await expectGenesis(db);
  });

  it("rejects an unknown account code", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(
      postEntry(
        db.pool,
        capitalDraft({
          lines: [
            { accountCode: "9999", debitPaise: 100, creditPaise: 0 },
            { accountCode: "3100", debitPaise: 0, creditPaise: 100 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(AccountNotFound);
    await expectGenesis(db);
  });

  it("rejects a post to the Assets group", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(
      postEntry(
        db.pool,
        capitalDraft({
          lines: [
            { accountCode: "1000", debitPaise: 100, creditPaise: 0 },
            { accountCode: "3100", debitPaise: 0, creditPaise: 100 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(AccountNotPostable);
    await expectGenesis(db);
  });

  it("rejects a post to a deactivated leaf", async () => {
    db = await createTestSchema();
    await withChart(db);
    const client = await db.pool.connect();
    try {
      await client.query("UPDATE accounts SET is_active = false WHERE code = '5700'");
    } finally {
      client.release();
    }
    await expect(
      postEntry(
        db.pool,
        capitalDraft({
          lines: [
            { accountCode: "5700", debitPaise: 100, creditPaise: 0 },
            { accountCode: "1110", debitPaise: 0, creditPaise: 100 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(AccountNotPostable);
    await expectGenesis(db);
  });

  it("refuses a cash credit that would go negative and keeps the opening entry", async () => {
    db = await createTestSchema();
    await withChart(db);
    await postEntry(db.pool, capitalDraft({ lines: cashCapital(10000) }));
    const error = await postEntry(
      db.pool,
      capitalDraft({
        narration: "Overspend",
        lines: [
          { accountCode: "5700", debitPaise: 10001, creditPaise: 0 },
          { accountCode: "1110", debitPaise: 0, creditPaise: 10001 },
        ],
      }),
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(Overdraft);
    expect(error.details).toEqual({
      account_code: "1110",
      balance_paise: 10000,
      attempted_delta_paise: -10001,
    });
    const client = await db.pool.connect();
    try {
      const count = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(count.rows[0].n).toBe(1);
      const meta = await client.query("SELECT last_sequence FROM ledger_meta WHERE id = 1");
      expect(meta.rows[0].last_sequence).toBe(1);
    } finally {
      client.release();
    }
  });

  it("allows cash to be spent down to zero", async () => {
    db = await createTestSchema();
    await withChart(db);
    await postEntry(db.pool, capitalDraft({ lines: cashCapital(10000) }));
    await postEntry(
      db.pool,
      capitalDraft({
        narration: "Spend the till",
        lines: [
          { accountCode: "5700", debitPaise: 10000, creditPaise: 0 },
          { accountCode: "1110", debitPaise: 0, creditPaise: 10000 },
        ],
      }),
    );
    const client = await db.pool.connect();
    try {
      const cash = await client.query("SELECT id FROM accounts WHERE code = '1110'");
      expect(await balancePaise(client, cash.rows[0].id)).toBe(0);
    } finally {
      client.release();
    }
  });

  it("rejects a boolean amount before inserting", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(
      postEntry(
        db.pool,
        capitalDraft({
          lines: [
            { accountCode: "1110", debitPaise: true, creditPaise: 0 },
            { accountCode: "3100", debitPaise: 0, creditPaise: 100 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidEntry);
    await expectGenesis(db);
  });

  it("rolls back when the sum assertion fails after the insert", async () => {
    db = await createTestSchema();
    await withChart(db);
    vi.spyOn(postingInternals, "assertEntryInvariant").mockRejectedValue(new Error("forced"));
    await expect(postEntry(db.pool, capitalDraft())).rejects.toThrow(/forced/);
    await expectGenesis(db);
  });

  it("assigns contiguous sequences and distinct hashes", async () => {
    db = await createTestSchema();
    await withChart(db);
    const first = await postEntry(db.pool, capitalDraft({ narration: "First" }));
    const second = await postEntry(db.pool, capitalDraft({ narration: "Second" }));
    expect(first.sequenceNo).toBe(1);
    expect(second.sequenceNo).toBe(2);
    expect(second.prevHash).toBe(first.entryHash);
    expect(second.entryHash).not.toBe(first.entryHash);
    expect(second.entryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("posts when the idempotency key is omitted", async () => {
    db = await createTestSchema();
    await withChart(db);
    const entry = await postEntry(db.pool, capitalDraft({ idempotencyKey: null, requestHash: null }));
    expect(entry.sequenceNo).toBe(1);
  });

  it("lets a reversal-shaped post pass the overdraft guard when asked", async () => {
    db = await createTestSchema();
    await withChart(db);
    await postEntry(db.pool, capitalDraft({ lines: cashCapital(10000) }));
    const entry = await postEntry(
      db.pool,
      capitalDraft({
        narration: "Reverse a deposit after the cash was spent",
        skipOverdraft: true,
        lines: [
          { accountCode: "3100", debitPaise: 10001, creditPaise: 0 },
          { accountCode: "1110", debitPaise: 0, creditPaise: 10001 },
        ],
      }),
    );
    expect(entry.sequenceNo).toBe(2);
    const client = await db.pool.connect();
    try {
      const cash = await client.query("SELECT id FROM accounts WHERE code = '1110'");
      expect(await balancePaise(client, cash.rows[0].id)).toBe(-1);
    } finally {
      client.release();
    }
  });

  it("rejects an impossible entry date", async () => {
    db = await createTestSchema();
    await withChart(db);
    await expect(postEntry(db.pool, capitalDraft({ entryDate: "2026-04-31" }))).rejects.toBeInstanceOf(InvalidEntry);
    await expectGenesis(db);
  });

  it("raises InvariantViolation when inserted lines do not match the header", async () => {
    db = await createTestSchema();
    await withChart(db);
    const client = await db.pool.connect();
    try {
      const accounts = await client.query("SELECT id, code FROM accounts WHERE code IN ('1110', '3100')");
      const byCode = new Map(accounts.rows.map((row) => [row.code, row.id]));
      await client.query("BEGIN");
      const header = await client.query(
        `INSERT INTO journal_entries (
           sequence_no, entry_date, narration, debit_total_paise, credit_total_paise,
           created_by, created_at, prev_hash, entry_hash
         ) VALUES (1, '2026-04-02', 'Broken', 100, 100, 'tester', '2026-04-02T00:00:00Z', $1, $2)
         RETURNING id`,
        ["0".repeat(64), "c".repeat(64)],
      );
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, line_no, debit_paise, credit_paise)
         VALUES ($1, $2, 1, 40, 0), ($1, $3, 2, 0, 40)`,
        [header.rows[0].id, byCode.get("1110"), byCode.get("3100")],
      );
      await expect(postingInternals.assertEntryInvariant(client, header.rows[0].id)).rejects.toBeInstanceOf(
        InvariantViolation,
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("still refuses a raw update of a posted narration", async () => {
    db = await createTestSchema();
    await withChart(db);
    const entry = await postEntry(db.pool, capitalDraft({ narration: "Keep me" }));
    const client = await db.pool.connect();
    try {
      await expect(
        client.query("UPDATE journal_entries SET narration = 'Changed' WHERE id = $1", [entry.id]),
      ).rejects.toThrow(/append-only: journal_entries cannot be updated/);
      await client.query("ROLLBACK");
      const row = await client.query("SELECT narration FROM journal_entries WHERE id = $1", [entry.id]);
      expect(row.rows[0].narration).toBe("Keep me");
    } finally {
      client.release();
    }
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

function cashCapital(paise) {
  return [
    { accountCode: "1110", debitPaise: paise, creditPaise: 0 },
    { accountCode: "3100", debitPaise: 0, creditPaise: paise },
  ];
}

function capitalDraft(overrides = {}) {
  return {
    entryDate: "2026-04-02",
    narration: "Owner capital",
    reference: null,
    createdBy: "tester",
    lines: cashCapital(10000),
    idempotencyKey: null,
    ...overrides,
  };
}

async function expectGenesis(db) {
  const client = await db.pool.connect();
  try {
    const entries = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
    expect(entries.rows[0].n).toBe(0);
    const lines = await client.query("SELECT count(*)::bigint AS n FROM journal_lines");
    expect(lines.rows[0].n).toBe(0);
    const meta = await client.query("SELECT last_sequence, last_hash FROM ledger_meta WHERE id = 1");
    expect(meta.rows[0].last_sequence).toBe(0);
    expect(String(meta.rows[0].last_hash).trim()).toBe("0".repeat(64));
  } finally {
    client.release();
  }
}

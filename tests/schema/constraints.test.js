import { afterEach, describe, expect, it } from "vitest";
import { CHART, seedChart } from "../../src/seed/chart.js";
import { createTestSchema } from "../helpers/db.js";

const ZERO = "0".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("schema constraints", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("rejects an account type outside the chart", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO accounts (code, name, type, is_group, is_active, prevent_overdraft, created_at)
           VALUES ('9999', 'Petty', 'cash', false, true, false, '2026-04-01T00:00:00Z')`,
        ),
      ).rejects.toThrow(/accounts_type_chk/);
    } finally {
      client.release();
    }
  });

  it("rejects a journal header whose debit and credit totals differ", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await expect(insertHeader(client, { debit: 100, credit: 90, hash: HASH_A })).rejects.toThrow(
        /journal_entries_balanced_chk/,
      );
    } finally {
      client.release();
    }
  });

  it("rejects a line with both sides positive", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      const cash = await insertLeaf(client, "1110");
      const capital = await insertLeaf(client, "3100");
      const entryId = await insertBalancedEntry(client, cash, capital);
      await expect(
        client.query(
          `INSERT INTO journal_lines (entry_id, account_id, line_no, debit_paise, credit_paise)
           VALUES ($1, $2, 3, 10, 10)`,
          [entryId, cash],
        ),
      ).rejects.toThrow(/journal_lines_side_chk/);
    } finally {
      client.release();
    }
  });

  it("rejects a line posted to a group account", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      const group = await insertAccount(client, { code: "1000", isGroup: true, active: true });
      await client.query("BEGIN");
      const entryId = await insertHeader(client, { debit: 100, credit: 100, hash: HASH_A });
      await expect(
        client.query(
          `INSERT INTO journal_lines (entry_id, account_id, line_no, debit_paise, credit_paise)
           VALUES ($1, $2, 1, 100, 0)`,
          [entryId, group],
        ),
      ).rejects.toThrow(/account is not postable/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rejects a line posted to an inactive account", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      const inactive = await insertAccount(client, { code: "1110", isGroup: false, active: false });
      await client.query("BEGIN");
      const entryId = await insertHeader(client, { debit: 100, credit: 100, hash: HASH_A });
      await expect(
        client.query(
          `INSERT INTO journal_lines (entry_id, account_id, line_no, debit_paise, credit_paise)
           VALUES ($1, $2, 1, 100, 0)`,
          [entryId, inactive],
        ),
      ).rejects.toThrow(/account is not postable/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rejects update and delete of a posted entry and leaves the narration in place", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      const cash = await insertLeaf(client, "1110");
      const capital = await insertLeaf(client, "3100");
      const entryId = await insertBalancedEntry(client, cash, capital);

      await expect(
        client.query("UPDATE journal_entries SET narration = 'Changed' WHERE id = $1", [entryId]),
      ).rejects.toThrow(/append-only: journal_entries cannot be updated/);
      await client.query("ROLLBACK");

      const narration = await client.query("SELECT narration FROM journal_entries WHERE id = $1", [entryId]);
      expect(narration.rows[0].narration).toBe("Opening");

      await expect(client.query("DELETE FROM journal_entries WHERE id = $1", [entryId])).rejects.toThrow(
        /append-only: journal_entries cannot be deleted/,
      );
      await client.query("ROLLBACK");
      const still = await client.query("SELECT narration FROM journal_entries WHERE id = $1", [entryId]);
      expect(still.rows[0].narration).toBe("Opening");
    } finally {
      client.release();
    }
  });

  it("rejects a line whose account does not exist", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const entryId = await insertHeader(client, { debit: 100, credit: 100, hash: HASH_A });
      await expect(
        client.query(
          `INSERT INTO journal_lines (entry_id, account_id, line_no, debit_paise, credit_paise)
           VALUES ($1, 999999, 1, 100, 0)`,
          [entryId],
        ),
      ).rejects.toThrow(/foreign key|violates/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rejects a commit when the header has no matching lines", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await insertHeader(client, { debit: 100, credit: 100, hash: HASH_A });
      await expect(client.query("COMMIT")).rejects.toThrow(/incomplete/);
      await client.query("ROLLBACK");
      const count = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(count.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it("rejects a commit when line sums do not equal the header", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      const cash = await insertLeaf(client, "1110");
      const capital = await insertLeaf(client, "3100");
      await client.query("BEGIN");
      const entryId = await insertHeader(client, { debit: 100, credit: 100, hash: HASH_A });
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, line_no, debit_paise, credit_paise)
         VALUES ($1, $2, 1, 40, 0), ($1, $3, 2, 0, 40)`,
        [entryId, cash, capital],
      );
      await expect(client.query("COMMIT")).rejects.toThrow(/incomplete/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("rejects line sums that exceed the header before commit", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      const cash = await insertLeaf(client, "1110");
      const capital = await insertLeaf(client, "3100");
      const other = await insertLeaf(client, "1120");
      const entryId = await insertBalancedEntry(client, cash, capital);
      await expect(
        client.query(
          `INSERT INTO journal_lines (entry_id, account_id, line_no, debit_paise, credit_paise)
           VALUES ($1, $2, 3, 1, 0)`,
          [entryId, other],
        ),
      ).rejects.toThrow(/line sums exceed entry header/);
    } finally {
      client.release();
    }
  });

  it("keeps one row per code when the chart is seeded twice", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await seedChart(client);
      await seedChart(client);
      const count = await client.query("SELECT count(*)::bigint AS n, count(DISTINCT code)::bigint AS codes FROM accounts");
      expect(count.rows[0].n).toBe(CHART.length);
      expect(count.rows[0].codes).toBe(CHART.length);
      const locks = await client.query(
        "SELECT code FROM accounts WHERE prevent_overdraft = true ORDER BY code",
      );
      expect(locks.rows.map((row) => row.code)).toEqual(["1110", "1120"]);
    } finally {
      client.release();
    }
  });
});

async function insertAccount(client, { code, isGroup, active }) {
  const result = await client.query(
    `INSERT INTO accounts (code, name, type, is_group, is_active, prevent_overdraft, created_at)
     VALUES ($1, $2, 'asset', $3, $4, false, '2026-04-01T00:00:00Z')
     RETURNING id`,
    [code, code, isGroup, active],
  );
  return result.rows[0].id;
}

async function insertLeaf(client, code) {
  return insertAccount(client, { code, isGroup: false, active: true });
}

async function insertHeader(client, { debit, credit, hash, sequence = 1 }) {
  const result = await client.query(
    `INSERT INTO journal_entries (
       sequence_no, entry_date, narration, debit_total_paise, credit_total_paise,
       created_by, created_at, prev_hash, entry_hash
     ) VALUES ($1, '2026-04-01', 'Opening', $2, $3, 'tester', '2026-04-01T00:00:00Z', $4, $5)
     RETURNING id`,
    [sequence, debit, credit, ZERO, hash],
  );
  return result.rows[0].id;
}

async function insertBalancedEntry(client, debitAccount, creditAccount) {
  await client.query("BEGIN");
  const entryId = await insertHeader(client, { debit: 100, credit: 100, hash: HASH_B });
  await client.query(
    `INSERT INTO journal_lines (entry_id, account_id, line_no, debit_paise, credit_paise)
     VALUES ($1, $2, 1, 100, 0), ($1, $3, 2, 0, 100)`,
    [entryId, debitAccount, creditAccount],
  );
  await client.query("COMMIT");
  return entryId;
}

import { afterEach, describe, expect, it } from "vitest";
import { createTestSchema } from "../helpers/db.js";

describe("migrations", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("upgrades a fresh schema and inserts the genesis ledger cursor", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      const meta = await client.query("SELECT id, last_sequence, last_hash FROM ledger_meta");
      expect(meta.rows).toEqual([{ id: 1, last_sequence: 0, last_hash: "0".repeat(64) }]);
      const tables = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      );
      const names = tables.rows.map((row) => row.table_name);
      expect(names).toEqual(
        expect.arrayContaining([
          "accounts",
          "ledger_meta",
          "journal_entries",
          "journal_lines",
          "idempotency_keys",
          "bank_statements",
          "bank_statement_lines",
          "reconciliation_events",
        ]),
      );
    } finally {
      client.release();
    }
  });

  it("downgrades and upgrades again", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await db.migrateDown(client);
      const gone = await client.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'journal_entries'`,
      );
      expect(gone.rowCount).toBe(0);
      const { migrate } = await import("../../src/db/migrate.js");
      await migrate(client);
      const meta = await client.query("SELECT last_sequence, last_hash FROM ledger_meta WHERE id = 1");
      expect(meta.rows[0].last_sequence).toBe(0);
      expect(meta.rows[0].last_hash).toBe("0".repeat(64));
    } finally {
      client.release();
    }
  });
});

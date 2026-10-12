import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool } from "../../src/db/pool.js";
import { migrate, migrateDown } from "../../src/db/migrate.js";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://paise:paise@localhost:5432/paise_ledger_test";

let databaseReady = false;

/**
 * Tests use a private schema inside `paise_ledger_test` because journal triggers
 * forbid DELETE. Dropping the schema removes the rows with the objects.
 */
export async function ensureTestDatabase() {
  if (databaseReady) return;
  const admin = new pg.Client({
    connectionString: "postgres://paise:paise@localhost:5432/postgres",
  });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'paise_ledger_test'");
    if (existing.rowCount === 0) {
      await admin.query("CREATE DATABASE paise_ledger_test OWNER paise");
    }
  } finally {
    await admin.end();
  }
  databaseReady = true;
}

/**
 * @param {{ max?: number }} [options]
 */
export async function createTestSchema(options = {}) {
  await ensureTestDatabase();
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const pool = createPool(connectionString, { max: options.max ?? 4, schema });
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }

  return {
    pool,
    schema,
    connectionString,
    migrateDown,
    async close() {
      await pool.end();
      const drop = new pg.Client({ connectionString });
      await drop.connect();
      try {
        await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await drop.end();
      }
    },
  };
}

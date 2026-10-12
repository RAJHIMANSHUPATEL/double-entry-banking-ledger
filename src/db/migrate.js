import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./pool.js";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/**
 * Apply ordered SQL migrations that have not been recorded in this schema.
 * @param {import('pg').PoolClient} client
 */
export async function migrate(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir))
    .filter((name) => /^\d+.+\.sql$/.test(name) && !name.endsWith(".down.sql"))
    .sort();
  for (const version of files) {
    const seen = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (seen.rowCount) continue;
    const sql = await readFile(path.join(migrationsDir, version), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Reverse applied migrations using the matching `.down.sql` file.
 * @param {import('pg').PoolClient} client
 */
export async function migrateDown(client) {
  const applied = await client.query("SELECT version FROM schema_migrations ORDER BY version DESC");
  await client.query("BEGIN");
  try {
    for (const row of applied.rows) {
      const downName = row.version.replace(/\.sql$/, ".down.sql");
      const sql = await readFile(path.join(migrationsDir, downName), "utf8");
      await client.query(sql);
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [row.version]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await migrate(client);
    console.log("migrations applied");
  } finally {
    client.release();
    await pool.end();
  }
}

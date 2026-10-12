import pg from "pg";
import { config } from "../config.js";

// int8 arrives as a string unless parsed. Paise fit in a safe integer; refuse anything larger.
pg.types.setTypeParser(20, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`bigint ${value} is outside the safe integer range`);
  }
  return parsed;
});

// Keep dates as YYYY-MM-DD so reports and hashes do not depend on the process timezone.
pg.types.setTypeParser(1082, (value) => value);

/**
 * @param {string} [connectionString]
 * @param {{ max?: number, schema?: string }} [options]
 */
export function createPool(connectionString = config.databaseUrl, options = {}) {
  const schema = options.schema;
  if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    onConnect: schema
      ? async (client) => {
          await client.query(`SET search_path TO ${schema}`);
        }
      : undefined,
  });
}

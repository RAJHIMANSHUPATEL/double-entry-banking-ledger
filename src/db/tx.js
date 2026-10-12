/**
 * Run `fn` inside a transaction on a checked-out client.
 * The callback owns commit semantics only through this helper: it returns a value
 * or throws, and a throw rolls the transaction back.
 * @template T
 * @param {import('pg').Pool | { connect: Function }} db
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may already be aborted.
    }
    throw error;
  } finally {
    client.release();
  }
}

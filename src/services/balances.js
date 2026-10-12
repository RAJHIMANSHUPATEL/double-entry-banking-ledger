/**
 * Asset-style balance: debits minus credits. Overdraft checks use this figure
 * while the ledger row lock is held, so the value cannot change before commit.
 * @param {import('pg').PoolClient} client
 * @param {number} accountId
 * @returns {Promise<number>}
 */
export async function balancePaise(client, accountId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(debit_paise - credit_paise), 0)::bigint AS balance
     FROM journal_lines
     WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0].balance;
}

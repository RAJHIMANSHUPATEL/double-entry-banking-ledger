/**
 * Five postable leaves with overdraft protection off.
 * The property test is about the accounting identity, not the cash guard.
 */
export const PROPERTY_ACCOUNTS = [
  { code: "1001", name: "Property Asset", type: "asset" },
  { code: "2001", name: "Property Liability", type: "liability" },
  { code: "3001", name: "Property Equity", type: "equity" },
  { code: "4001", name: "Property Income", type: "income" },
  { code: "5001", name: "Property Expense", type: "expense" },
];

/**
 * @param {import('pg').PoolClient} client
 */
export async function seedPropertyChart(client) {
  for (const account of PROPERTY_ACCOUNTS) {
    await client.query(
      `INSERT INTO accounts (code, name, type, parent_id, is_group, is_active, prevent_overdraft, created_at)
       VALUES ($1, $2, $3, NULL, false, true, false, '2026-04-01T00:00:00Z')`,
      [account.code, account.name, account.type],
    );
  }
}

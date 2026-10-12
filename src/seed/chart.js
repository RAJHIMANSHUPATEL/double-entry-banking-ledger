/** Fixed timestamp so chart snapshots do not drift between test runs. */
export const CHART_CREATED_AT = "2026-04-01T00:00:00Z";

/**
 * Anaya Studio chart. Group rows are structural. Only leaves accept journal lines.
 * `preventOverdraft` is set on cash and the bank account only.
 * Names, and the business they describe, are fictional.
 */
export const CHART = [
  { code: "1000", name: "Assets", type: "asset", parent: null, isGroup: true },
  { code: "1100", name: "Current Assets", type: "asset", parent: "1000", isGroup: true },
  { code: "1110", name: "Cash in Hand", type: "asset", parent: "1100", isGroup: false, preventOverdraft: true },
  { code: "1120", name: "Bank — HDFC Current Account", type: "asset", parent: "1100", isGroup: false, preventOverdraft: true },
  { code: "1130", name: "Accounts Receivable — Trade", type: "asset", parent: "1100", isGroup: false },
  { code: "1140", name: "Input CGST", type: "asset", parent: "1100", isGroup: false },
  { code: "1150", name: "Input SGST", type: "asset", parent: "1100", isGroup: false },
  { code: "1160", name: "Input IGST", type: "asset", parent: "1100", isGroup: false },
  { code: "1170", name: "TDS Receivable", type: "asset", parent: "1100", isGroup: false },
  { code: "1200", name: "Non-current Assets", type: "asset", parent: "1000", isGroup: true },
  { code: "1210", name: "Computer Equipment", type: "asset", parent: "1200", isGroup: false },
  { code: "1220", name: "Furniture and Fixtures", type: "asset", parent: "1200", isGroup: false },
  { code: "2000", name: "Liabilities", type: "liability", parent: null, isGroup: true },
  { code: "2100", name: "Accounts Payable — Trade", type: "liability", parent: "2000", isGroup: false },
  { code: "2210", name: "Output CGST", type: "liability", parent: "2000", isGroup: false },
  { code: "2220", name: "Output SGST", type: "liability", parent: "2000", isGroup: false },
  { code: "2230", name: "Output IGST", type: "liability", parent: "2000", isGroup: false },
  { code: "2300", name: "TDS Payable", type: "liability", parent: "2000", isGroup: false },
  { code: "2400", name: "Salary Payable", type: "liability", parent: "2000", isGroup: false },
  { code: "3000", name: "Equity", type: "equity", parent: null, isGroup: true },
  { code: "3100", name: "Owner's Capital", type: "equity", parent: "3000", isGroup: false },
  { code: "3200", name: "Owner's Drawings", type: "equity", parent: "3000", isGroup: false },
  { code: "4000", name: "Income", type: "income", parent: null, isGroup: true },
  { code: "4100", name: "Design Service Revenue", type: "income", parent: "4000", isGroup: false },
  { code: "4200", name: "Interest Income", type: "income", parent: "4000", isGroup: false },
  { code: "5000", name: "Expenses", type: "expense", parent: null, isGroup: true },
  { code: "5100", name: "Salaries and Wages", type: "expense", parent: "5000", isGroup: false },
  { code: "5200", name: "Rent", type: "expense", parent: "5000", isGroup: false },
  { code: "5300", name: "Software Subscriptions", type: "expense", parent: "5000", isGroup: false },
  { code: "5400", name: "Internet and Utilities", type: "expense", parent: "5000", isGroup: false },
  { code: "5500", name: "Contract Professional Fees", type: "expense", parent: "5000", isGroup: false },
  { code: "5600", name: "Bank Charges", type: "expense", parent: "5000", isGroup: false },
  { code: "5700", name: "Office Supplies", type: "expense", parent: "5000", isGroup: false },
];

/**
 * Insert the chart. A second call does not duplicate codes.
 * @param {import('pg').PoolClient} client
 */
export async function seedChart(client) {
  for (const account of CHART) {
    const parent = account.parent
      ? await client.query("SELECT id FROM accounts WHERE code = $1", [account.parent])
      : { rows: [] };
    if (account.parent && parent.rows.length === 0) {
      throw new Error(`Parent account ${account.parent} is missing for ${account.code}`);
    }
    await client.query(
      `INSERT INTO accounts (
         code, name, type, parent_id, is_group, is_active, prevent_overdraft, created_at
       ) VALUES ($1, $2, $3, $4, $5, true, $6, $7)
       ON CONFLICT (code) DO NOTHING`,
      [
        account.code,
        account.name,
        account.type,
        parent.rows[0]?.id ?? null,
        account.isGroup,
        account.preventOverdraft === true,
        CHART_CREATED_AT,
      ],
    );
  }
}

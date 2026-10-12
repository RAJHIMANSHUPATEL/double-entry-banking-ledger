/**
 * Trial-balance difference over leaves. A consistent book returns 0.
 * Full statement shaping is added with the report endpoints.
 * @param {import('pg').PoolClient} client
 * @param {string} [asOf]
 * @returns {Promise<number>}
 */
export async function trialBalanceDifference(client, asOf = "9999-12-31") {
  const result = await client.query(
    `SELECT a.type,
            COALESCE(SUM(l.debit_paise), 0)::bigint AS debits,
            COALESCE(SUM(l.credit_paise), 0)::bigint AS credits
     FROM accounts a
     JOIN journal_lines l ON l.account_id = a.id
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE a.is_group = false
       AND e.entry_date <= $1
     GROUP BY a.id, a.type`,
    [asOf],
  );
  let debitColumn = 0;
  let creditColumn = 0;
  for (const row of result.rows) {
    const debitNormal = row.type === "asset" || row.type === "expense";
    const net = debitNormal ? row.debits - row.credits : row.credits - row.debits;
    if (net > 0) {
      if (debitNormal) debitColumn += net;
      else creditColumn += net;
    } else if (net < 0) {
      if (debitNormal) creditColumn += -net;
      else debitColumn += -net;
    }
  }
  return debitColumn - creditColumn;
}

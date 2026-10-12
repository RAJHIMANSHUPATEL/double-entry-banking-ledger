import { money } from "../domain/money.js";
import { getAccount } from "./accounts.js";

/**
 * @param {string} type
 * @param {number} debits
 * @param {number} credits
 */
function naturalNet(type, debits, credits) {
  const debitNormal = type === "asset" || type === "expense";
  return debitNormal ? debits - credits : credits - debits;
}

/**
 * @param {number} net
 * @param {boolean} debitNormal
 */
function columnsForNet(net, debitNormal) {
  if (net > 0) {
    return debitNormal
      ? { debitPaise: net, creditPaise: 0 }
      : { debitPaise: 0, creditPaise: net };
  }
  if (net < 0) {
    const opposite = -net;
    return debitNormal
      ? { debitPaise: 0, creditPaise: opposite }
      : { debitPaise: opposite, creditPaise: 0 };
  }
  return { debitPaise: 0, creditPaise: 0 };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} asOf
 */
async function leafActivity(client, asOf, types, dateFrom) {
  const params = [asOf];
  let windowSql = "e.entry_date <= $1";
  if (dateFrom) {
    params.push(dateFrom);
    windowSql = "e.entry_date >= $2 AND e.entry_date <= $1";
  }
  params.push(types);
  const typeParam = `$${params.length}`;
  const result = await client.query(
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(l.debit_paise), 0)::bigint AS debits,
            COALESCE(SUM(l.credit_paise), 0)::bigint AS credits
     FROM accounts a
     JOIN journal_lines l ON l.account_id = a.id
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE a.is_group = false
       AND a.type = ANY(${typeParam}::text[])
       AND ${windowSql}
     GROUP BY a.id, a.code, a.name, a.type
     ORDER BY a.code`,
    params,
  );
  return result.rows.map((row) => ({
    code: row.code,
    name: row.name,
    type: row.type,
    debits: money(row.debits),
    credits: money(row.credits),
  }));
}

/**
 * Opening is activity strictly before `dateFrom`. Lines inside the window
 * update a running balance using the account's normal side.
 * @param {import('pg').PoolClient} client
 * @param {string} code
 * @param {string} dateFrom
 * @param {string} dateTo
 */
export async function accountStatement(client, code, dateFrom, dateTo) {
  const account = await getAccount(client, code);
  const openingRow = await client.query(
    `SELECT COALESCE(SUM(l.debit_paise), 0)::bigint AS debits,
            COALESCE(SUM(l.credit_paise), 0)::bigint AS credits
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE a.code = $1 AND e.entry_date < $2`,
    [code, dateFrom],
  );
  const debitNormal = account.type === "asset" || account.type === "expense";
  let running = naturalNet(account.type, money(openingRow.rows[0].debits), money(openingRow.rows[0].credits));
  const openingPaise = running;

  const linesResult = await client.query(
    `SELECT e.id AS entry_id, e.sequence_no, e.entry_date, e.narration,
            l.line_no, l.debit_paise, l.credit_paise, l.line_narration
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE a.code = $1
       AND e.entry_date >= $2
       AND e.entry_date <= $3
     ORDER BY e.entry_date, e.sequence_no, l.line_no`,
    [code, dateFrom, dateTo],
  );

  const lines = linesResult.rows.map((row) => {
    const debitPaise = money(row.debit_paise);
    const creditPaise = money(row.credit_paise);
    running += debitNormal ? debitPaise - creditPaise : creditPaise - debitPaise;
    return {
      entryId: row.entry_id,
      sequenceNo: row.sequence_no,
      entryDate: row.entry_date,
      narration: row.narration,
      lineNarration: row.line_narration,
      debitPaise,
      creditPaise,
      runningPaise: running,
    };
  });

  return {
    accountCode: account.code,
    accountName: account.name,
    accountType: account.type,
    dateFrom,
    dateTo,
    openingPaise,
    closingPaise: running,
    lines,
  };
}

/**
 * One row per leaf with activity on or before `asOf`, including a zero net.
 * @param {import('pg').PoolClient} client
 * @param {string} asOf
 */
export async function trialBalance(client, asOf) {
  const leaves = await leafActivity(client, asOf, ["asset", "liability", "equity", "income", "expense"]);
  let debitTotalPaise = 0;
  let creditTotalPaise = 0;
  const rows = leaves.map((leaf) => {
    const debitNormal = leaf.type === "asset" || leaf.type === "expense";
    const net = naturalNet(leaf.type, leaf.debits, leaf.credits);
    const columns = columnsForNet(net, debitNormal);
    debitTotalPaise += columns.debitPaise;
    creditTotalPaise += columns.creditPaise;
    return {
      code: leaf.code,
      name: leaf.name,
      type: leaf.type,
      debitPaise: columns.debitPaise,
      creditPaise: columns.creditPaise,
    };
  });
  return {
    asOf,
    rows,
    debitTotalPaise,
    creditTotalPaise,
    differencePaise: debitTotalPaise - creditTotalPaise,
  };
}

/**
 * Trial-balance difference over leaves. A consistent book returns 0.
 * @param {import('pg').PoolClient} client
 * @param {string} [asOf]
 * @returns {Promise<number>}
 */
export async function trialBalanceDifference(client, asOf = "9999-12-31") {
  const report = await trialBalance(client, asOf);
  return report.differencePaise;
}

/**
 * Income and expense movement inside the window. A debit to revenue reduces income.
 * @param {import('pg').PoolClient} client
 * @param {string} dateFrom
 * @param {string} dateTo
 */
export async function profitAndLoss(client, dateFrom, dateTo) {
  const leaves = await leafActivity(client, dateTo, ["income", "expense"], dateFrom);
  const income = [];
  const expenses = [];
  for (const leaf of leaves) {
    const amountPaise = naturalNet(leaf.type, leaf.debits, leaf.credits);
    const row = { code: leaf.code, name: leaf.name, amountPaise };
    if (leaf.type === "income") income.push(row);
    else expenses.push(row);
  }
  const incomeTotalPaise = income.reduce((sum, row) => sum + row.amountPaise, 0);
  const expenseTotalPaise = expenses.reduce((sum, row) => sum + row.amountPaise, 0);
  return {
    dateFrom,
    dateTo,
    income,
    expenses,
    incomeTotalPaise,
    expenseTotalPaise,
    profitPaise: incomeTotalPaise - expenseTotalPaise,
  };
}

/**
 * Position at `asOf`. Current earnings is income minus expense to that date
 * and is not a posted account.
 * @param {import('pg').PoolClient} client
 * @param {string} asOf
 */
export async function balanceSheet(client, asOf) {
  const leaves = await leafActivity(client, asOf, ["asset", "liability", "equity", "income", "expense"]);
  const assets = [];
  const liabilities = [];
  const equity = [];
  let earnings = 0;
  for (const leaf of leaves) {
    const amountPaise = naturalNet(leaf.type, leaf.debits, leaf.credits);
    if (leaf.type === "income" || leaf.type === "expense") {
      earnings += leaf.type === "income" ? amountPaise : -amountPaise;
      continue;
    }
    const row = { code: leaf.code, name: leaf.name, amountPaise, computed: false };
    if (leaf.type === "asset") assets.push(row);
    else if (leaf.type === "liability") liabilities.push(row);
    else equity.push(row);
  }
  equity.push({
    code: null,
    name: "Current earnings",
    amountPaise: earnings,
    computed: true,
  });
  const assetsPaise = assets.reduce((sum, row) => sum + row.amountPaise, 0);
  const liabilitiesPaise = liabilities.reduce((sum, row) => sum + row.amountPaise, 0);
  const equityIncludingEarningsPaise = equity.reduce((sum, row) => sum + row.amountPaise, 0);
  return {
    asOf,
    assets,
    liabilities,
    equity,
    balances: {
      assetsPaise,
      liabilitiesPaise,
      equityIncludingEarningsPaise,
      differencePaise: assetsPaise - liabilitiesPaise - equityIncludingEarningsPaise,
    },
  };
}

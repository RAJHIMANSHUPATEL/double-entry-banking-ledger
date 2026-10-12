import ExcelJS from "exceljs";
import { formatInr } from "../domain/money.js";

/**
 * Excel renders figures the service already computed.
 * Display cells are Indian-grouped text from formatInr. Paise cells are integers.
 * @param {string} title
 * @param {string[]} period
 * @param {string[]} headers
 * @param {unknown[][]} rows
 */
async function workbook(title, period, headers, rows) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(title.slice(0, 31));
  sheet.addRow([title]);
  sheet.addRow(period);
  sheet.addRow([]);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  const bytes = await book.xlsx.writeBuffer();
  return Buffer.from(bytes);
}

/**
 * @param {{ asOf: string, rows: Array<{ code: string, name: string, debitPaise: number, creditPaise: number }>, debitTotalPaise: number, creditTotalPaise: number, differencePaise: number }} report
 */
export function trialBalanceWorkbook(report) {
  const rows = report.rows.map((row) => [
    row.code,
    row.name,
    formatInr(row.debitPaise),
    row.debitPaise,
    formatInr(row.creditPaise),
    row.creditPaise,
  ]);
  rows.push([
    "",
    "Total",
    formatInr(report.debitTotalPaise),
    report.debitTotalPaise,
    formatInr(report.creditTotalPaise),
    report.creditTotalPaise,
  ]);
  rows.push(["", "Difference", formatInr(report.differencePaise), report.differencePaise, "", ""]);
  return workbook(
    "Trial balance",
    ["As of", report.asOf],
    ["Code", "Name", "Debit", "Debit paise", "Credit", "Credit paise"],
    rows,
  );
}

/**
 * @param {{ dateFrom: string, dateTo: string, income: Array<{ code: string, name: string, amountPaise: number }>, expenses: Array<{ code: string, name: string, amountPaise: number }>, incomeTotalPaise: number, expenseTotalPaise: number, profitPaise: number }} report
 */
export function profitAndLossWorkbook(report) {
  const rows = [];
  for (const row of report.income) {
    rows.push(["Income", row.code, row.name, formatInr(row.amountPaise), row.amountPaise]);
  }
  rows.push(["Income total", "", "", formatInr(report.incomeTotalPaise), report.incomeTotalPaise]);
  for (const row of report.expenses) {
    rows.push(["Expense", row.code, row.name, formatInr(row.amountPaise), row.amountPaise]);
  }
  rows.push(["Expense total", "", "", formatInr(report.expenseTotalPaise), report.expenseTotalPaise]);
  rows.push(["Profit", "", "", formatInr(report.profitPaise), report.profitPaise]);
  return workbook(
    "Profit and loss",
    ["From", report.dateFrom, "To", report.dateTo],
    ["Section", "Code", "Name", "Amount", "Amount paise"],
    rows,
  );
}

/**
 * @param {{ asOf: string, assets: Array<{ code: string | null, name: string, amountPaise: number }>, liabilities: Array<{ code: string | null, name: string, amountPaise: number }>, equity: Array<{ code: string | null, name: string, amountPaise: number }>, balances: { assetsPaise: number, liabilitiesPaise: number, equityIncludingEarningsPaise: number, differencePaise: number } }} report
 */
export function balanceSheetWorkbook(report) {
  const rows = [];
  const pushSection = (label, section) => {
    for (const row of section) {
      rows.push([label, row.code ?? "", row.name, formatInr(row.amountPaise), row.amountPaise]);
    }
  };
  pushSection("Asset", report.assets);
  rows.push(["Assets total", "", "", formatInr(report.balances.assetsPaise), report.balances.assetsPaise]);
  pushSection("Liability", report.liabilities);
  rows.push(["Liabilities total", "", "", formatInr(report.balances.liabilitiesPaise), report.balances.liabilitiesPaise]);
  pushSection("Equity", report.equity);
  rows.push([
    "Equity including earnings",
    "",
    "",
    formatInr(report.balances.equityIncludingEarningsPaise),
    report.balances.equityIncludingEarningsPaise,
  ]);
  rows.push(["Difference", "", "", formatInr(report.balances.differencePaise), report.balances.differencePaise]);
  return workbook(
    "Balance sheet",
    ["As of", report.asOf],
    ["Section", "Code", "Name", "Amount", "Amount paise"],
    rows,
  );
}

/**
 * @param {{ accountCode: string, accountName: string, dateFrom: string, dateTo: string, openingPaise: number, closingPaise: number, lines: Array<{ entryDate: string, narration: string, debitPaise: number, creditPaise: number, runningPaise: number }> }} report
 */
export function statementWorkbook(report) {
  const rows = [["", "Opening", "", formatInr(0), 0, formatInr(0), 0, formatInr(report.openingPaise), report.openingPaise]];
  for (const line of report.lines) {
    rows.push([
      line.entryDate,
      line.narration,
      "",
      formatInr(line.debitPaise),
      line.debitPaise,
      formatInr(line.creditPaise),
      line.creditPaise,
      formatInr(line.runningPaise),
      line.runningPaise,
    ]);
  }
  rows.push(["", "Closing", "", formatInr(0), 0, formatInr(0), 0, formatInr(report.closingPaise), report.closingPaise]);
  return workbook(
    "Account statement",
    ["Account", report.accountCode, report.accountName, "From", report.dateFrom, "To", report.dateTo],
    ["Date", "Narration", "Reference", "Debit", "Debit paise", "Credit", "Credit paise", "Balance", "Balance paise"],
    rows,
  );
}

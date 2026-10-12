import { parse } from "csv-parse/sync";
import { parseRupees } from "../domain/money.js";

const REQUIRED = ["date", "narration", "withdrawal", "deposit", "balance"];
const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Day-first dates used on Indian bank exports, plus ISO.
 * Two-digit years are read as 20xx, which covers the studio's books.
 * @param {string} cell
 * @returns {string | null}
 */
export function parseBankDate(cell) {
  const text = cell.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash) return calendarDate(Number(slash[3]), Number(slash[2]), Number(slash[1]));
  const dashed = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(text);
  if (dashed) return calendarDate(Number(dashed[3]), Number(dashed[2]), Number(dashed[1]));
  const monthName = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (monthName) {
    const month = MONTHS[monthName[2].toLowerCase()];
    if (!month) return null;
    return calendarDate(Number(monthName[3]), month, Number(monthName[1]));
  }
  const shortYear = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/.exec(text);
  if (shortYear) return calendarDate(2000 + Number(shortYear[3]), Number(shortYear[2]), Number(shortYear[1]));
  return null;
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 */
function calendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (stamp.getUTCFullYear() !== year || stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * @param {string} cell
 */
function blank(cell) {
  return cell == null || String(cell).trim() === "";
}

/**
 * Parse a bank CSV. A bad data row is reported and skipped.
 * A missing header is a file-level error and yields no rows.
 * @param {Buffer | string} data
 */
export function parseBankCsv(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (text.trim() === "") {
    return { rows: [], errors: [{ row: 1, message: "Header must include date, narration, withdrawal, deposit, and balance." }] };
  }

  /** @type {Array<{ record: Record<string, string>, info: { lines: number } }>} */
  let records;
  try {
    records = parse(text, {
      bom: true,
      columns: (header) => header.map((name) => String(name).trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      info: true,
      relax_column_count: true,
    });
  } catch {
    return { rows: [], errors: [{ row: 1, message: "CSV could not be parsed." }] };
  }

  const header = records[0]?.info?.columns?.map((column) => column.name) ?? headerFromText(text);
  if (!REQUIRED.every((name) => header.includes(name))) {
    return {
      rows: [],
      errors: [{ row: 1, message: "Header must include date, narration, withdrawal, deposit, and balance." }],
    };
  }

  const rows = [];
  const errors = [];
  for (const entry of records) {
    const record = entry.record;
    const rowNumber = entry.info.lines;
    const parsed = parseRecord(record, rowNumber);
    if (parsed.ok) rows.push(parsed.row);
    else errors.push({ row: rowNumber, message: parsed.message });
  }
  return { rows, errors };
}

/**
 * csv-parse omits the header when the file has no data rows.
 * @param {string} text
 */
function headerFromText(text) {
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/).find((value) => value.trim() !== "");
  if (!line) return [];
  return line.split(",").map((name) => name.trim().toLowerCase());
}

/**
 * @param {Record<string, string>} record
 * @param {number} rowNumber
 */
function parseRecord(record, rowNumber) {
  const txnDate = parseBankDate(record.date ?? "");
  if (!txnDate) return { ok: false, message: "Date is not a valid day-first date." };

  const withdrawal = !blank(record.withdrawal);
  const deposit = !blank(record.deposit);
  if (withdrawal && deposit) return { ok: false, message: "Provide a withdrawal or a deposit, not both." };
  if (!withdrawal && !deposit) return { ok: false, message: "Provide a withdrawal or a deposit." };

  let magnitude;
  try {
    magnitude = Math.abs(parseRupees(withdrawal ? record.withdrawal : record.deposit));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Amount could not be parsed." };
  }
  if (magnitude === 0) return { ok: false, message: "Amount must not be zero." };

  let bankBalancePaise = null;
  if (!blank(record.balance)) {
    try {
      bankBalancePaise = parseRupees(record.balance);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Balance could not be parsed." };
    }
  }

  return {
    ok: true,
    row: {
      rowNumber,
      txnDate,
      narration: record.narration ?? "",
      amountPaise: withdrawal ? -magnitude : magnitude,
      bankBalancePaise,
      raw: {
        date: record.date ?? "",
        narration: record.narration ?? "",
        withdrawal: record.withdrawal ?? "",
        deposit: record.deposit ?? "",
        balance: record.balance ?? "",
      },
    },
  };
}

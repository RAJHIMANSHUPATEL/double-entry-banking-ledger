/**
 * Process configuration. Money thresholds are integers; they are not paise amounts.
 */
export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://paise:paise@localhost:5432/paise_ledger",
  logLevel: process.env.LOG_LEVEL ?? "info",
  port: readInt(process.env.PORT, 3000),
  host: process.env.HOST ?? "0.0.0.0",
  fuzzySuggestThreshold: readInt(process.env.FUZZY_SUGGEST_THRESHOLD, 70),
  fuzzyAutoThreshold: readInt(process.env.FUZZY_AUTO_THRESHOLD, 95),
  dateWindowDays: readInt(process.env.DATE_WINDOW_DAYS, 3),
};

function readInt(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected an integer setting, received ${value}`);
  }
  return parsed;
}

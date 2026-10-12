import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { trialBalanceWorkbook } from "../../src/reports/excel.js";
import { trialBalance } from "../../src/services/reporting.js";
import { createTestSchema } from "../helpers/db.js";
import { postWorkedExample } from "./fixture.js";

/**
 * @param {Buffer} bytes
 */
async function cellValues(bytes) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const values = [];
  book.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        values.push(cell.value);
      });
    });
  });
  return values;
}

describe("excel export", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    await db?.close();
  });

  it("writes Indian display text and integer paise for the trial balance", async () => {
    db = await createTestSchema();
    await postWorkedExample(db.pool);
    const client = await db.pool.connect();
    try {
      const report = await trialBalance(client, "2026-04-30");
      const bytes = await trialBalanceWorkbook(report);
      expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
      const values = await cellValues(bytes);
      expect(values).toContain("₹618.00");
      expect(values).toContain(61800);
    } finally {
      client.release();
    }
  });
});

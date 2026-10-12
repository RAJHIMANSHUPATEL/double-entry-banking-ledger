import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { actorHeaders, createTestApp } from "../helpers/api.js";

describe("report API", () => {
  /** @type {Awaited<ReturnType<typeof createTestApp>> | undefined} */
  let ctx;

  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  async function postWorked() {
    ctx = await createTestApp();
    const entries = [
      {
        entry_date: "2026-04-01",
        narration: "Capital introduced",
        lines: [
          { account_code: "1120", debit_paise: 50000, credit_paise: 0 },
          { account_code: "3100", debit_paise: 0, credit_paise: 50000 },
        ],
      },
      {
        entry_date: "2026-04-02",
        narration: "Invoice receipt, paid immediately",
        lines: [
          { account_code: "1120", debit_paise: 11800, credit_paise: 0 },
          { account_code: "4100", debit_paise: 0, credit_paise: 10000 },
          { account_code: "2210", debit_paise: 0, credit_paise: 900 },
          { account_code: "2220", debit_paise: 0, credit_paise: 900 },
        ],
      },
      {
        entry_date: "2026-04-03",
        narration: "Rent",
        lines: [
          { account_code: "5200", debit_paise: 5000, credit_paise: 0 },
          { account_code: "1120", debit_paise: 0, credit_paise: 5000 },
        ],
      },
    ];
    for (const body of entries) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/entries",
        headers: actorHeaders(),
        payload: body,
      });
      expect(response.statusCode).toBe(201);
    }
  }

  it("returns the worked example as JSON and as an xlsx workbook", async () => {
    await postWorked();
    const tb = await ctx.app.inject({
      method: "GET",
      url: "/reports/trial-balance?as_of=2026-04-30",
    });
    expect(tb.statusCode).toBe(200);
    const trial = tb.json();
    expect(trial.debit_total_paise).toBe(61800);
    expect(trial.credit_total_paise).toBe(61800);
    expect(trial.difference_paise).toBe(0);
    expect(trial.debit_total_display).toBe("₹618.00");

    const pl = await ctx.app.inject({
      method: "GET",
      url: "/reports/profit-and-loss?from=2026-04-01&to=2026-04-30",
    });
    expect(pl.json()).toMatchObject({
      income_total_paise: 10000,
      expense_total_paise: 5000,
      profit_paise: 5000,
    });

    const bs = await ctx.app.inject({
      method: "GET",
      url: "/reports/balance-sheet?as_of=2026-04-30",
    });
    expect(bs.json().balances).toMatchObject({
      assets_paise: 56800,
      liabilities_paise: 1800,
      equity_including_earnings_paise: 55000,
      difference_paise: 0,
    });

    const statement = await ctx.app.inject({
      method: "GET",
      url: "/accounts/1120/statement?from=2026-04-03&to=2026-04-03",
    });
    expect(statement.json()).toMatchObject({
      opening_paise: 61800,
      closing_paise: 56800,
    });
    expect(statement.json().lines).toHaveLength(1);
    expect(statement.json().lines[0].credit_paise).toBe(5000);

    const xlsx = await ctx.app.inject({
      method: "GET",
      url: "/reports/trial-balance?as_of=2026-04-30&format=xlsx",
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(xlsx.headers["content-disposition"]).toContain("trial-balance-2026-04-30.xlsx");
    const raw = xlsx.rawPayload;
    expect(raw.subarray(0, 2).toString("utf8")).toBe("PK");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(raw);
    const values = [];
    book.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell({ includeEmpty: false }, (cell) => values.push(cell.value));
      });
    });
    expect(values).toContain("₹618.00");
    expect(values).toContain(61800);
  });

  it("serves the other workbooks and rejects a bad window", async () => {
    await postWorked();
    for (const url of [
      "/reports/profit-and-loss?from=2026-04-01&to=2026-04-30&format=xlsx",
      "/reports/balance-sheet?as_of=2026-04-30&format=xlsx",
      "/accounts/1120/statement?from=2026-04-01&to=2026-04-30&format=xlsx",
    ]) {
      const response = await ctx.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.subarray(0, 2).toString("utf8")).toBe("PK");
    }

    const missing = await ctx.app.inject({
      method: "GET",
      url: "/accounts/9999/statement?from=2026-04-01&to=2026-04-30",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("ACCOUNT_NOT_FOUND");

    const backwards = await ctx.app.inject({
      method: "GET",
      url: "/reports/profit-and-loss?from=2026-05-01&to=2026-04-01",
    });
    expect(backwards.statusCode).toBe(422);
    expect(backwards.json().error.code).toBe("VALIDATION_ERROR");
  });
});

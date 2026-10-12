import { afterEach, describe, expect, it } from "vitest";
import { postEntry } from "../../src/services/posting.js";
import { AccountNotFound } from "../../src/services/exceptions.js";
import {
  accountStatement,
  balanceSheet,
  profitAndLoss,
  trialBalance,
} from "../../src/services/reporting.js";
import { createTestSchema } from "../helpers/db.js";
import { postWorkedExample, reverseRent } from "./fixture.js";

describe("reports", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  async function books() {
    db = await createTestSchema();
    const rent = await postWorkedExample(db.pool);
    const client = await db.pool.connect();
    return { rent, client };
  }

  it("pins the worked example trial balance, profit and loss, and balance sheet", async () => {
    const { client } = await books();
    try {
      const tb = await trialBalance(client, "2026-04-30");
      const byCode = Object.fromEntries(tb.rows.map((row) => [row.code, row]));
      expect(byCode["1120"]).toMatchObject({ debitPaise: 56800, creditPaise: 0 });
      expect(byCode["3100"]).toMatchObject({ debitPaise: 0, creditPaise: 50000 });
      expect(byCode["4100"]).toMatchObject({ debitPaise: 0, creditPaise: 10000 });
      expect(byCode["2210"]).toMatchObject({ debitPaise: 0, creditPaise: 900 });
      expect(byCode["2220"]).toMatchObject({ debitPaise: 0, creditPaise: 900 });
      expect(byCode["5200"]).toMatchObject({ debitPaise: 5000, creditPaise: 0 });
      expect(tb.rows.some((row) => row.code === "1000")).toBe(false);
      expect(tb.debitTotalPaise).toBe(61800);
      expect(tb.creditTotalPaise).toBe(61800);
      expect(tb.differencePaise).toBe(0);

      const pl = await profitAndLoss(client, "2026-04-01", "2026-04-30");
      expect(pl.incomeTotalPaise).toBe(10000);
      expect(pl.expenseTotalPaise).toBe(5000);
      expect(pl.profitPaise).toBe(5000);

      const bs = await balanceSheet(client, "2026-04-30");
      expect(bs.balances.assetsPaise).toBe(56800);
      expect(bs.balances.liabilitiesPaise).toBe(1800);
      expect(bs.balances.equityIncludingEarningsPaise).toBe(55000);
      expect(bs.balances.differencePaise).toBe(0);
      const earnings = bs.equity.find((row) => row.name === "Current earnings");
      expect(earnings).toMatchObject({ code: null, amountPaise: 5000, computed: true });
      expect(bs.equity.find((row) => row.code === "3100")?.amountPaise).toBe(50000);
    } finally {
      client.release();
    }
  });

  it("states the bank on the rent date and an empty window before the books open", async () => {
    const { client } = await books();
    try {
      const rentDay = await accountStatement(client, "1120", "2026-04-03", "2026-04-03");
      expect(rentDay.openingPaise).toBe(61800);
      expect(rentDay.lines).toHaveLength(1);
      expect(rentDay.lines[0].creditPaise).toBe(5000);
      expect(rentDay.lines[0].debitPaise).toBe(0);
      expect(rentDay.closingPaise).toBe(56800);

      const before = await accountStatement(client, "1120", "2026-03-01", "2026-03-31");
      expect(before.openingPaise).toBe(0);
      expect(before.lines).toEqual([]);
      expect(before.closingPaise).toBe(0);

      const capital = await accountStatement(client, "3100", "2026-04-01", "2026-04-01");
      expect(capital.openingPaise).toBe(0);
      expect(capital.lines[0].creditPaise).toBe(50000);
      expect(capital.closingPaise).toBe(50000);
    } finally {
      client.release();
    }
  });

  it("treats a rent reversal as ordinary lines and keeps the book balanced", async () => {
    const { rent, client } = await books();
    client.release();
    await reverseRent(db.pool, rent.id);
    const reader = await db.pool.connect();
    try {
      const pl = await profitAndLoss(reader, "2026-04-01", "2026-04-30");
      expect(pl.expenseTotalPaise).toBe(0);
      expect(pl.profitPaise).toBe(10000);

      const bank = await accountStatement(reader, "1120", "2026-04-01", "2026-04-30");
      expect(bank.closingPaise).toBe(61800);

      const tb = await trialBalance(reader, "2026-04-30");
      expect(tb.differencePaise).toBe(0);
      const bs = await balanceSheet(reader, "2026-04-30");
      expect(bs.balances.differencePaise).toBe(0);
      expect(bs.balances.assetsPaise).toBe(61800);
      expect(bs.equity.find((row) => row.name === "Current earnings")?.amountPaise).toBe(10000);
    } finally {
      reader.release();
    }
  });

  it("places abnormal balances in the opposite trial-balance column", async () => {
    db = await createTestSchema();
    await postWorkedExample(db.pool);
    await postEntry(db.pool, {
      entryDate: "2026-04-05",
      narration: "Credit note larger than the receipt",
      createdBy: "tester",
      lines: [
        { accountCode: "4100", debitPaise: 12000, creditPaise: 0 },
        { accountCode: "1120", debitPaise: 0, creditPaise: 12000 },
      ],
    });
    await postEntry(db.pool, {
      entryDate: "2026-04-06",
      narration: "Receivable written back past its balance",
      createdBy: "tester",
      lines: [
        { accountCode: "3100", debitPaise: 3000, creditPaise: 0 },
        { accountCode: "1130", debitPaise: 0, creditPaise: 3000 },
      ],
    });
    const client = await db.pool.connect();
    try {
      const tb = await trialBalance(client, "2026-04-30");
      const byCode = Object.fromEntries(tb.rows.map((row) => [row.code, row]));
      expect(byCode["4100"]).toMatchObject({ debitPaise: 2000, creditPaise: 0 });
      expect(byCode["1130"]).toMatchObject({ debitPaise: 0, creditPaise: 3000 });
      expect(tb.differencePaise).toBe(0);
      const pl = await profitAndLoss(client, "2026-04-01", "2026-04-30");
      expect(pl.incomeTotalPaise).toBe(-2000);
      const bs = await balanceSheet(client, "2026-04-30");
      expect(bs.balances.differencePaise).toBe(0);
    } finally {
      client.release();
    }
  });

  it("rejects an unknown account", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await expect(accountStatement(client, "9999", "2026-04-01", "2026-04-30")).rejects.toBeInstanceOf(
        AccountNotFound,
      );
    } finally {
      client.release();
    }
  });
});

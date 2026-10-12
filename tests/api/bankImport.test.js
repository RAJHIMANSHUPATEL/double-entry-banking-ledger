import { afterEach, describe, expect, it } from "vitest";
import { postEntry } from "../../src/services/posting.js";
import { importStatement, reconciliationInternals } from "../../src/services/reconciliation.js";
import { AlreadyMatched, CsvRejected, InvalidEntry } from "../../src/services/exceptions.js";
import { actorHeaders, createTestApp } from "../helpers/api.js";
import { createTestSchema } from "../helpers/db.js";
import { seedChart } from "../../src/seed/chart.js";

function multipart(code, csv, filename = "hdfc.csv") {
  const boundary = "----paiseboundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="bank_account_code"\r\n\r\n${code}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
    Buffer.from(csv),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("bank import API", () => {
  /** @type {Awaited<ReturnType<typeof createTestApp>> | undefined} */
  let ctx;

  afterEach(async () => {
    reconciliationInternals.beforePersist = async () => {};
    await ctx?.close();
    ctx = undefined;
  });

  it("imports a CSV, auto-matches a deposit, and lists the lines", async () => {
    ctx = await createTestApp();
    const posted = await ctx.app.inject({
      method: "POST",
      url: "/entries",
      headers: actorHeaders(),
      payload: {
        entry_date: "2026-04-02",
        narration: "Studio rent",
        lines: [
          { account_code: "1120", debit_paise: 500000, credit_paise: 0 },
          { account_code: "3100", debit_paise: 0, credit_paise: 500000 },
        ],
      },
    });
    expect(posted.statusCode).toBe(201);

    const csv = [
      "date,narration,withdrawal,deposit,balance",
      "02/04/2026,Studio rent,,5000.00,5000.00",
      "32/01/2026,Bad,10,,",
      "05/04/2026,Unknown charge,118.00,,",
    ].join("\n");
    const form = multipart("1120", csv);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/bank-statements",
      headers: { ...actorHeaders(), ...form.headers },
      payload: form.body,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.counts).toMatchObject({ matched: 1, unmatched: 1, suggested: 0 });
    expect(body.errors).toHaveLength(1);
    expect(body.row_count).toBe(2);

    const summary = await ctx.app.inject({ method: "GET", url: `/bank-statements/${body.id}` });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().counts.matched).toBe(1);

    const lines = await ctx.app.inject({ method: "GET", url: `/bank-statements/${body.id}/lines?status=matched` });
    expect(lines.json().lines).toHaveLength(1);
    expect(lines.json().lines[0].amount_paise).toBe(500000);
    expect(lines.json().lines[0].match_score).toBe(100);
    expect(lines.json().lines[0].amount_display).toBe("₹5,000.00");
  });

  it("rejects an empty CSV and a missing actor", async () => {
    ctx = await createTestApp();
    const form = multipart("1120", "date,narration,withdrawal,deposit,balance\n");
    const rejected = await ctx.app.inject({
      method: "POST",
      url: "/bank-statements",
      headers: { ...actorHeaders(), ...form.headers },
      payload: form.body,
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("CSV_REJECTED");

    const noActor = await ctx.app.inject({
      method: "POST",
      url: "/bank-statements",
      headers: form.headers,
      payload: form.body,
    });
    expect(noActor.statusCode).toBe(400);
    expect(noActor.json().error.code).toBe("ACTOR_REQUIRED");
  });
});

describe("importStatement conflicts", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    reconciliationInternals.beforePersist = async () => {};
    await db?.close();
  });

  it("returns the original conflict when two imports match the same journal line", async () => {
    db = await createTestSchema({ max: 8 });
    const client = await db.pool.connect();
    try {
      await seedChart(client);
    } finally {
      client.release();
    }
    await postEntry(db.pool, {
      entryDate: "2026-04-02",
      narration: "Studio rent",
      createdBy: "tester",
      lines: [
        { accountCode: "1120", debitPaise: 500000, creditPaise: 0 },
        { accountCode: "3100", debitPaise: 0, creditPaise: 500000 },
      ],
    });
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let arrived = 0;
    reconciliationInternals.beforePersist = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    };
    const csv = "date,narration,withdrawal,deposit,balance\n02/04/2026,Studio rent,,5000.00,\n";
    const results = await Promise.allSettled([
      importStatement(db.pool, { bankAccountCode: "1120", filename: "a.csv", content: csv, actor: "tester" }),
      importStatement(db.pool, { bankAccountCode: "1120", filename: "b.csv", content: csv, actor: "tester" }),
    ]);
    const rejected = results.filter((result) => result.status === "rejected");
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(AlreadyMatched);
    expect(fulfilled[0].value.counts.matched).toBe(1);
  });

  it("refuses a non-asset account and a file with no rows", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await seedChart(client);
    } finally {
      client.release();
    }
    await expect(
      importStatement(db.pool, {
        bankAccountCode: "4100",
        filename: "x.csv",
        content: "date,narration,withdrawal,deposit,balance\n02/04/2026,Rent,10,,\n",
        actor: "tester",
      }),
    ).rejects.toBeInstanceOf(InvalidEntry);
    await expect(
      importStatement(db.pool, {
        bankAccountCode: "1120",
        filename: "x.csv",
        content: "not,a,bank,file,here\n1,2,3,4,5\n",
        actor: "tester",
      }),
    ).rejects.toBeInstanceOf(CsvRejected);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { actorHeaders, createTestApp } from "../helpers/api.js";

function multipart(csv) {
  const boundary = "----paiseboundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="bank_account_code"\r\n\r\n1120\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hdfc.csv"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
    Buffer.from(csv),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { ...actorHeaders(), "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/**
 * @param {Awaited<ReturnType<typeof createTestApp>>["app"]} app
 * @param {string} date
 * @param {string} narration
 * @param {number} paise
 */
async function bankDebit(app, date, narration, paise) {
  const response = await app.inject({
    method: "POST",
    url: "/entries",
    headers: actorHeaders(),
    payload: {
      entry_date: date,
      narration,
      lines: [
        { account_code: "1120", debit_paise: paise, credit_paise: 0 },
        { account_code: "3100", debit_paise: 0, credit_paise: paise },
      ],
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().lines.find((line) => line.account_code === "1120").id;
}

describe("reconciliation decisions", () => {
  /** @type {Awaited<ReturnType<typeof createTestApp>> | undefined} */
  let ctx;

  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it("confirms each suggestion once and records the decision on the audit log", async () => {
    ctx = await createTestApp();
    const april = await bankDebit(ctx.app, "2026-04-02", "payment aws india april", 30000);
    const mehta = await bankDebit(ctx.app, "2026-04-03", "client neft mehta", 40000);
    const csv = [
      "date,narration,withdrawal,deposit,balance",
      "02/04/2026,payment aws india may,,300.00,",
      "03/04/2026,client neft metha,,400.00,",
    ].join("\n");
    const imported = await ctx.app.inject({ method: "POST", url: "/bank-statements", ...pack(csv) });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().counts.suggested).toBe(2);
    const lines = await ctx.app.inject({ method: "GET", url: `/bank-statements/${imported.json().id}/lines` });
    const [first, second] = lines.json().lines;
    expect(first.candidate_journal_line_id).toBe(april);
    expect(second.candidate_journal_line_id).toBe(mehta);

    const openBefore = await ctx.app.inject({
      method: "GET",
      url: `/bank-statements/${imported.json().id}/open-journal-lines`,
    });
    expect(openBefore.json().lines.map((line) => line.id).sort((a, b) => a - b)).toEqual([april, mehta].sort((a, b) => a - b));

    const confirmed = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${first.id}/confirm`,
      headers: actorHeaders(),
      payload: {},
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().match_status).toBe("matched");
    expect(confirmed.json().matched_journal_line_id).toBe(april);

    const again = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${first.id}/confirm`,
      headers: actorHeaders(),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ALREADY_MATCHED");

    const secondConfirm = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${second.id}/confirm`,
      headers: actorHeaders(),
      payload: {},
    });
    expect(secondConfirm.statusCode).toBe(200);
    expect(secondConfirm.json().matched_journal_line_id).toBe(mehta);

    const rejectMatched = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${first.id}/reject`,
      headers: actorHeaders(),
    });
    expect(rejectMatched.statusCode).toBe(422);
    expect(rejectMatched.json().error.code).toBe("VALIDATION_ERROR");

    const audit = await ctx.app.inject({ method: "GET", url: "/audit" });
    expect(audit.json().reconciliation.some((event) => event.action === "confirm" && event.journal_line_id === april)).toBe(
      true,
    );
    const still = await ctx.app.inject({ method: "GET", url: `/bank-statements/${imported.json().id}/lines?status=matched` });
    expect(still.json().lines).toHaveLength(2);
  });

  it("rejects a shared candidate on the second confirm and keeps the first match", async () => {
    ctx = await createTestApp();
    const april = await bankDebit(ctx.app, "2026-04-02", "payment aws india april", 100000);
    await bankDebit(ctx.app, "2026-04-02", "payment aws india may", 100000);
    const csv = [
      "date,narration,withdrawal,deposit,balance",
      "02/04/2026,payment aws india april,,1000.00,",
      "02/04/2026,payment aws india may,,1000.00,",
    ].join("\n");
    const imported = await ctx.app.inject({ method: "POST", url: "/bank-statements", ...pack(csv) });
    const lines = await ctx.app.inject({ method: "GET", url: `/bank-statements/${imported.json().id}/lines` });
    const [first, second] = lines.json().lines;
    const client = await ctx.db.pool.connect();
    try {
      await client.query(
        `UPDATE bank_statement_lines
         SET match_status = 'suggested', matched_journal_line_id = NULL, candidate_journal_line_id = $2
         WHERE id = $1`,
        [second.id, april],
      );
    } finally {
      client.release();
    }
    const ok = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${first.id}/confirm`,
      headers: actorHeaders(),
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    const conflict = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${second.id}/confirm`,
      headers: actorHeaders(),
      payload: {},
    });
    expect(conflict.statusCode).toBe(409);
    const reread = await ctx.app.inject({ method: "GET", url: `/bank-statements/${imported.json().id}/lines` });
    const kept = reread.json().lines.find((line) => line.id === first.id);
    expect(kept.match_status).toBe("matched");
    expect(kept.matched_journal_line_id).toBe(april);
  });

  it("does not suggest a rejected pair again and can suggest the other line", async () => {
    ctx = await createTestApp();
    const april = await bankDebit(ctx.app, "2026-04-02", "payment aws india april", 100000);
    const may = await bankDebit(ctx.app, "2026-04-02", "payment aws india may", 100000);
    const csv = "date,narration,withdrawal,deposit,balance\n02/04/2026,payment aws india april,,1000.00,\n";
    const imported = await ctx.app.inject({ method: "POST", url: "/bank-statements", ...pack(csv) });
    expect(imported.json().counts.suggested).toBe(1);
    const lines = await ctx.app.inject({ method: "GET", url: `/bank-statements/${imported.json().id}/lines` });
    const line = lines.json().lines[0];
    expect(line.candidate_journal_line_id).toBe(april);

    const rejected = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${line.id}/reject`,
      headers: actorHeaders(),
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().match_status).toBe("rejected");
    expect(rejected.json().candidate_journal_line_id).toBeNull();

    const rematch = await ctx.app.inject({
      method: "POST",
      url: `/bank-statements/${imported.json().id}/rematch`,
      headers: actorHeaders(),
    });
    expect(rematch.statusCode).toBe(200);
    expect(rematch.json().counts.suggested).toBe(1);
    const after = await ctx.app.inject({ method: "GET", url: `/bank-statements/${imported.json().id}/lines` });
    expect(after.json().lines[0].candidate_journal_line_id).toBe(may);
    expect(after.json().lines[0].candidate_journal_line_id).not.toBe(april);
  });

  it("matches an unmatched line by id and refuses a different amount", async () => {
    ctx = await createTestApp();
    const journalId = await bankDebit(ctx.app, "2026-04-02", "payment aws india april", 25000);
    const csv = "date,narration,withdrawal,deposit,balance\n02/04/2026,zzzz unique vendor,,250.00,\n";
    const imported = await ctx.app.inject({ method: "POST", url: "/bank-statements", ...pack(csv) });
    expect(imported.json().counts.unmatched).toBe(1);
    const lines = await ctx.app.inject({ method: "GET", url: `/bank-statements/${imported.json().id}/lines` });
    const lineId = lines.json().lines[0].id;

    const distant = await bankDebit(ctx.app, "2026-04-20", "payment aws india april", 25000);
    const outside = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${lineId}/match`,
      headers: actorHeaders(),
      payload: { journal_line_id: distant },
    });
    expect(outside.statusCode).toBe(422);
    expect(outside.json().error.message).toMatch(/date window/);

    const wrong = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${lineId}/match`,
      headers: actorHeaders(),
      payload: { journal_line_id: journalId + 1 },
    });
    expect(wrong.statusCode).toBe(422);

    const matched = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${lineId}/match`,
      headers: actorHeaders(),
      payload: { journal_line_id: journalId },
    });
    expect(matched.statusCode).toBe(200);
    expect(matched.json().match_status).toBe("matched");
    const audit = await ctx.app.inject({ method: "GET", url: "/audit" });
    expect(audit.json().reconciliation.some((event) => event.action === "manual_match")).toBe(true);
  });

  it("returns a rejected line to unmatched when rematch has no other candidate", async () => {
    ctx = await createTestApp();
    await bankDebit(ctx.app, "2026-04-02", "payment aws india april", 80000);
    const csv = "date,narration,withdrawal,deposit,balance\n02/04/2026,payment aws india may,,800.00,\n";
    const imported = await ctx.app.inject({ method: "POST", url: "/bank-statements", ...pack(csv) });
    const line = (await ctx.app.inject({ method: "GET", url: `/bank-statements/${imported.json().id}/lines` })).json().lines[0];
    expect(line.match_status).toBe("suggested");
    const rejected = await ctx.app.inject({
      method: "POST",
      url: `/bank-statement-lines/${line.id}/reject`,
      headers: actorHeaders(),
    });
    expect(rejected.statusCode).toBe(200);
    const rematch = await ctx.app.inject({
      method: "POST",
      url: `/bank-statements/${imported.json().id}/rematch`,
      headers: actorHeaders(),
    });
    expect(rematch.json().counts).toMatchObject({ unmatched: 1, suggested: 0, matched: 0 });
  });
});

/**
 * @param {string} csv
 */
function pack(csv) {
  const form = multipart(csv);
  return { headers: form.headers, payload: form.body };
}

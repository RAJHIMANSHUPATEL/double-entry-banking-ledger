import { afterEach, describe, expect, it } from "vitest";
import { actorHeaders, createTestApp } from "../helpers/api.js";

describe("entries API", () => {
  /** @type {Awaited<ReturnType<typeof createTestApp>> | undefined} */
  let ctx;

  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it("posts a balanced entry", async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/entries",
      headers: actorHeaders(),
      payload: balanced("Capital"),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.debit_total_paise).toBe(body.credit_total_paise);
    expect(body.sequence_no).toBe(1);
    expect(body.debit_total_display).toBe("₹100.00");
  });

  it("rejects an unbalanced entry and leaves the journal empty", async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/entries",
      headers: actorHeaders(),
      payload: {
        entry_date: "2026-04-02",
        narration: "Unequal",
        lines: [
          { account_code: "1110", debit_paise: 150000, credit_paise: 0 },
          { account_code: "3100", debit_paise: 0, credit_paise: 140000 },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("UNBALANCED_ENTRY");
    expect(response.json().error.request_id).toEqual(expect.any(String));
    const list = await ctx.app.inject({ method: "GET", url: "/entries" });
    expect(list.statusCode).toBe(200);
    expect(list.json().entries).toEqual([]);
    expect(list.json().total).toBe(0);
  });

  it("requires an actor on writes", async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({ method: "POST", url: "/entries", payload: balanced("Capital") });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("ACTOR_REQUIRED");
  });

  it("replays the same idempotency key and conflicts on a different body", async () => {
    ctx = await createTestApp();
    const first = await ctx.app.inject({
      method: "POST",
      url: "/entries",
      headers: actorHeaders({ "idempotency-key": "api-key-1" }),
      payload: balanced("Capital"),
    });
    expect(first.statusCode).toBe(201);
    const replay = await ctx.app.inject({
      method: "POST",
      url: "/entries",
      headers: actorHeaders({ "idempotency-key": "api-key-1" }),
      payload: balanced("Capital"),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    const conflict = await ctx.app.inject({
      method: "POST",
      url: "/entries",
      headers: actorHeaders({ "idempotency-key": "api-key-1" }),
      payload: balanced("Different narration"),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    const list = await ctx.app.inject({ method: "GET", url: "/entries" });
    expect(list.json().total).toBe(1);
  });

  it("reverses once and keeps the original narration", async () => {
    ctx = await createTestApp();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/entries",
      headers: actorHeaders(),
      payload: balanced("Keep this narration"),
    });
    const id = created.json().id;
    const reversed = await ctx.app.inject({
      method: "POST",
      url: `/entries/${id}/reverse`,
      headers: actorHeaders(),
      payload: { entry_date: "2026-04-10", narration: "Reverse it" },
    });
    expect(reversed.statusCode).toBe(201);
    expect(reversed.json().reverses_entry_id).toBe(id);
    const original = await ctx.app.inject({ method: "GET", url: `/entries/${id}` });
    expect(original.json().narration).toBe("Keep this narration");
    const again = await ctx.app.inject({
      method: "POST",
      url: `/entries/${id}/reverse`,
      headers: actorHeaders(),
      payload: { entry_date: "2026-04-11", narration: "Reverse it again" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ALREADY_REVERSED");
  });

  it("verifies a two-entry chain and publishes the routes", async () => {
    ctx = await createTestApp();
    await ctx.app.inject({ method: "POST", url: "/entries", headers: actorHeaders(), payload: balanced("One") });
    await ctx.app.inject({ method: "POST", url: "/entries", headers: actorHeaders(), payload: balanced("Two", 200) });
    const verified = await ctx.app.inject({ method: "GET", url: "/verify-chain" });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ ok: true, entries_checked: 2, head_sequence: 2 });
    const spec = await ctx.app.inject({ method: "GET", url: "/openapi.json" });
    expect(spec.statusCode).toBe(200);
    const paths = Object.keys(spec.json().paths);
    expect(paths).toEqual(expect.arrayContaining(["/entries", "/verify-chain", "/accounts"]));
    const audit = await ctx.app.inject({ method: "GET", url: "/audit" });
    expect(audit.json().journal).toHaveLength(2);
    expect(audit.json().reconciliation).toEqual([]);
  });
});

function balanced(narration, paise = 10000) {
  return {
    entry_date: "2026-04-02",
    narration,
    lines: [
      { account_code: "1110", debit_paise: paise, credit_paise: 0 },
      { account_code: "3100", debit_paise: 0, credit_paise: paise },
    ],
  };
}

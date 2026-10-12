import { afterEach, describe, expect, it } from "vitest";
import { actorHeaders, createTestApp } from "../helpers/api.js";

describe("accounts API", () => {
  /** @type {Awaited<ReturnType<typeof createTestApp>> | undefined} */
  let ctx;

  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it("lists the chart with parent codes", async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({ method: "GET", url: "/accounts" });
    expect(response.statusCode).toBe(200);
    const accounts = response.json().accounts;
    const bank = accounts.find((account) => account.code === "1120");
    expect(bank).toMatchObject({
      name: "Bank — HDFC Current Account",
      parent_code: "1100",
      is_group: false,
      prevent_overdraft: true,
    });
  });

  it("rejects an account whose type does not match its parent", async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/accounts",
      headers: actorHeaders(),
      payload: {
        code: "1199",
        name: "Misplaced expense",
        type: "expense",
        parent_code: "1000",
        is_group: false,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("creates a leaf under a matching group and can deactivate it", async () => {
    ctx = await createTestApp();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/accounts",
      headers: actorHeaders(),
      payload: {
        code: "5710",
        name: "Paper and ink",
        type: "expense",
        parent_code: "5000",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().account).toMatchObject({ code: "5710", parent_code: "5000", is_active: true });
    const deactivated = await ctx.app.inject({
      method: "POST",
      url: "/accounts/5710/deactivate",
      headers: actorHeaders(),
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().account.is_active).toBe(false);
  });
});
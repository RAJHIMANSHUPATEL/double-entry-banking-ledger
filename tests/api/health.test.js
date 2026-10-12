import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

describe("GET /health", () => {
  it("returns 200 when Postgres answers SELECT 1", async () => {
    const app = await buildApp({ logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", database: "ok" });
    await app.close();
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../../src/app.js";

describe("error envelope", () => {
  it("returns code, message, details, and request_id for a validation failure", async () => {
    const app = await buildApp({ logger: false });
    app.post("/probe", async (request) => {
      const { parseWith } = await import("../../src/api/errors.js");
      parseWith(z.object({ name: z.string().min(1) }), request.body);
      return { ok: true };
    });

    const response = await app.inject({
      method: "POST",
      url: "/probe",
      headers: { "x-request-id": "req-envelope-1" },
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers["x-request-id"]).toBe("req-envelope-1");
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toEqual(expect.any(String));
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details[0]).toEqual(
      expect.objectContaining({ loc: expect.any(Array), message: expect.any(String) }),
    );
    expect(body.error.request_id).toBe("req-envelope-1");
    await app.close();
  });

  it("generates a request id when the client omits one", async () => {
    const app = await buildApp({ logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    await app.close();
  });
});

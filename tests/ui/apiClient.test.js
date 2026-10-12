import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "../../web/src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("turns an error envelope into ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "UNBALANCED_ENTRY", message: "Debits differ.", details: { debit_paise: 1 } } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(request("/entries", { method: "POST", body: {} })).rejects.toMatchObject({
      name: "ApiError",
      code: "UNBALANCED_ENTRY",
      message: "Debits differ.",
    });
    await expect(request("/entries", { method: "POST", body: {} })).rejects.toBeInstanceOf(ApiError);
  });

  it("returns the entry id from a 201", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        expect(init.headers["idempotency-key"]).toBe("key-1");
        expect(init.headers["x-actor"]).toBe("reviewer");
        return new Response(JSON.stringify({ id: 41, sequence_no: 7 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const entry = await request("/entries", {
      method: "POST",
      body: { narration: "Rent" },
      actor: "reviewer",
      idempotencyKey: "key-1",
    });
    expect(entry.id).toBe(41);
    expect(entry.sequence_no).toBe(7);
  });
});

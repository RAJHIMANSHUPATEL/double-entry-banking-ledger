import { afterEach, describe, expect, it } from "vitest";
import { canonicalV1 } from "../../src/services/hashing.js";
import { requestHash } from "../../src/services/idempotency.js";
import { IdempotencyConflict, UnbalancedEntry } from "../../src/services/exceptions.js";
import { postEntry } from "../../src/services/posting.js";
import { reverseEntry } from "../../src/services/reversal.js";
import { seedChart } from "../../src/seed/chart.js";
import { createTestSchema } from "../helpers/db.js";

describe("idempotency", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("returns the original entry when the same key and body are retried", async () => {
    db = await createTestSchema();
    await withChart(db);
    const body = capitalBody("Owner capital");
    const hash = requestHash(body);
    const first = await postEntry(db.pool, { ...body, createdBy: "tester", idempotencyKey: "post-1", requestHash: hash });
    const second = await postEntry(db.pool, { ...body, createdBy: "tester", idempotencyKey: "post-1", requestHash: hash });
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    const client = await db.pool.connect();
    try {
      const entries = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(entries.rows[0].n).toBe(1);
      const meta = await client.query("SELECT last_sequence, last_hash FROM ledger_meta WHERE id = 1");
      expect(meta.rows[0].last_sequence).toBe(1);
      expect(String(meta.rows[0].last_hash).trim()).toBe(first.entryHash);
    } finally {
      client.release();
    }
  });

  it("rejects the same key with a different body and keeps the first row", async () => {
    db = await createTestSchema();
    await withChart(db);
    const firstBody = capitalBody("First meaning");
    await postEntry(db.pool, {
      ...firstBody,
      createdBy: "tester",
      idempotencyKey: "post-2",
      requestHash: requestHash(firstBody),
    });
    const secondBody = capitalBody("Second meaning");
    await expect(
      postEntry(db.pool, {
        ...secondBody,
        createdBy: "tester",
        idempotencyKey: "post-2",
        requestHash: requestHash(secondBody),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflict);
    const client = await db.pool.connect();
    try {
      const entries = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(entries.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  });

  it("does not burn a key when the first body is unbalanced", async () => {
    db = await createTestSchema();
    await withChart(db);
    const bad = {
      entryDate: "2026-04-02",
      narration: "Unbalanced",
      lines: [
        { accountCode: "1110", debitPaise: 150000, creditPaise: 0 },
        { accountCode: "3100", debitPaise: 0, creditPaise: 140000 },
      ],
    };
    await expect(
      postEntry(db.pool, { ...bad, createdBy: "tester", idempotencyKey: "post-3", requestHash: requestHash(bad) }),
    ).rejects.toBeInstanceOf(UnbalancedEntry);
    const client = await db.pool.connect();
    try {
      const keys = await client.query("SELECT count(*)::bigint AS n FROM idempotency_keys");
      expect(keys.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
    const good = capitalBody("Corrected");
    const entry = await postEntry(db.pool, {
      ...good,
      createdBy: "tester",
      idempotencyKey: "post-3",
      requestHash: requestHash(good),
    });
    expect(entry.sequenceNo).toBe(1);
    const check = await db.pool.connect();
    try {
      const keys = await check.query("SELECT count(*)::bigint AS n FROM idempotency_keys");
      expect(keys.rows[0].n).toBe(1);
    } finally {
      check.release();
    }
  });

  it("replays a reversal with the same key", async () => {
    db = await createTestSchema();
    await withChart(db);
    const original = await postEntry(db.pool, { ...capitalBody("To reverse"), createdBy: "tester" });
    const command = { entryDate: "2026-04-09", narration: "Reverse capital", entryId: original.id };
    const hash = requestHash(command);
    const first = await reverseEntry(db.pool, original.id, {
      entryDate: command.entryDate,
      narration: command.narration,
      createdBy: "tester",
      idempotencyKey: "rev-1",
      requestHash: hash,
    });
    const second = await reverseEntry(db.pool, original.id, {
      entryDate: command.entryDate,
      narration: command.narration,
      createdBy: "tester",
      idempotencyKey: "rev-1",
      requestHash: hash,
    });
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    const client = await db.pool.connect();
    try {
      const entries = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(entries.rows[0].n).toBe(2);
    } finally {
      client.release();
    }
  });

  it("keeps the idempotency key out of the canonical hash string", () => {
    const canonical = canonicalV1({
      sequenceNo: 1,
      entryDate: "2026-04-01",
      narration: "Owner introduced capital",
      reference: null,
      reversesEntryId: null,
      createdBy: "anaya",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
      prevHash: "0".repeat(64),
      lines: [
        { lineNo: 1, accountId: 3, debitPaise: 100, creditPaise: 0, lineNarration: null },
        { lineNo: 2, accountId: 21, debitPaise: 0, creditPaise: 100, lineNarration: null },
      ],
    });
    expect(canonical.includes("idempotency")).toBe(false);
    expect(canonical.includes("post-1")).toBe(false);
    const hash = requestHash({ idempotencyKey: "post-1", narration: "Owner introduced capital" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonical.includes(hash)).toBe(false);
  });
});

async function withChart(db) {
  const client = await db.pool.connect();
  try {
    await seedChart(client);
  } finally {
    client.release();
  }
}

function capitalBody(narration) {
  return {
    entryDate: "2026-04-02",
    narration,
    reference: null,
    lines: [
      { accountCode: "1110", debitPaise: 10000, creditPaise: 0 },
      { accountCode: "3100", debitPaise: 0, creditPaise: 10000 },
    ],
  };
}

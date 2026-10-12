/**
 * Concurrent posts use separate pg clients against one schema so
 * `SELECT … FOR UPDATE` on ledger_meta actually blocks. PostgreSQL waits
 * for the row lock; this file is the proof that two spends cannot both
 * take the same cash.
 */
import { afterEach, describe, expect, it } from "vitest";
import { seedChart } from "../../src/seed/chart.js";
import { balancePaise } from "../../src/services/balances.js";
import { Overdraft } from "../../src/services/exceptions.js";
import { verifyChain } from "../../src/services/hashing.js";
import { requestHash } from "../../src/services/idempotency.js";
import { postEntry } from "../../src/services/posting.js";
import { createTestSchema } from "../helpers/db.js";

describe("concurrent posting", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("lets only one of two full cash spends succeed", async () => {
    db = await createTestSchema({ max: 8 });
    await withChart(db);
    await postEntry(db.pool, entry("1110", "3100", 10000, "Opening cash"));
    const arrive = barrier(2);
    const attempts = await Promise.allSettled([
      gatedSpend(arrive, "spend-a"),
      gatedSpend(arrive, "spend-b"),
    ]);
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(Overdraft);

    const client = await db.pool.connect();
    try {
      const cash = await client.query("SELECT id FROM accounts WHERE code = '1110'");
      expect(await balancePaise(client, cash.rows[0].id)).toBe(0);
      const count = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(count.rows[0].n).toBe(2);
      const verified = await verifyChain(client);
      expect(verified.ok).toBe(true);
    } finally {
      client.release();
    }

    await expect(postEntry(db.pool, entry("5700", "1110", 1, "One more paisa"))).rejects.toBeInstanceOf(Overdraft);
  });

  it("serializes ten balanced posts into a contiguous chain", async () => {
    db = await createTestSchema({ max: 16 });
    await withChart(db);
    const arrive = barrier(10);
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, index) => gatedEntry(arrive, index)),
    );
    expect(attempts).toHaveLength(10);
    const sequences = attempts.map((entry) => entry.sequenceNo).sort((left, right) => left - right);
    expect(sequences).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    const client = await db.pool.connect();
    try {
      const sums = await client.query(
        `SELECT COALESCE(SUM(debit_paise), 0)::bigint AS debits,
                COALESCE(SUM(credit_paise), 0)::bigint AS credits
         FROM journal_lines`,
      );
      expect(sums.rows[0].debits).toBe(sums.rows[0].credits);
      const verified = await verifyChain(client);
      expect(verified.ok).toBe(true);
      expect(verified.entriesChecked).toBe(10);
    } finally {
      client.release();
    }
  });

  it("returns one row when two callers share an idempotency key and body", async () => {
    db = await createTestSchema({ max: 8 });
    await withChart(db);
    const body = entry("5700", "4100", 250, "Shared retry");
    const hash = requestHash(body);
    const command = { ...body, idempotencyKey: "shared-key", requestHash: hash };
    const arrive = barrier(2);
    const [first, second] = await Promise.all([
      arrive().then(() => postEntry(db.pool, command)),
      arrive().then(() => postEntry(db.pool, command)),
    ]);
    expect(first.id).toBe(second.id);
    const client = await db.pool.connect();
    try {
      const count = await client.query("SELECT count(*)::bigint AS n FROM journal_entries");
      expect(count.rows[0].n).toBe(1);
      const keys = await client.query("SELECT count(*)::bigint AS n FROM idempotency_keys");
      expect(keys.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  });
});

function barrier(size) {
  let arrived = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  return function arrive() {
    return new Promise((resolve) => {
      arrived += 1;
      if (arrived === size) {
        const pending = waiting.splice(0);
        resolve();
        for (const wake of pending) wake();
        return;
      }
      waiting.push(resolve);
    });
  };
}

async function gatedSpend(arrive, key) {
  await arrive();
  return postEntry(dbFromArrive(arrive), entry("5700", "1110", 10000, `Spend ${key}`, key));
}

/**
 * The spend helpers close over the suite's current schema via the module function below.
 * @param {() => Promise<void>} arrive
 * @param {number} index
 */
async function gatedEntry(arrive, index) {
  await arrive();
  return postEntry(currentPool(), entry("5700", "4100", 100, `Parallel ${index}`, `parallel-${index}`));
}

/** @type {import('pg').Pool | null} */
let activePool = null;

function currentPool() {
  if (!activePool) throw new Error("Test pool is not active.");
  return activePool;
}

function dbFromArrive() {
  return currentPool();
}

async function withChart(schema) {
  activePool = schema.pool;
  const client = await schema.pool.connect();
  try {
    await seedChart(client);
  } finally {
    client.release();
  }
}

function entry(debitCode, creditCode, paise, narration, idempotencyKey) {
  const body = {
    entryDate: "2026-05-01",
    narration,
    reference: null,
    createdBy: "racer",
    lines: [
      { accountCode: debitCode, debitPaise: paise, creditPaise: 0 },
      { accountCode: creditCode, debitPaise: 0, creditPaise: paise },
    ],
  };
  if (!idempotencyKey) return body;
  return { ...body, idempotencyKey, requestHash: requestHash(body) };
}

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { freezeTime, unfreezeTime } from "../../src/domain/clock.js";
import { canonicalV1, encodeHashField, hashCanonical, verifyChain } from "../../src/services/hashing.js";
import { postEntry } from "../../src/services/posting.js";
import { seedChart } from "../../src/seed/chart.js";
import { createTestSchema } from "../helpers/db.js";

const PINNED_GOLDEN_HASH = "bdb8a27a6eaf3d9d363f1a6ab75f5d582ed3fb56912273bb37f031afecb2e922";

describe("hash chain", () => {
  /** @type {Awaited<ReturnType<typeof createTestSchema>> | undefined} */
  let db;

  afterEach(async () => {
    unfreezeTime();
    await db?.close();
    db = undefined;
  });

  it("percent-encodes delimiters and leaves empty reference and reversal fields empty", () => {
    expect(encodeHashField("100%;done")).toBe("100%25%3Bdone");
    const canonical = canonicalV1({
      sequenceNo: 1,
      entryDate: "2026-04-01",
      narration: "Note; part",
      reference: null,
      reversesEntryId: null,
      createdBy: "anaya",
      createdAt: new Date("2026-04-01T10:00:00.000Z"),
      prevHash: "0".repeat(64),
      lines: [{ lineNo: 1, accountId: 3, debitPaise: 100, creditPaise: 0, lineNarration: "a%b" }],
    });
    expect(canonical).toBe(
      `v1|1|2026-04-01|Note%3B part|||anaya|2026-04-01T10:00:00Z|${"0".repeat(64)}|1:3:100:0:a%25b`,
    );
  });

  it("pins the golden digest for a frozen two-line entry", async () => {
    db = await createTestSchema();
    const client = await db.pool.connect();
    try {
      await seedChart(client);
    } finally {
      client.release();
    }
    freezeTime("2026-04-01T10:00:00.987Z");
    const entry = await postEntry(db.pool, {
      entryDate: "2026-04-01",
      narration: "Owner introduced capital",
      reference: null,
      createdBy: "anaya",
      lines: [
        { accountCode: "1110", debitPaise: 50000, creditPaise: 0, lineNarration: null },
        { accountCode: "3100", debitPaise: 0, creditPaise: 50000, lineNarration: null },
      ],
    });
    const reader = await db.pool.connect();
    try {
      const accounts = await reader.query("SELECT id, code FROM accounts WHERE code IN ('1110', '3100')");
      const byCode = new Map(accounts.rows.map((row) => [row.code, row.id]));
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
          { lineNo: 1, accountId: byCode.get("1110"), debitPaise: 50000, creditPaise: 0, lineNarration: null },
          { lineNo: 2, accountId: byCode.get("3100"), debitPaise: 0, creditPaise: 50000, lineNarration: null },
        ],
      });
      const digest = hashCanonical(canonical);
      expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(digest);
      expect(entry.entryHash).toBe(digest);
      expect(entry.prevHash).toBe("0".repeat(64));
      expect(digest).toBe(PINNED_GOLDEN_HASH);
    } finally {
      reader.release();
    }
  });

  it("links the second entry to the first hash and verifies an empty book", async () => {
    db = await createTestSchema();
    const setup = await db.pool.connect();
    try {
      await seedChart(setup);
      const empty = await verifyChain(setup);
      expect(empty).toMatchObject({ ok: true, entriesChecked: 0, headSequence: 0, headHash: "0".repeat(64) });
    } finally {
      setup.release();
    }
    const first = await postEntry(db.pool, draft("First", 100));
    const second = await postEntry(db.pool, draft("Second", 200));
    expect(first.prevHash).toBe("0".repeat(64));
    expect(second.prevHash).toBe(first.entryHash);
    const reader = await db.pool.connect();
    try {
      const verified = await verifyChain(reader);
      expect(verified.ok).toBe(true);
      expect(verified.entriesChecked).toBe(2);
      expect(verified.headSequence).toBe(2);
      expect(verified.headHash).toBe(second.entryHash);
    } finally {
      reader.release();
    }
  });

  it("detects a narration change after the append-only trigger is dropped", async () => {
    db = await createTestSchema();
    const setup = await db.pool.connect();
    try {
      await seedChart(setup);
    } finally {
      setup.release();
    }
    const entry = await postEntry(db.pool, draft("Original narration", 100));
    const client = await db.pool.connect();
    try {
      await client.query("DROP TRIGGER trg_journal_entries_append_only ON journal_entries");
      await client.query("UPDATE journal_entries SET narration = 'Tampered narration' WHERE id = $1", [entry.id]);
      const verified = await verifyChain(client);
      expect(verified.ok).toBe(false);
      expect(verified.failedSequence).toBe(entry.sequenceNo);
      expect(verified.storedHash).toBe(entry.entryHash);
      expect(verified.recomputedHash).not.toBe(entry.entryHash);
    } finally {
      client.release();
    }
  });
});

function draft(narration, paise) {
  return {
    entryDate: "2026-04-03",
    narration,
    reference: null,
    createdBy: "tester",
    lines: [
      { accountCode: "1110", debitPaise: paise, creditPaise: 0 },
      { accountCode: "3100", debitPaise: 0, creditPaise: paise },
    ],
  };
}

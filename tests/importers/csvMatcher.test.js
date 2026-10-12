import { describe, expect, it } from "vitest";
import { parseBankCsv, parseBankDate } from "../../src/importers/csvBank.js";
import { matchLines, narrationScore } from "../../src/importers/matcher.js";

const thresholds = { windowDays: 3, autoThreshold: 95, suggestThreshold: 70 };

function row(overrides) {
  return {
    rowNumber: 1,
    txnDate: "2026-04-02",
    amountPaise: 50000,
    narration: "Studio rent",
    ...overrides,
  };
}

function journal(overrides) {
  return {
    journalLineId: 1,
    entryDate: "2026-04-02",
    signedPaise: 50000,
    narration: "Studio rent",
    ...overrides,
  };
}

describe("parseBankCsv", () => {
  it("parses day-first dates", () => {
    expect(parseBankDate("2026-04-05")).toBe("2026-04-05");
    expect(parseBankDate("02/04/2026")).toBe("2026-04-02");
    expect(parseBankDate("15-Jun-2026")).toBe("2026-06-15");
    expect(parseBankDate("02-04-26")).toBe("2026-04-02");
    expect(parseBankDate("10/12/2026")).toBe("2026-12-10");
    expect(parseBankDate("32/01/2026")).toBeNull();
    expect(parseBankDate("31/04/2026")).toBeNull();
  });

  it("rejects a missing header without throwing", () => {
    const parsed = parseBankCsv("02/04/2026,Rent,100,,\n");
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].message).toMatch(/Header/);
  });

  it("parses a withdrawal, a deposit, and a BOM", () => {
    const csv = "\uFEFFdate,narration,withdrawal,deposit,balance\n02/04/2026,Rent,\"1,180.50\",,1000.00\n2026-04-05,Receipt,,₹500.00,\n";
    const parsed = parseBankCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ txnDate: "2026-04-02", amountPaise: -118050, bankBalancePaise: 100000 });
    expect(parsed.rows[1]).toMatchObject({ txnDate: "2026-04-05", amountPaise: 50000, bankBalancePaise: null });
  });

  it("reports row errors and keeps the good rows", () => {
    const csv = [
      "date,narration,withdrawal,deposit,balance",
      "02/04/2026,Good,,500.00,",
      "32/01/2026,Bad,10,,",
      "15-Jun-2026,Both,10,10,",
      "2026-04-05,Neither,,,",
      "2026-04-06,Fine,10.999,,",
      "",
      "02-04-26,Also good,250.00,,",
    ].join("\n");
    const parsed = parseBankCsv(csv);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.errors).toHaveLength(4);
    expect(parsed.rows.map((row) => row.amountPaise)).toEqual([50000, -25000]);
  });
});

describe("matchLines", () => {
  it("auto-matches an exact same-day narration", () => {
    const [decision] = matchLines([row({})], [journal({})], thresholds);
    expect(decision).toMatchObject({ status: "matched", journalLineId: 1, score: 100 });
  });

  it("suggests a close narration inside the window and matches a strong one", () => {
    const soft = "payment aws india april";
    const close = "payment aws india may";
    expect(narrationScore(soft, close)).toBeGreaterThanOrEqual(70);
    expect(narrationScore(soft, close)).toBeLessThan(95);
    const suggested = matchLines(
      [row({ txnDate: "2026-04-04", narration: soft })],
      [journal({ entryDate: "2026-04-02", narration: close })],
      thresholds,
    );
    expect(suggested[0]).toMatchObject({ status: "suggested", journalLineId: 1 });

    const strong = matchLines(
      [row({ txnDate: "2026-04-04", narration: "payment aws india april" })],
      [journal({ entryDate: "2026-04-02", narration: "payment aws indai april" })],
      thresholds,
    );
    expect(narrationScore("payment aws india april", "payment aws indai april")).toBeGreaterThanOrEqual(95);
    expect(strong[0].status).toBe("matched");
  });

  it("rejects a four-day gap and a one-rupee difference", () => {
    const late = matchLines(
      [row({ txnDate: "2026-04-06" })],
      [journal({ entryDate: "2026-04-02" })],
      thresholds,
    );
    expect(late[0].status).toBe("unmatched");
    const rupee = matchLines([row({ amountPaise: 50100 })], [journal({ signedPaise: 50000 })], thresholds);
    expect(rupee[0].status).toBe("unmatched");
  });

  it("assigns the closer narration and does not reuse a journal line", () => {
    const base = "payment aws india april";
    const decisions = matchLines(
      [row({ narration: base })],
      [
        journal({ journalLineId: 2, narration: "payment vendor april" }),
        journal({ journalLineId: 1, narration: base }),
      ],
      thresholds,
    );
    expect(decisions[0].status).toBe("suggested");
    expect(decisions[0].journalLineId).toBe(1);
    expect(narrationScore(base, "payment vendor april")).toBeLessThan(narrationScore(base, base) - 9);

    const paired = matchLines(
      [
        row({ rowNumber: 1, narration: "alpha receipt studio" }),
        row({ rowNumber: 2, narration: "beta vendor payout" }),
      ],
      [
        journal({ journalLineId: 11, narration: "beta vendor payout" }),
        journal({ journalLineId: 4, narration: "alpha receipt studio" }),
      ],
      thresholds,
    );
    expect(paired.map((decision) => decision.journalLineId).sort((a, b) => a - b)).toEqual([4, 11]);
    expect(new Set(paired.map((decision) => decision.journalLineId)).size).toBe(2);
  });

  it("does not auto-match an empty narration", () => {
    const one = matchLines([row({ narration: "" })], [journal({})], thresholds);
    expect(one[0]).toMatchObject({ status: "suggested", journalLineId: 1 });
    const two = matchLines(
      [row({ narration: "   " })],
      [journal({ journalLineId: 1 }), journal({ journalLineId: 2, narration: "Studio rent" })],
      thresholds,
    );
    expect(two[0].status).toBe("unmatched");
  });

  it("leaves a narrow lead unmatched and accepts a wide one", () => {
    const narrowBase = "payment aws india april";
    const narrow = matchLines(
      [row({ narration: narrowBase })],
      [
        journal({ journalLineId: 1, narration: "payment awz indai april" }),
        journal({ journalLineId: 2, narration: "pymt aws indai april" }),
      ],
      thresholds,
    );
    const narrowScores = [
      narrationScore(narrowBase, "payment awz indai april"),
      narrationScore(narrowBase, "pymt aws indai april"),
    ].sort((a, b) => b - a);
    expect(narrowScores[0] - narrowScores[1]).toBeLessThan(10);
    expect(narrowScores[0]).toBeGreaterThanOrEqual(70);
    expect(narrow[0].status).toBe("unmatched");

    const wideBase = "payment aws india april";
    const wide = matchLines(
      [row({ narration: wideBase })],
      [
        journal({ journalLineId: 8, narration: "payment aws india may" }),
        journal({ journalLineId: 3, narration: "payment vendor april" }),
      ],
      thresholds,
    );
    const wideScores = [
      narrationScore(wideBase, "payment aws india may"),
      narrationScore(wideBase, "payment vendor april"),
    ].sort((a, b) => b - a);
    expect(wideScores[0] - wideScores[1]).toBeGreaterThanOrEqual(10);
    expect(wide[0]).toMatchObject({ status: "suggested", journalLineId: 8 });
  });

  it("ignores a sign mismatch and a blocked journal line", () => {
    const sign = matchLines([row({ amountPaise: 50000 })], [journal({ signedPaise: -50000 })], thresholds);
    expect(sign[0].status).toBe("unmatched");
    const blocked = matchLines([row({})], [journal({ journalLineId: 9 }), journal({ journalLineId: 4 })], {
      ...thresholds,
      blockedIds: new Set([4]),
    });
    expect(blocked[0]).toMatchObject({ status: "matched", journalLineId: 9 });
  });

  it("skips a pair the reviewer already rejected", () => {
    const [decision] = matchLines([row({ rowNumber: 5 })], [journal({ journalLineId: 3 })], {
      ...thresholds,
      rejectedPairs: new Set(["5:3"]),
    });
    expect(decision.status).toBe("unmatched");
  });

  it("prefers the lower journal line id once a tied sibling is gone", () => {
    const tied = matchLines(
      [row({})],
      [journal({ journalLineId: 20 }), journal({ journalLineId: 7 })],
      thresholds,
    );
    expect(tied[0].status).toBe("unmatched");
    const remaining = matchLines([row({})], [journal({ journalLineId: 20 }), journal({ journalLineId: 7 })], {
      ...thresholds,
      blockedIds: new Set([20]),
    });
    expect(remaining[0]).toMatchObject({ status: "matched", journalLineId: 7 });
  });
});

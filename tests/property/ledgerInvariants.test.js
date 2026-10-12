import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { seedPropertyChart, PROPERTY_ACCOUNTS } from "./chart.js";
import { postEntry } from "../../src/services/posting.js";
import { reverseEntry } from "../../src/services/reversal.js";
import { verifyChain } from "../../src/services/hashing.js";
import { trialBalanceDifference } from "../../src/services/reporting.js";
import { createTestSchema } from "../helpers/db.js";

const CODES = PROPERTY_ACCOUNTS.map((account) => account.code);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ".split("");

const narrationArb = fc
  .array(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(""))
  .filter((value) => value.trim().length > 0);

const commandArb = fc.oneof(
  { weight: 4, arbitrary: balancedEntryArb().map((entry) => ({ kind: "post", entry })) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 40 }).map((index) => ({ kind: "reverse", index })) },
);

describe("ledger invariants", () => {
  it(
    "keeps debits equal to credits after random entries and reversals",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(commandArb, { minLength: 0, maxLength: 8 }), async (commands) => {
          const db = await createTestSchema();
          try {
            const setup = await db.pool.connect();
            try {
              await seedPropertyChart(setup);
            } finally {
              setup.release();
            }
            /** @type {Array<{ id: number, reversed: boolean, lines: Array<{ accountId: number, debitPaise: number, creditPaise: number }> }>} */
            const posted = [];
            for (const command of commands) {
              if (command.kind === "post") {
                const entry = await postEntry(db.pool, {
                  entryDate: command.entry.entryDate,
                  narration: command.entry.narration,
                  reference: null,
                  createdBy: "property",
                  lines: command.entry.lines,
                });
                posted.push({
                  id: entry.id,
                  reversed: false,
                  lines: entry.lines.map((line) => ({
                    accountId: line.accountId,
                    debitPaise: line.debitPaise,
                    creditPaise: line.creditPaise,
                  })),
                });
                continue;
              }
              if (command.index >= posted.length) continue;
              const target = posted[command.index];
              if (target.reversed) continue;
              const reversal = await reverseEntry(db.pool, target.id, {
                entryDate: "2026-09-30",
                narration: "Reverse a random entry",
                createdBy: "property",
              });
              target.reversed = true;
              expect(multiset(reversal.lines)).toEqual(
                multiset(
                  target.lines.map((line) => ({
                    accountId: line.accountId,
                    debitPaise: line.creditPaise,
                    creditPaise: line.debitPaise,
                  })),
                ),
              );
            }
            const client = await db.pool.connect();
            try {
              const sums = await client.query(
                `SELECT COALESCE(SUM(debit_paise), 0)::bigint AS debits,
                        COALESCE(SUM(credit_paise), 0)::bigint AS credits
                 FROM journal_lines`,
              );
              expect(sums.rows[0].debits).toBe(sums.rows[0].credits);
              expect(await trialBalanceDifference(client)).toBe(0);
              const verified = await verifyChain(client);
              expect(verified.ok).toBe(true);
              const counts = await client.query(
                "SELECT COUNT(*)::integer AS n FROM journal_lines GROUP BY entry_id",
              );
              for (const row of counts.rows) expect(row.n).toBeGreaterThanOrEqual(2);
            } finally {
              client.release();
            }
          } finally {
            await db.close();
          }
        }),
        { numRuns: 50, seed: 2026 },
      );
    },
    180000,
  );
});

function balancedEntryArb() {
  return fc.integer({ min: 1, max: 1_000_000 }).chain((total) =>
    fc.integer({ min: 1, max: Math.min(3, total) }).chain((debitCount) =>
      fc.integer({ min: 1, max: Math.min(3, total, 5 - debitCount) }).chain((creditCount) =>
        fc.tuple(
          exactParts(total, debitCount),
          exactParts(total, creditCount),
          fc.shuffledSubarray(CODES, { minLength: CODES.length, maxLength: CODES.length }),
          fc.integer({ min: 0, max: 182 }),
          narrationArb,
        ).map(([debitParts, creditParts, accounts, dayOffset, narration]) => ({
          entryDate: dateFromOffset(dayOffset),
          narration,
          lines: [
            ...debitParts.map((paise, index) => ({
              accountCode: accounts[index],
              debitPaise: paise,
              creditPaise: 0,
            })),
            ...creditParts.map((paise, index) => ({
              accountCode: accounts[debitParts.length + index],
              debitPaise: 0,
              creditPaise: paise,
            })),
          ],
        })),
      ),
    ),
  );
}

function exactParts(total, count) {
  if (count === 1) return fc.constant([total]);
  return fc
    .uniqueArray(fc.integer({ min: 1, max: total - 1 }), { minLength: count - 1, maxLength: count - 1 })
    .map((cuts) => {
      const points = [...cuts].sort((left, right) => left - right);
      const parts = [];
      let previous = 0;
      for (const point of points) {
        parts.push(point - previous);
        previous = point;
      }
      parts.push(total - previous);
      return parts;
    })
    .filter((parts) => parts.length === count && parts.every((part) => part > 0));
}

function dateFromOffset(offset) {
  const date = new Date(Date.UTC(2026, 3, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function multiset(lines) {
  return lines
    .map((line) => `${line.accountId}:${line.debitPaise}:${line.creditPaise}`)
    .sort();
}

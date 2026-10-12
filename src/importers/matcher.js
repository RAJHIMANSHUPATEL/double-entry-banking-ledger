import { token_set_ratio } from "fuzzball";

/**
 * Greedy bank matcher. It does not touch the database.
 *
 * Statement rows are ordered by ascending candidate count, then descending
 * best score, then row number. Candidates for a row are ordered by descending
 * score, then ascending `journalLineId`, so an equal score prefers the lower id.
 * A journal line is consumed at most once in a run.
 *
 * A lead under 10 points stays unmatched, including an exact score tie: the
 * lower id is only the winner once it is the sole remaining candidate (the
 * sibling was blocked or already consumed). Auto-match still requires a single
 * candidate, a score at or above the auto threshold, and two non-empty narrations.
 *
 * @param {Array<{ rowNumber: number, txnDate: string, amountPaise: number, narration: string }>} statementRows
 * @param {Array<{ journalLineId: number, entryDate: string, signedPaise: number, narration: string }>} journalCandidates
 * @param {{ windowDays: number, autoThreshold: number, suggestThreshold: number, blockedIds?: Set<number>, rejectedPairs?: Set<string> }} options
 */
export function matchLines(statementRows, journalCandidates, options) {
  const blockedIds = options.blockedIds ?? new Set();
  const rejectedPairs = options.rejectedPairs ?? new Set();
  const used = new Set();

  const seeded = statementRows.map((row) => {
    const candidates = eligible(row, journalCandidates, blockedIds, rejectedPairs, options.windowDays, used);
    return { row, count: candidates.length, best: candidates[0]?.score ?? -1 };
  });
  seeded.sort((left, right) => right.count - left.count === 0
    ? right.best - left.best || left.row.rowNumber - right.row.rowNumber
    : left.count - right.count);

  /** @type {Map<number, { rowNumber: number, status: string, journalLineId: number | null, score: number | null }>} */
  const decisions = new Map();
  for (const item of seeded) {
    const candidates = eligible(item.row, journalCandidates, blockedIds, rejectedPairs, options.windowDays, used);
    const decision = decide(item.row, candidates, options.autoThreshold, options.suggestThreshold);
    if (decision.journalLineId != null && decision.status !== "unmatched") used.add(decision.journalLineId);
    decisions.set(item.row.rowNumber, decision);
  }
  return statementRows.map((row) => decisions.get(row.rowNumber));
}

/**
 * Lowercased, punctuation stripped, whitespace collapsed. Empty means no auto-match.
 * @param {unknown} value
 */
export function normalizeNarration(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Integer 0–100. Empty text on either side scores 0 and never auto-matches.
 * @param {string} left
 * @param {string} right
 */
export function narrationScore(left, right) {
  const a = normalizeNarration(left);
  const b = normalizeNarration(right);
  if (!a || !b) return 0;
  const raw = token_set_ratio(a, b);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * @param {{ rowNumber: number, txnDate: string, amountPaise: number, narration: string }} row
 * @param {Array<{ journalLineId: number, entryDate: string, signedPaise: number, narration: string }>} journals
 * @param {Set<number>} blockedIds
 * @param {Set<string>} rejectedPairs
 * @param {number} windowDays
 * @param {Set<number>} used
 */
function eligible(row, journals, blockedIds, rejectedPairs, windowDays, used) {
  const found = [];
  for (const journal of journals) {
    if (blockedIds.has(journal.journalLineId) || used.has(journal.journalLineId)) continue;
    if (rejectedPairs.has(`${row.rowNumber}:${journal.journalLineId}`)) continue;
    if (row.amountPaise !== journal.signedPaise) continue;
    if (!datesWithin(row.txnDate, journal.entryDate, windowDays)) continue;
    found.push({
      journalLineId: journal.journalLineId,
      narration: journal.narration,
      score: narrationScore(row.narration, journal.narration),
    });
  }
  found.sort((a, b) => b.score - a.score || a.journalLineId - b.journalLineId);
  return found;
}

/**
 * @param {{ rowNumber: number, narration: string }} row
 * @param {Array<{ journalLineId: number, narration: string, score: number }>} candidates
 * @param {number} autoThreshold
 * @param {number} suggestThreshold
 */
function decide(row, candidates, autoThreshold, suggestThreshold) {
  if (candidates.length === 0) {
    return { rowNumber: row.rowNumber, status: "unmatched", journalLineId: null, score: null };
  }
  const best = candidates[0];
  const runner = candidates[1];
  const lead = runner ? best.score - runner.score : null;
  const statementEmpty = normalizeNarration(row.narration).length === 0;
  const bestEmpty = normalizeNarration(best.narration).length === 0;
  if (candidates.length === 1 && !statementEmpty && !bestEmpty && best.score >= autoThreshold) {
    return { rowNumber: row.rowNumber, status: "matched", journalLineId: best.journalLineId, score: best.score };
  }
  if (statementEmpty || bestEmpty) {
    if (candidates.length === 1) {
      return { rowNumber: row.rowNumber, status: "suggested", journalLineId: best.journalLineId, score: best.score };
    }
    return { rowNumber: row.rowNumber, status: "unmatched", journalLineId: null, score: best.score };
  }
  if (best.score >= suggestThreshold && (lead == null || lead >= 10)) {
    return { rowNumber: row.rowNumber, status: "suggested", journalLineId: best.journalLineId, score: best.score };
  }
  return { rowNumber: row.rowNumber, status: "unmatched", journalLineId: null, score: best.score };
}

/**
 * Inclusive calendar-day window used by import and by a human confirm.
 * @param {string} left
 * @param {string} right
 * @param {number} windowDays
 */
export function datesWithin(left, right, windowDays) {
  return daysApart(left, right) <= windowDays;
}

/**
 * Whole calendar days between two YYYY-MM-DD dates.
 * @param {string} left
 * @param {string} right
 */
function daysApart(left, right) {
  const [ly, lm, ld] = left.split("-").map(Number);
  const [ry, rm, rd] = right.split("-").map(Number);
  const ms = Date.UTC(ly, lm - 1, ld) - Date.UTC(ry, rm - 1, rd);
  return Math.abs(Math.round(ms / 86_400_000));
}

import { createHash } from "node:crypto";

/**
 * SHA-256 of canonical JSON: sorted keys, no insignificant whitespace.
 * Dates must already be ISO strings and paise values must already be integers.
 * @param {unknown} payload
 * @returns {string}
 */
export function requestHash(payload) {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

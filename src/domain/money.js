const PAISA_PER_RUPEE = 100n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const inrFormat = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Assert that a value is an integer paise amount inside the safe integer range.
 * Booleans, strings, and non-integers are rejected.
 * @param {unknown} paise
 * @returns {number}
 */
export function money(paise) {
  if (typeof paise === "boolean" || typeof paise !== "number") {
    throw new TypeError("Paise must be an integer number.");
  }
  if (!Number.isInteger(paise) || !Number.isSafeInteger(paise)) {
    throw new TypeError("Paise must be a safe integer.");
  }
  return paise;
}

/**
 * Parse a rupee display string into integer paise.
 * Strips ₹, Rs, INR, spaces, and Indian commas. At most two fractional digits.
 * The conversion uses integer arithmetic only.
 * @param {unknown} input
 * @returns {number}
 */
export function parseRupees(input) {
  if (typeof input !== "string") {
    throw new TypeError("Rupee amounts must be parsed from a string.");
  }
  let text = input.trim();
  if (text.length === 0) {
    throw new Error("Rupee amount is empty.");
  }
  text = text.replace(/₹/g, "");
  text = text.replace(/INR/gi, "");
  text = text.replace(/Rs\.?/gi, "");
  text = text.replace(/,/g, "");
  text = text.replace(/\s+/g, "");
  if (text.length === 0) {
    throw new Error("Rupee amount is empty.");
  }

  let sign = 1n;
  if (text.startsWith("-")) {
    sign = -1n;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error("Rupee amount is not a decimal number.");
  }

  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? "" : text.slice(dot + 1);
  if (fraction.length > 2) {
    throw new Error("Rupee amount has more than two decimal places.");
  }

  const rupees = BigInt(whole);
  const fractionPaise = BigInt((fraction + "00").slice(0, 2));
  const signed = sign * (rupees * PAISA_PER_RUPEE + fractionPaise);
  if (signed > MAX_SAFE || signed < -MAX_SAFE) {
    throw new Error("Rupee amount is outside the safe integer range.");
  }
  return money(Number(signed));
}

/**
 * Format integer paise as INR with Indian digit grouping.
 * @param {unknown} paise
 * @returns {string}
 */
export function formatInr(paise) {
  const value = money(paise);
  const negative = value < 0;
  const absolute = negative ? -value : value;
  const rupees = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  const asRupees = rupees + fraction / 100;
  return inrFormat.format(negative ? -asRupees : asRupees);
}

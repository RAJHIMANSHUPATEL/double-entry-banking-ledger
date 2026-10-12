import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatInr, money, parseRupees } from "../../src/domain/money.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("money", () => {
  it("accepts safe integers", () => {
    expect(money(0)).toBe(0);
    expect(money(-500050)).toBe(-500050);
    expect(money(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects booleans, strings, and non-integers", () => {
    expect(() => money(true)).toThrow(TypeError);
    expect(() => money(false)).toThrow(TypeError);
    expect(() => money("100")).toThrow(TypeError);
    expect(() => money(1.5)).toThrow(TypeError);
    expect(() => money(Number.NaN)).toThrow(TypeError);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });
});

describe("parseRupees", () => {
  const cases = [
    ["0", 0],
    ["1", 100],
    ["1500.5", 150050],
    ["1500.50", 150050],
    ["₹1,18,000.00", 11800000],
    ["Rs 10", 1000],
    ["-5,000.50", -500050],
  ];

  it.each(cases)("parses %s as %i paise", (input, paise) => {
    expect(parseRupees(input)).toBe(paise);
  });

  it("rejects extra fractional digits, empty input, and malformed decimals", () => {
    expect(() => parseRupees("1500.501")).toThrow(/decimal places/);
    expect(() => parseRupees("")).toThrow(/empty/);
    expect(() => parseRupees("   ")).toThrow(/empty/);
    expect(() => parseRupees("1.2.3")).toThrow(/decimal/);
    expect(() => parseRupees(1500.5)).toThrow(TypeError);
  });
});

describe("formatInr", () => {
  const cases = [
    [0, "₹0.00"],
    [1, "₹0.01"],
    [100, "₹1.00"],
    [123456789, "₹12,34,567.89"],
    [-500050, "-₹5,000.50"],
    [100000000000, "₹1,00,00,00,000.00"],
  ];

  it.each(cases)("formats %i as %s", (paise, display) => {
    expect(formatInr(paise)).toBe(display);
  });
});

describe("money source", () => {
  it("does not call parseFloat", () => {
    const source = readFileSync(path.join(here, "../../src/domain/money.js"), "utf8");
    expect(source).not.toMatch(/parseFloat/);
    expect(source).not.toMatch(/\bfloat\b/);
  });
});

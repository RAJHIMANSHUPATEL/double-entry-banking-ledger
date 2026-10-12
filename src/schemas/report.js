import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const format = z.preprocess(
  (value) => (value == null || value === "" ? "json" : value),
  z.enum(["json", "xlsx"]),
);

/**
 * @param {z.ZodRawShape} shape
 */
function period(shape) {
  return z
    .object({ ...shape, from: isoDate, to: isoDate, format })
    .refine((query) => query.from <= query.to, { message: "from must be on or before to.", path: ["from"] });
}

export const statementQuerySchema = period({});

export const profitAndLossQuerySchema = period({});

export const asOfQuerySchema = z.object({
  as_of: isoDate,
  format,
});

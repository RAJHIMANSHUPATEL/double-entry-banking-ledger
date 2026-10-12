import { z } from "zod";

const paise = z.number().int().safe().gte(0).lte(100000000000000);

export const lineSchema = z
  .object({
    account_code: z.string().trim().min(1).max(16),
    debit_paise: paise,
    credit_paise: paise,
    line_narration: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((line, ctx) => {
    const debit = line.debit_paise > 0 && line.credit_paise === 0;
    const credit = line.credit_paise > 0 && line.debit_paise === 0;
    if (!debit && !credit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set exactly one of debit_paise or credit_paise.",
        path: ["debit_paise"],
      });
    }
  });

export const entryCreateSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  narration: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(64).nullable().optional(),
  lines: z.array(lineSchema).max(50),
});

export const reverseSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  narration: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(64).nullable().optional(),
});

const queryInt = (fallback, min, max) =>
  z.preprocess(
    (value) => (value == null || value === "" ? fallback : value),
    z.coerce.number().int().min(min).max(max),
  );

export const entryListQuerySchema = z.object({
  limit: queryInt(50, 1, 200),
  offset: queryInt(0, 0, Number.MAX_SAFE_INTEGER),
});

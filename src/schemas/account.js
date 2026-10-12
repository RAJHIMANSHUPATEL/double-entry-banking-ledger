import { z } from "zod";

export const accountCreateSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9-]{1,16}$/),
  name: z.string().trim().min(1).max(160),
  type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  parent_code: z.string().trim().min(1).max(16),
  is_group: z.boolean().default(false),
  prevent_overdraft: z.boolean().default(false),
  description: z.string().trim().max(2000).nullable().optional(),
});

import { z } from "zod";

export const bankAccountCodeSchema = z.string().trim().min(1).max(16);

export const statementLinesQuerySchema = z.object({
  status: z.enum(["unmatched", "suggested", "matched", "rejected"]).optional(),
});

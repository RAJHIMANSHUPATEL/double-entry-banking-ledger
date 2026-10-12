import { z } from "zod";

export const bankAccountCodeSchema = z.string().trim().min(1).max(16);

export const confirmBodySchema = z.object({
  journal_line_id: z.number().int().positive().optional(),
});

export const matchBodySchema = z.object({
  journal_line_id: z.number().int().positive(),
});

export const statementLinesQuerySchema = z.object({
  status: z.enum(["unmatched", "suggested", "matched", "rejected"]).optional(),
});

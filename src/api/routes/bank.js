import { z } from "zod";
import { requireActor } from "../actor.js";
import { HttpError, parseWith } from "../errors.js";
import { presentBankLine, presentBankStatement, presentOpenJournalLine } from "../present.js";
import { CsvRejected } from "../../services/exceptions.js";
import { confirmLine, getStatement, importStatement, listOpenJournalLines, listStatementLines, rejectLine, rematchStatement } from "../../services/reconciliation.js";
import { bankAccountCodeSchema, confirmBodySchema, matchBodySchema, statementLinesQuerySchema } from "../../schemas/bank.js";

const idSchema = z.coerce.number().int().positive();

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function registerBankRoutes(app) {
  app.post(
    "/bank-statements",
    { schema: { tags: ["reconciliation"], summary: "Import a bank CSV" } },
    async (request, reply) => {
      const actor = requireActor(request);
      const file = await readUpload(request);
      const statement = await importStatement(app.pg, {
        bankAccountCode: file.bankAccountCode,
        filename: file.filename,
        content: file.content,
        actor,
      });
      reply.code(201);
      return {
        ...presentBankStatement(statement),
        errors: statement.errors,
      };
    },
  );

  app.get(
    "/bank-statements/:id",
    { schema: { tags: ["reconciliation"], summary: "Bank statement summary" } },
    async (request) => {
      const id = parseId(request.params.id);
      const client = await app.pg.connect();
      try {
        return presentBankStatement(await getStatement(client, id));
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/bank-statements/:id/open-journal-lines",
    { schema: { tags: ["reconciliation"], summary: "Unmatched journal lines for this bank account" } },
    async (request) => {
      const id = parseId(request.params.id);
      const client = await app.pg.connect();
      try {
        const lines = await listOpenJournalLines(client, id);
        return { lines: lines.map(presentOpenJournalLine) };
      } finally {
        client.release();
      }
    },
  );

  app.post(
    "/bank-statements/:id/rematch",
    { schema: { tags: ["reconciliation"], summary: "Rematch unmatched and rejected lines" } },
    async (request) => {
      const actor = requireActor(request);
      const id = parseId(request.params.id);
      return presentBankStatement(await rematchStatement(app.pg, id, actor));
    },
  );

  app.post(
    "/bank-statement-lines/:id/confirm",
    { schema: { tags: ["reconciliation"], summary: "Confirm a suggestion" } },
    async (request) => {
      const actor = requireActor(request);
      const id = parseId(request.params.id);
      const body = parseWith(confirmBodySchema, request.body ?? {});
      return presentBankLine(await confirmLine(app.pg, id, actor, body.journal_line_id ?? null));
    },
  );

  app.post(
    "/bank-statement-lines/:id/match",
    { schema: { tags: ["reconciliation"], summary: "Match an unmatched line to a journal line" } },
    async (request) => {
      const actor = requireActor(request);
      const id = parseId(request.params.id);
      const body = parseWith(matchBodySchema, request.body ?? {});
      return presentBankLine(await confirmLine(app.pg, id, actor, body.journal_line_id));
    },
  );

  app.post(
    "/bank-statement-lines/:id/reject",
    { schema: { tags: ["reconciliation"], summary: "Reject a suggestion" } },
    async (request) => {
      const actor = requireActor(request);
      const id = parseId(request.params.id);
      return presentBankLine(await rejectLine(app.pg, id, actor));
    },
  );

  app.get(
    "/bank-statements/:id/lines",
    { schema: { tags: ["reconciliation"], summary: "Bank statement lines" } },
    async (request) => {
      const id = parseId(request.params.id);
      const query = parseWith(statementLinesQuerySchema, request.query ?? {});
      const client = await app.pg.connect();
      try {
        const lines = await listStatementLines(client, id, query.status);
        return { lines: lines.map(presentBankLine) };
      } finally {
        client.release();
      }
    },
  );
}

/**
 * @param {string} value
 */
function parseId(value) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_ERROR", "Statement id must be a positive integer.");
  }
  return parsed.data;
}

/**
 * @param {import('fastify').FastifyRequest} request
 */
async function readUpload(request) {
  let file;
  try {
    file = await request.file();
  } catch {
    throw new CsvRejected("Upload a CSV file in the file field.");
  }
  if (!file) throw new CsvRejected("Upload a CSV file in the file field.");
  const chunks = [];
  for await (const chunk of file.file) chunks.push(chunk);
  if (file.file.truncated) throw new CsvRejected("CSV file is too large.");
  const field = file.fields?.bank_account_code;
  const rawCode = field && "value" in field ? field.value : undefined;
  const bankAccountCode = parseWith(bankAccountCodeSchema, rawCode);
  return {
    bankAccountCode,
    filename: file.filename || "statement.csv",
    content: Buffer.concat(chunks),
  };
}

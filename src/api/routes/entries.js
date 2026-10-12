import { z } from "zod";
import { readIdempotencyKey, requireActor } from "../actor.js";
import { parseWith } from "../errors.js";
import { presentEntry } from "../present.js";
import { requestHash } from "../../services/idempotency.js";
import { EntryNotFound } from "../../services/exceptions.js";
import { listEntries, loadEntry, postEntry } from "../../services/posting.js";
import { reverseEntry } from "../../services/reversal.js";
import { entryCreateSchema, entryListQuerySchema, reverseSchema } from "../../schemas/entry.js";

const idSchema = z.coerce.number().int().positive();

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function registerEntryRoutes(app) {
  app.post("/entries", { schema: { tags: ["entries"], summary: "Post a journal entry" } }, async (request, reply) => {
    const actor = requireActor(request);
    const idempotencyKey = readIdempotencyKey(request);
    const body = parseWith(entryCreateSchema, request.body ?? {});
    const payload = entryPayload(body);
    const result = await postEntry(app.pg, {
      entryDate: payload.entry_date,
      narration: payload.narration,
      reference: payload.reference,
      createdBy: actor,
      lines: payload.lines.map((line) => ({
        accountCode: line.account_code,
        debitPaise: line.debit_paise,
        creditPaise: line.credit_paise,
        lineNarration: line.line_narration,
      })),
      idempotencyKey,
      requestHash: idempotencyKey ? requestHash(payload) : null,
    });
    reply.code(result.replayed ? 200 : 201);
    return presentEntry(result);
  });

  app.get("/entries", { schema: { tags: ["entries"], summary: "List journal entries" } }, async (request) => {
    const query = parseWith(entryListQuerySchema, request.query ?? {});
    const client = await app.pg.connect();
    try {
      const page = await listEntries(client, query);
      return {
        entries: page.entries.map(presentEntry),
        limit: page.limit,
        offset: page.offset,
        total: page.total,
      };
    } finally {
      client.release();
    }
  });

  app.get("/entries/:id", { schema: { tags: ["entries"], summary: "Get one journal entry" } }, async (request) => {
    const id = parseId(request.params.id);
    const client = await app.pg.connect();
    try {
      const entry = await loadEntry(client, id);
      if (!entry) throw new EntryNotFound(id);
      return presentEntry(entry);
    } finally {
      client.release();
    }
  });

  app.post(
    "/entries/:id/reverse",
    { schema: { tags: ["entries"], summary: "Reverse a journal entry" } },
    async (request, reply) => {
      const actor = requireActor(request);
      const idempotencyKey = readIdempotencyKey(request);
      const id = parseId(request.params.id);
      const body = parseWith(reverseSchema, request.body ?? {});
      const payload = {
        entry_id: id,
        entry_date: body.entry_date,
        narration: body.narration,
        reference: body.reference ?? null,
      };
      const result = await reverseEntry(app.pg, id, {
        entryDate: body.entry_date,
        narration: body.narration,
        reference: body.reference ?? null,
        createdBy: actor,
        idempotencyKey,
        requestHash: idempotencyKey ? requestHash(payload) : null,
      });
      reply.code(result.replayed ? 200 : 201);
      return presentEntry(result);
    },
  );
}

function parseId(value) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new EntryNotFound(Number(value) || 0);
  return parsed.data;
}

function entryPayload(body) {
  return {
    entry_date: body.entry_date,
    narration: body.narration,
    reference: body.reference ?? null,
    lines: body.lines.map((line) => ({
      account_code: line.account_code,
      debit_paise: line.debit_paise,
      credit_paise: line.credit_paise,
      line_narration: line.line_narration ?? null,
    })),
  };
}

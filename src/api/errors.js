import { randomUUID } from "node:crypto";
import { LedgerError } from "../services/exceptions.js";

/**
 * Error envelope shared by every HTTP failure.
 * @typedef {{ loc: Array<string | number>, message: string }} FieldIssue
 */

export class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code
   * @param {string} message
   * @param {object | FieldIssue[]} [details]
   */
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {import('zod').ZodTypeAny} schema
 * @param {unknown} value
 */
export function parseWith(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    loc: issue.path,
    message: issue.message,
  }));
  throw new HttpError(422, "VALIDATION_ERROR", "Request failed validation.", details);
}

/**
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {Error & { statusCode?: number, code?: string, details?: unknown }} error
 */
export function sendError(reply, request, error) {
  const requestId = request.requestId ?? "unknown";
  const known = error instanceof HttpError || error instanceof LedgerError;
  if (!known && typeof error.statusCode === "number" && error.statusCode < 500) {
    reply.status(error.statusCode).send({
      error: {
        code: "VALIDATION_ERROR",
        message: error.message,
        details: {},
        request_id: requestId,
      },
    });
    return;
  }
  const statusCode = known ? error.statusCode : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  const message = known ? error.message : "Internal server error.";
  const details = known ? error.details ?? {} : {};
  reply.status(statusCode).send({
    error: {
      code,
      message,
      details,
      request_id: requestId,
    },
  });
}

/**
 * Bind X-Request-Id and a finished-request log line.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerRequestContext(app) {
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && incoming.trim().length > 0 && incoming.length <= 200
        ? incoming.trim()
        : randomUUID();
    request.requestId = requestId;
    reply.header("x-request-id", requestId);
    request.log = request.log.child({ request_id: requestId });
    request.startNs = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (request, reply) => {
    const started = request.startNs ?? process.hrtime.bigint();
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const actor = request.headers["x-actor"];
    request.log.info(
      {
        event: "http_request",
        request_id: request.requestId,
        actor: typeof actor === "string" ? actor : undefined,
        method: request.method,
        path: request.url.split("?")[0],
        status: reply.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
      },
      "http_request",
    );
  });
}

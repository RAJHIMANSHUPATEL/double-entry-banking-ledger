import Fastify from "fastify";
import { config } from "./config.js";
import { HttpError, registerRequestContext, sendError } from "./api/errors.js";
import { createPool } from "./db/pool.js";

/**
 * Build the HTTP application. Routes stay thin; business rules live in services.
 * @param {{ logger?: boolean | object, pool?: import('pg').Pool }} [opts]
 */
export function buildApp(opts = {}) {
  const pool = opts.pool ?? createPool();
  const ownsPool = !opts.pool;
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    requestIdHeader: false,
    genReqId: () => undefined,
  });

  app.decorate("pg", pool);
  registerRequestContext(app);

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    request.log.error({ err: error, request_id: request.requestId }, "request_failed");
    sendError(reply, request, error);
  });

  app.get("/health", async () => {
    try {
      await app.pg.query("SELECT 1");
    } catch {
      throw new HttpError(503, "DATABASE_UNAVAILABLE", "Database check failed.");
    }
    return { status: "ok", database: "ok" };
  });

  app.addHook("onClose", async () => {
    if (ownsPool) await pool.end();
  });

  return app;
}

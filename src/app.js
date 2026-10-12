import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "./config.js";
import { HttpError, registerRequestContext, sendError } from "./api/errors.js";
import { registerAccountRoutes } from "./api/routes/accounts.js";
import { registerAuditRoutes } from "./api/routes/audit.js";
import { registerEntryRoutes } from "./api/routes/entries.js";
import { createPool } from "./db/pool.js";

/**
 * Build the HTTP application. Routes stay thin; business rules live in services.
 * @param {{ logger?: boolean | object, pool?: import('pg').Pool }} [opts]
 */
export async function buildApp(opts = {}) {
  const pool = opts.pool ?? createPool();
  const ownsPool = !opts.pool;
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    requestIdHeader: false,
    genReqId: () => undefined,
  });

  app.decorate("pg", pool);
  registerRequestContext(app);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Paise Ledger",
        description: "Double-entry books for the fictional Anaya Studio. Every name and amount is invented.",
        version: "1.0.0",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get("/openapi.json", async () => app.swagger());
  registerAccountRoutes(app);
  registerEntryRoutes(app);
  registerAuditRoutes(app);

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

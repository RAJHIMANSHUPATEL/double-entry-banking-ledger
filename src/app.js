import Fastify from "fastify";
import { config } from "./config.js";
import { registerRequestContext, sendError } from "./api/errors.js";

/**
 * Build the HTTP application. Routes stay thin; business rules live in services.
 * @param {{ logger?: boolean | object }} [opts]
 */
export function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    requestIdHeader: false,
    genReqId: () => undefined,
  });

  registerRequestContext(app);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, request_id: request.requestId }, "request_failed");
    sendError(reply, request, error);
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  return app;
}

import { buildApp } from "../../src/app.js";
import { seedChart } from "../../src/seed/chart.js";
import { createTestSchema } from "./db.js";

/**
 * API tests talk to Fastify over inject and a private Postgres schema.
 */
export async function createTestApp() {
  const db = await createTestSchema();
  const client = await db.pool.connect();
  try {
    await seedChart(client);
  } finally {
    client.release();
  }
  const app = await buildApp({ pool: db.pool, logger: false });
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export function actorHeaders(extra = {}) {
  return { "x-actor": "reviewer", ...extra };
}

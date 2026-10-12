import { presentEntry, presentReconciliationEvent } from "../present.js";
import { verifyChain } from "../../services/hashing.js";
import { listEntries } from "../../services/posting.js";
import { listReconciliationEvents } from "../../services/reconciliation.js";

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function registerAuditRoutes(app) {
  app.get("/verify-chain", { schema: { tags: ["audit"], summary: "Recompute the hash chain" } }, async () => {
    const client = await app.pg.connect();
    try {
      const result = await verifyChain(client);
      return {
        ok: result.ok,
        entries_checked: result.entriesChecked,
        head_sequence: result.headSequence,
        head_hash: result.headHash,
        ...(result.ok
          ? {}
          : {
              failed_sequence: result.failedSequence,
              stored_hash: result.storedHash,
              recomputed_hash: result.recomputedHash,
            }),
      };
    } finally {
      client.release();
    }
  });

  app.get("/audit", { schema: { tags: ["audit"], summary: "Journal and reconciliation events" } }, async () => {
    const client = await app.pg.connect();
    try {
      const page = await listEntries(client, { limit: 50, offset: 0 });
      const reconciliation = await listReconciliationEvents(client);
      return {
        journal: page.entries.map(presentEntry),
        reconciliation: reconciliation.map(presentReconciliationEvent),
      };
    } finally {
      client.release();
    }
  });
}

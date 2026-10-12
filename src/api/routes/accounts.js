import { parseWith } from "../errors.js";
import { requireActor } from "../actor.js";
import { presentAccount } from "../present.js";
import { accountCreateSchema } from "../../schemas/account.js";
import { createAccount, deactivateAccount, listAccounts } from "../../services/accounts.js";

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function registerAccountRoutes(app) {
  app.get("/accounts", { schema: { tags: ["accounts"], summary: "List accounts" } }, async () => {
    const client = await app.pg.connect();
    try {
      const accounts = await listAccounts(client);
      return { accounts: accounts.map(presentAccount) };
    } finally {
      client.release();
    }
  });

  app.post("/accounts", { schema: { tags: ["accounts"], summary: "Create an account" } }, async (request, reply) => {
    requireActor(request);
    const body = parseWith(accountCreateSchema, request.body);
    const client = await app.pg.connect();
    try {
      const account = await createAccount(client, {
        code: body.code,
        name: body.name,
        type: body.type,
        parentCode: body.parent_code,
        isGroup: body.is_group,
        preventOverdraft: body.prevent_overdraft,
        description: body.description ?? null,
      });
      reply.code(201);
      return { account: presentAccount(account) };
    } finally {
      client.release();
    }
  });

  app.post(
    "/accounts/:code/deactivate",
    { schema: { tags: ["accounts"], summary: "Deactivate an account" } },
    async (request) => {
      requireActor(request);
      const client = await app.pg.connect();
      try {
        const account = await deactivateAccount(client, request.params.code);
        return { account: presentAccount(account) };
      } finally {
        client.release();
      }
    },
  );
}

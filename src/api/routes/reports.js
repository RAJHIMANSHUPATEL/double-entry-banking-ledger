import { parseWith } from "../errors.js";
import {
  presentBalanceSheet,
  presentProfitAndLoss,
  presentStatement,
  presentTrialBalance,
} from "../present.js";
import { asOfQuerySchema, profitAndLossQuerySchema, statementQuerySchema } from "../../schemas/report.js";
import {
  accountStatement,
  balanceSheet,
  profitAndLoss,
  trialBalance,
} from "../../services/reporting.js";
import {
  balanceSheetWorkbook,
  profitAndLossWorkbook,
  statementWorkbook,
  trialBalanceWorkbook,
} from "../../reports/excel.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * @param {import('fastify').FastifyReply} reply
 * @param {string} filename
 * @param {Buffer} body
 */
function sendWorkbook(reply, filename, body) {
  return reply
    .header("content-type", XLSX)
    .header("content-disposition", `attachment; filename="${filename}"`)
    .send(body);
}

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function registerReportRoutes(app) {
  app.get(
    "/accounts/:code/statement",
    { schema: { tags: ["reports"], summary: "Account statement" } },
    async (request, reply) => {
      const query = parseWith(statementQuerySchema, request.query ?? {});
      const client = await app.pg.connect();
      try {
        const report = await accountStatement(client, request.params.code, query.from, query.to);
        if (query.format === "xlsx") {
          const body = await statementWorkbook(report);
          return sendWorkbook(reply, `statement-${report.accountCode}-${query.from}-${query.to}.xlsx`, body);
        }
        return presentStatement(report);
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/reports/trial-balance",
    { schema: { tags: ["reports"], summary: "Trial balance" } },
    async (request, reply) => {
      const query = parseWith(asOfQuerySchema, request.query ?? {});
      const client = await app.pg.connect();
      try {
        const report = await trialBalance(client, query.as_of);
        if (query.format === "xlsx") {
          const body = await trialBalanceWorkbook(report);
          return sendWorkbook(reply, `trial-balance-${query.as_of}.xlsx`, body);
        }
        return presentTrialBalance(report);
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/reports/profit-and-loss",
    { schema: { tags: ["reports"], summary: "Profit and loss" } },
    async (request, reply) => {
      const query = parseWith(profitAndLossQuerySchema, request.query ?? {});
      const client = await app.pg.connect();
      try {
        const report = await profitAndLoss(client, query.from, query.to);
        if (query.format === "xlsx") {
          const body = await profitAndLossWorkbook(report);
          return sendWorkbook(reply, `profit-and-loss-${query.from}-${query.to}.xlsx`, body);
        }
        return presentProfitAndLoss(report);
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/reports/balance-sheet",
    { schema: { tags: ["reports"], summary: "Balance sheet" } },
    async (request, reply) => {
      const query = parseWith(asOfQuerySchema, request.query ?? {});
      const client = await app.pg.connect();
      try {
        const report = await balanceSheet(client, query.as_of);
        if (query.format === "xlsx") {
          const body = await balanceSheetWorkbook(report);
          return sendWorkbook(reply, `balance-sheet-${query.as_of}.xlsx`, body);
        }
        return presentBalanceSheet(report);
      } finally {
        client.release();
      }
    },
  );
}

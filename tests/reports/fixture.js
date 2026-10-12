import { seedChart } from "../../src/seed/chart.js";
import { postEntry } from "../../src/services/posting.js";
import { reverseEntry } from "../../src/services/reversal.js";

/**
 * README worked example, in paise, posted through the service.
 * @param {import('pg').Pool} pool
 */
export async function postWorkedExample(pool) {
  const client = await pool.connect();
  try {
    await seedChart(client);
  } finally {
    client.release();
  }
  await postEntry(pool, {
    entryDate: "2026-04-01",
    narration: "Capital introduced",
    createdBy: "tester",
    lines: [
      { accountCode: "1120", debitPaise: 50000, creditPaise: 0 },
      { accountCode: "3100", debitPaise: 0, creditPaise: 50000 },
    ],
  });
  await postEntry(pool, {
    entryDate: "2026-04-02",
    narration: "Invoice receipt, paid immediately",
    createdBy: "tester",
    lines: [
      { accountCode: "1120", debitPaise: 11800, creditPaise: 0 },
      { accountCode: "4100", debitPaise: 0, creditPaise: 10000 },
      { accountCode: "2210", debitPaise: 0, creditPaise: 900 },
      { accountCode: "2220", debitPaise: 0, creditPaise: 900 },
    ],
  });
  return postEntry(pool, {
    entryDate: "2026-04-03",
    narration: "Rent",
    createdBy: "tester",
    lines: [
      { accountCode: "5200", debitPaise: 5000, creditPaise: 0 },
      { accountCode: "1120", debitPaise: 0, creditPaise: 5000 },
    ],
  });
}

/**
 * @param {import('pg').Pool} pool
 * @param {number} entryId
 */
export function reverseRent(pool, entryId) {
  return reverseEntry(pool, entryId, {
    entryDate: "2026-04-04",
    narration: "Reverse rent",
    createdBy: "tester",
  });
}

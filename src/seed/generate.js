/**
 * Fictional books for Anaya Studio, April–September 2026.
 * Every client, vendor, and rupee amount is invented. See the README disclaimer.
 * The generator posts only through the ledger services. It refuses a database
 * that already has journal entries.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPool } from "../db/pool.js";
import { narrationScore } from "../importers/matcher.js";
import { balancePaise } from "../services/balances.js";
import { verifyChain } from "../services/hashing.js";
import { requestHash } from "../services/idempotency.js";
import { postEntry } from "../services/posting.js";
import { trialBalance } from "../services/reporting.js";
import { reverseEntry } from "../services/reversal.js";
import { seedChart } from "./chart.js";
import { splitGst } from "./gst.js";

const ACTOR = "seed-bot";
const CAPITAL = 50_000_000;
const CLIENTS = ["Sable and Co", "Harbour Lane Goods", "Kite Press", "Niloufer Prints", "Orchard Desk", "Bluepalm Hotels"];
const MONTHS = [4, 5, 6, 7, 8, 9];
const INVOICES_PER_MONTH = [14, 14, 13, 13, 13, 13];
const BILLS_PER_MONTH = [7, 7, 7, 7, 6, 6];
const RESERVED_OPEN = new Set([69, 71, 73, 79]);

/**
 * Deterministic generator. Not Math.random.
 * @param {number} seed
 */
function makeRng(seed) {
  let state = seed >>> 0;
  return {
    /** @param {number} max */
    int(max) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state % max;
    },
    /** @param {unknown[]} list */
    pick(list) {
      return list[this.int(list.length)];
    },
  };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ csvPath?: string }} [options]
 */
export async function generate(pool, options = {}) {
  const csvPath = options.csvPath ?? path.join(process.cwd(), "data", "seed", "hdfc_apr_sep_2026.csv");
  const guard = await pool.connect();
  try {
    const meta = await guard.query("SELECT last_sequence FROM ledger_meta WHERE id = 1");
    if (meta.rows[0].last_sequence > 0) {
      throw new Error("The journal already has entries. Refusing to seed.");
    }
    await seedChart(guard);
  } finally {
    guard.release();
  }

  const rng = makeRng(2026);
  let sequence = 0;
  let bank = 0;
  let invoiceNo = 0;
  let billNo = 0;
  let drawingNo = 0;
  /** @type {{ id: number } | null} */
  let reversible = null;

  /**
   * @param {{ entryDate: string, narration: string, reference: string, lines: Array<{ accountCode: string, debitPaise: number, creditPaise: number, lineNarration?: string }> }} draft
   */
  async function post(draft) {
    for (const line of draft.lines) {
      if (line.accountCode === "1120") bank += line.debitPaise - line.creditPaise;
    }
    if (bank < 0) throw new Error(`Seed would overdraft the bank on ${draft.reference} (${bank} paise).`);
    sequence += 1;
    const key = `seed-${sequence}`;
    return postEntry(pool, {
      entryDate: draft.entryDate,
      narration: draft.narration,
      reference: draft.reference,
      createdBy: ACTOR,
      lines: draft.lines,
      idempotencyKey: key,
      requestHash: requestHash({ key, ...draft }),
    });
  }

  await post({
    entryDate: "2026-04-01",
    narration: "Capital introduced by the owner",
    reference: "CAP-2026-04-01",
    lines: [
      { accountCode: "1120", debitPaise: CAPITAL, creditPaise: 0, lineNarration: "Capital introduced by the owner" },
      { accountCode: "3100", debitPaise: 0, creditPaise: CAPITAL },
    ],
  });

  for (let index = 0; index < MONTHS.length; index += 1) {
    const month = MONTHS[index];
    for (let n = 0; n < INVOICES_PER_MONTH[index]; n += 1) {
      invoiceNo += 1;
      const revenue = 800_000 + rng.int(400_000);
      const gst = splitGst(revenue);
      const gross = revenue + gst.cgst + gst.sgst;
      const immediate = invoiceNo % 10 === 0;
      const reference = `INV-2026-${String(invoiceNo).padStart(3, "0")}`;
      const invoiceDay = 1 + (n % 16);
      await post({
        entryDate: ymd(month, invoiceDay),
        narration: `Invoice ${rng.pick(CLIENTS)} for design work`,
        reference,
        lines: [
          { accountCode: immediate ? "1120" : "1130", debitPaise: gross, creditPaise: 0 },
          { accountCode: "4100", debitPaise: 0, creditPaise: revenue },
          { accountCode: "2210", debitPaise: 0, creditPaise: gst.cgst },
          { accountCode: "2220", debitPaise: 0, creditPaise: gst.sgst },
        ],
      });
      if (!immediate && !RESERVED_OPEN.has(invoiceNo)) {
        await post({
          entryDate: ymd(month, Math.min(lastDay(month), invoiceDay + 2)),
          narration: `Receipt against ${reference}`,
          reference: `RCT-${reference}`,
          lines: [
            { accountCode: "1120", debitPaise: gross, creditPaise: 0, lineNarration: `Receipt against ${reference}` },
            { accountCode: "1130", debitPaise: 0, creditPaise: gross },
          ],
        });
      }
    }

    if (month === 9) {
      await creditNote(pool, post, "INV-2026-069", "2026-09-14", "CN-2026-01", 2);
      await creditNote(pool, post, "INV-2026-071", "2026-09-16", "CN-2026-02", 1);
    }

    for (let n = 0; n < BILLS_PER_MONTH[index]; n += 1) {
      billNo += 1;
      const aws = billNo === 8;
      const net = aws ? 1_876_543 : 400_000 + rng.int(300_000);
      const gst = splitGst(net);
      const gross = net + gst.cgst + gst.sgst;
      const reference = aws ? "BILL-AWS-2026" : `BILL-2026-${String(billNo).padStart(3, "0")}`;
      const narration = aws ? "AWS India" : billNo % 2 === 0 ? "Nimbus Software subscription" : "Pencil Contractors";
      await post({
        entryDate: ymd(month, 4 + n),
        narration,
        reference,
        lines: [
          { accountCode: billNo % 2 === 0 ? "5300" : "5500", debitPaise: net, creditPaise: 0 },
          { accountCode: "1140", debitPaise: gst.cgst, creditPaise: 0 },
          { accountCode: "1150", debitPaise: gst.sgst, creditPaise: 0 },
          { accountCode: "2100", debitPaise: 0, creditPaise: gross },
        ],
      });
      const unpaid = billNo > 38;
      if (!unpaid) {
        await post({
          entryDate: ymd(month, Math.min(lastDay(month), 6 + n)),
          narration,
          reference: aws ? "PAY-AWS-2026" : `PAY-${reference}`,
          lines: [
            { accountCode: "2100", debitPaise: gross, creditPaise: 0 },
            { accountCode: "1120", debitPaise: 0, creditPaise: gross, lineNarration: narration },
          ],
        });
      }
    }

    if (month === 6) {
      await post({
        entryDate: "2026-06-18",
        narration: "Nimbus Software east",
        reference: "PAY-TWIN-A",
        lines: [
          { accountCode: "5300", debitPaise: 2_500_000, creditPaise: 0 },
          { accountCode: "1120", debitPaise: 0, creditPaise: 2_500_000, lineNarration: "Nimbus Software east" },
        ],
      });
      await post({
        entryDate: "2026-06-18",
        narration: "Nimbus Software west",
        reference: "PAY-TWIN-B",
        lines: [
          { accountCode: "5300", debitPaise: 2_500_000, creditPaise: 0 },
          { accountCode: "1120", debitPaise: 0, creditPaise: 2_500_000, lineNarration: "Nimbus Software west" },
        ],
      });
    }

    const rent = 1_800_000 + month * 1_000;
    const rentGst = splitGst(rent);
    await post({
      entryDate: ymd(month, 5),
      narration: "Studio rent",
      reference: `RENT-2026-${String(month).padStart(2, "0")}`,
      lines: [
        { accountCode: "5200", debitPaise: rent, creditPaise: 0 },
        { accountCode: "1140", debitPaise: rentGst.cgst, creditPaise: 0 },
        { accountCode: "1150", debitPaise: rentGst.sgst, creditPaise: 0 },
        { accountCode: "1120", debitPaise: 0, creditPaise: rent + rentGst.cgst + rentGst.sgst, lineNarration: "Studio rent" },
      ],
    });

    const salary = 3_600_000;
    const tds = Math.floor(salary / 10);
    await post({
      entryDate: ymd(month, 26),
      narration: "Salaries for Meera Iyer and Kabir Das",
      reference: `SAL-2026-${String(month).padStart(2, "0")}`,
      lines: [
        { accountCode: "5100", debitPaise: salary, creditPaise: 0 },
        { accountCode: "2300", debitPaise: 0, creditPaise: tds },
        { accountCode: "1120", debitPaise: 0, creditPaise: salary - tds, lineNarration: "Salaries for Meera Iyer and Kabir Das" },
      ],
    });
    await post({
      entryDate: ymd(month, 27),
      narration: "TDS deposit",
      reference: `TDS-2026-${String(month).padStart(2, "0")}`,
      lines: [
        { accountCode: "2300", debitPaise: tds, creditPaise: 0 },
        { accountCode: "1120", debitPaise: 0, creditPaise: tds, lineNarration: "TDS deposit" },
      ],
    });
    await post({
      entryDate: ymd(month, 8),
      narration: "Fibre internet",
      reference: `NET-2026-${String(month).padStart(2, "0")}`,
      lines: [
        { accountCode: "5400", debitPaise: 120_000 + month * 100, creditPaise: 0 },
        { accountCode: "1120", debitPaise: 0, creditPaise: 120_000 + month * 100, lineNarration: "Fibre internet" },
      ],
    });

    if (index < 4) {
      const amount = 20_000 + index * 500;
      await post({
        entryDate: ymd(month, 16),
        narration: "Bank charge booked in the ledger",
        reference: `CHG-2026-${index + 1}`,
        lines: [
          { accountCode: "5600", debitPaise: amount, creditPaise: 0 },
          { accountCode: "1120", debitPaise: 0, creditPaise: amount, lineNarration: "Bank charge booked in the ledger" },
        ],
      });
    }

    for (let n = 0; n < 3; n += 1) {
      const serial = index * 3 + n + 1;
      const amount = serial === 5 ? 654_321 : 20_000 + serial * 250;
      const entry = await post({
        entryDate: ymd(month, 12),
        narration: serial === 5 ? "Paper stock for samples" : "Office supplies",
        reference: `SUP-2026-${String(serial).padStart(2, "0")}`,
        lines: [
          { accountCode: "5700", debitPaise: amount, creditPaise: 0 },
          { accountCode: "1120", debitPaise: 0, creditPaise: amount, lineNarration: serial === 5 ? "Paper stock for samples" : "Office supplies" },
        ],
      });
      if (serial === 1) reversible = entry;
    }

    if (index === 0 && reversible) {
      sequence += 1;
      await reverseEntry(pool, reversible.id, {
        entryDate: "2026-04-13",
        narration: "Reversal of office supplies",
        reference: "REV-SUP-2026-01",
        createdBy: ACTOR,
        idempotencyKey: `seed-${sequence}`,
        requestHash: requestHash({ key: `seed-${sequence}`, entryId: reversible.id, entryDate: "2026-04-13" }),
      });
      bank += 20_000 + 1 * 250;
    }

    drawingNo += 1;
    await post({
      entryDate: ymd(month, 15),
      narration: "Owner drawings",
      reference: `DRW-2026-${String(drawingNo).padStart(2, "0")}`,
      lines: [
        { accountCode: "3200", debitPaise: 500_000 + drawingNo * 10_000, creditPaise: 0 },
        { accountCode: "1120", debitPaise: 0, creditPaise: 500_000 + drawingNo * 10_000, lineNarration: "Owner drawings" },
      ],
    });
    if (index < 2) {
      drawingNo += 1;
      await post({
        entryDate: ymd(month, 22),
        narration: "Owner drawings",
        reference: `DRW-2026-${String(drawingNo).padStart(2, "0")}`,
        lines: [
          { accountCode: "3200", debitPaise: 400_000, creditPaise: 0 },
          { accountCode: "1120", debitPaise: 0, creditPaise: 400_000, lineNarration: "Owner drawings" },
        ],
      });
    }

    if (month === 5 || month === 7) {
      const laptop = month === 5;
      await post({
        entryDate: ymd(month, laptop ? 11 : 9),
        narration: laptop ? "Laptop for the studio" : "Work table and chair",
        reference: laptop ? "EQUIP-LAPTOP" : "EQUIP-DESK",
        lines: [
          { accountCode: laptop ? "1210" : "1220", debitPaise: laptop ? 6_400_000 : 2_200_000, creditPaise: 0 },
          {
            accountCode: "1120",
            debitPaise: 0,
            creditPaise: laptop ? 6_400_000 : 2_200_000,
            lineNarration: laptop ? "Laptop for the studio" : "Work table and chair",
          },
        ],
      });
    }

    if (month >= 5 && month <= 7) {
      const n = month - 4;
      const amount = 40_000 + n * 1_000;
      await post({
        entryDate: ymd(month, 21),
        narration: "Bank interest",
        reference: `INT-2026-${n}`,
        lines: [
          { accountCode: "1120", debitPaise: amount, creditPaise: 0, lineNarration: "Bank interest" },
          { accountCode: "4200", debitPaise: 0, creditPaise: amount },
        ],
      });
    }

    await settleGst(pool, post, month);
  }

  const reader = await pool.connect();
  try {
    const chain = await verifyChain(reader);
    if (!chain.ok) throw new Error(`Seed hash chain failed at sequence ${chain.failedSequence}.`);
    if (chain.entriesChecked < 280 || chain.entriesChecked > 320) {
      throw new Error(`Seed entry count ${chain.entriesChecked} is outside 280–320.`);
    }
    const tb = await trialBalance(reader, "2026-09-30");
    if (tb.differencePaise !== 0) throw new Error(`Seed trial balance difference is ${tb.differencePaise}.`);
    const csv = await buildCsv(reader);
    await mkdir(path.dirname(csvPath), { recursive: true });
    await writeFile(csvPath, csv, "utf8");
    return {
      entries: chain.entriesChecked,
      headSequence: chain.headSequence,
      headHash: chain.headHash,
      debitTotalPaise: tb.debitTotalPaise,
      creditTotalPaise: tb.creditTotalPaise,
      csvPath,
    };
  } finally {
    reader.release();
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {(draft: object) => Promise<unknown>} post
 * @param {string} invoiceRef
 * @param {string} date
 * @param {string} reference
 * @param {number} divisor
 */
async function creditNote(pool, post, invoiceRef, date, reference, divisor) {
  const client = await pool.connect();
  let revenue = 0;
  let cgst = 0;
  let sgst = 0;
  try {
    const result = await client.query(
      `SELECT a.code, l.credit_paise
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
       WHERE e.reference = $1 AND a.code IN ('4100', '2210', '2220')`,
      [invoiceRef],
    );
    for (const row of result.rows) {
      if (row.code === "4100") revenue = row.credit_paise;
      if (row.code === "2210") cgst = row.credit_paise;
      if (row.code === "2220") sgst = row.credit_paise;
    }
  } finally {
    client.release();
  }
  if (revenue <= 0) throw new Error(`Seed could not find ${invoiceRef} for a credit note.`);
  const noteRevenue = Math.floor(revenue / divisor);
  const noteCgst = Math.floor(cgst / divisor);
  const noteSgst = Math.floor(sgst / divisor);
  const gross = noteRevenue + noteCgst + noteSgst;
  await post({
    entryDate: date,
    narration: divisor === 1 ? "Credit note cancelling an unpaid invoice" : "Credit note for a reduced design scope",
    reference,
    lines: [
      { accountCode: "4100", debitPaise: noteRevenue, creditPaise: 0 },
      { accountCode: "2210", debitPaise: noteCgst, creditPaise: 0 },
      { accountCode: "2220", debitPaise: noteSgst, creditPaise: 0 },
      { accountCode: "1130", debitPaise: 0, creditPaise: gross },
    ],
  });
}

/**
 * @param {import('pg').Pool} pool
 * @param {(draft: object) => Promise<unknown>} post
 * @param {number} month
 */
async function settleGst(pool, post, month) {
  const client = await pool.connect();
  /** @type {Record<string, number>} */
  const nets = {};
  try {
    for (const code of ["2210", "2220", "1140", "1150"]) {
      const account = await client.query("SELECT id FROM accounts WHERE code = $1", [code]);
      nets[code] = await balancePaise(client, account.rows[0].id);
    }
  } finally {
    client.release();
  }
  const outputCgst = -nets["2210"];
  const outputSgst = -nets["2220"];
  const inputCgst = nets["1140"];
  const inputSgst = nets["1150"];
  if (outputCgst < 0 || outputSgst < 0 || inputCgst < 0 || inputSgst < 0) {
    throw new Error(`GST balances have an unexpected sign in month ${month}.`);
  }
  const netPay = outputCgst + outputSgst - inputCgst - inputSgst;
  /** @type {Array<{ accountCode: string, debitPaise: number, creditPaise: number, lineNarration?: string }>} */
  const lines = [];
  if (outputCgst > 0) lines.push({ accountCode: "2210", debitPaise: outputCgst, creditPaise: 0 });
  if (outputSgst > 0) lines.push({ accountCode: "2220", debitPaise: outputSgst, creditPaise: 0 });
  if (inputCgst > 0) lines.push({ accountCode: "1140", debitPaise: 0, creditPaise: inputCgst });
  if (inputSgst > 0) lines.push({ accountCode: "1150", debitPaise: 0, creditPaise: inputSgst });
  if (netPay > 0) lines.push({ accountCode: "1120", debitPaise: 0, creditPaise: netPay, lineNarration: "GST settlement" });
  else if (netPay < 0) lines.push({ accountCode: "1120", debitPaise: -netPay, creditPaise: 0, lineNarration: "GST settlement" });
  if (lines.length < 2) throw new Error(`GST settlement for month ${month} has nothing to clear.`);
  await post({
    entryDate: ymd(month, 28),
    narration: "GST settlement",
    reference: `GST-2026-${String(month).padStart(2, "0")}`,
    lines,
  });
}

/**
 * @param {import('pg').PoolClient} client
 */
async function buildCsv(client) {
  const result = await client.query(
    `SELECT e.entry_date, e.narration, e.reference, l.debit_paise, l.credit_paise, l.line_narration
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE a.code = '1120'
     ORDER BY e.entry_date, e.sequence_no, l.line_no`,
  );
  if (!result.rows.some((row) => row.reference === "RENT-2026-09")) {
    throw new Error("Seed CSV is missing referenced voucher RENT-2026-09.");
  }
  /** @type {Array<{ reference: string, date: string, narration: string, signed: number }>} */
  const rows = [];
  for (const row of result.rows) {
    if (row.reference === "RENT-2026-09") continue;
    const signed = row.debit_paise > 0 ? row.debit_paise : -row.credit_paise;
    rows.push({
      reference: row.reference,
      date: row.entry_date,
      narration: row.line_narration || row.narration,
      signed,
    });
  }
  const byRef = (reference) => {
    const found = rows.find((row) => row.reference === reference);
    if (!found) throw new Error(`Seed CSV is missing referenced voucher ${reference}.`);
    return found;
  };
  const aws = byRef("PAY-AWS-2026");
  aws.date = shift(aws.date, 2);
  aws.narration = "AWS Indai";
  if (narrationScore("AWS India", aws.narration) >= 95) {
    aws.narration = "AWS Indyaa";
    if (narrationScore("AWS India", aws.narration) >= 95) {
      throw new Error("AWS narration typo still scores at the auto-match threshold.");
    }
  }
  const drifted = byRef("SUP-2026-05");
  drifted.signed += drifted.signed < 0 ? -100 : 100;
  byRef("NET-2026-06").date = shift(byRef("NET-2026-06").date, 5);
  byRef("INT-2026-1").narration = "";
  const twinA = byRef("PAY-TWIN-A");
  const twinB = byRef("PAY-TWIN-B");
  if (twinA.date !== twinB.date || twinA.signed !== twinB.signed || twinA.narration === twinB.narration) {
    throw new Error("Twin payments are not a same-day equal pair with different narrations.");
  }
  const lines = [
    ...rows,
    { reference: "CSV-CHG-118", date: "2026-06-15", narration: "Bank charge SMS alert", signed: -11800 },
    { reference: "CSV-CHG-59", date: "2026-08-20", narration: "Bank charge annual card", signed: -5900 },
    { reference: "CSV-UNKNOWN", date: "2026-07-03", narration: "NEFT unknown credit", signed: 2_500_000 },
    { ...byRef("CAP-2026-04-01"), reference: "CSV-DUP-CAP" },
  ];
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const body = lines.map((row, index) => {
    const withdrawal = row.signed < 0 ? rupees(-row.signed) : "";
    const deposit = row.signed > 0 ? rupees(row.signed) : "";
    return [formatSeedDate(row.date, index, monthName), csvCell(row.narration), withdrawal, deposit, ""].join(",");
  });
  return ["date,narration,withdrawal,deposit,balance", ...body].join("\n") + "\n";
}

/**
 * @param {string} iso
 * @param {number} index
 * @param {string[]} monthName
 */
function formatSeedDate(iso, index, monthName) {
  const [year, month, day] = iso.split("-");
  const kind = index % 4;
  if (kind === 0) return iso;
  if (kind === 1) return `${day}/${month}/${year}`;
  if (kind === 2) return `${Number(day)}-${monthName[Number(month) - 1]}-${year}`;
  return `${day}-${month}-${year.slice(2)}`;
}

/** @param {string} value */
function csvCell(value) {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

/** @param {number} paise */
function rupees(paise) {
  const whole = Math.trunc(paise / 100);
  const fraction = String(paise % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

/**
 * @param {number} month
 * @param {number} day
 */
function ymd(month, day) {
  const last = lastDay(month);
  const clamped = Math.min(Math.max(day, 1), last);
  return `2026-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/** @param {number} month */
function lastDay(month) {
  return new Date(Date.UTC(2026, month, 0)).getUTCDate();
}

/**
 * @param {string} iso
 * @param {number} days
 */
function shift(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  stamp.setUTCDate(stamp.getUTCDate() + days);
  return stamp.toISOString().slice(0, 10);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const pool = createPool();
  try {
    const summary = await generate(pool);
    console.log(
      `entries ${summary.entries} head_sequence ${summary.headSequence} debit_total_paise ${summary.debitTotalPaise} credit_total_paise ${summary.creditTotalPaise}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

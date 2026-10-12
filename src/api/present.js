import { formatInr } from "../domain/money.js";

/**
 * @param {Awaited<ReturnType<import('../services/posting.js').loadEntry>> & { replayed?: boolean }} entry
 */
export function presentEntry(entry) {
  return {
    id: entry.id,
    sequence_no: entry.sequenceNo,
    entry_date: entry.entryDate,
    narration: entry.narration,
    reference: entry.reference,
    reverses_entry_id: entry.reversesEntryId,
    debit_total_paise: entry.debitTotalPaise,
    credit_total_paise: entry.creditTotalPaise,
    debit_total_display: formatInr(entry.debitTotalPaise),
    credit_total_display: formatInr(entry.creditTotalPaise),
    created_by: entry.createdBy,
    created_at: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : new Date(entry.createdAt).toISOString(),
    prev_hash: entry.prevHash,
    entry_hash: entry.entryHash,
    lines: entry.lines.map((line) => ({
      id: line.id,
      line_no: line.lineNo,
      account_code: line.accountCode,
      account_name: line.accountName,
      debit_paise: line.debitPaise,
      credit_paise: line.creditPaise,
      debit_display: formatInr(line.debitPaise),
      credit_display: formatInr(line.creditPaise),
      line_narration: line.lineNarration,
    })),
  };
}

/**
 * @param {number} paise
 */
function moneyFields(prefix, paise) {
  return {
    [`${prefix}_paise`]: paise,
    [`${prefix}_display`]: formatInr(paise),
  };
}

/**
 * @param {Awaited<ReturnType<import('../services/reporting.js').accountStatement>>} report
 */
export function presentStatement(report) {
  return {
    account_code: report.accountCode,
    account_name: report.accountName,
    account_type: report.accountType,
    from: report.dateFrom,
    to: report.dateTo,
    ...moneyFields("opening", report.openingPaise),
    ...moneyFields("closing", report.closingPaise),
    lines: report.lines.map((line) => ({
      entry_id: line.entryId,
      sequence_no: line.sequenceNo,
      entry_date: line.entryDate,
      narration: line.narration,
      line_narration: line.lineNarration,
      debit_paise: line.debitPaise,
      credit_paise: line.creditPaise,
      debit_display: formatInr(line.debitPaise),
      credit_display: formatInr(line.creditPaise),
      running_paise: line.runningPaise,
      running_display: formatInr(line.runningPaise),
    })),
  };
}

/**
 * @param {Awaited<ReturnType<import('../services/reporting.js').trialBalance>>} report
 */
export function presentTrialBalance(report) {
  return {
    as_of: report.asOf,
    rows: report.rows.map((row) => ({
      code: row.code,
      name: row.name,
      type: row.type,
      debit_paise: row.debitPaise,
      credit_paise: row.creditPaise,
      debit_display: formatInr(row.debitPaise),
      credit_display: formatInr(row.creditPaise),
    })),
    debit_total_paise: report.debitTotalPaise,
    credit_total_paise: report.creditTotalPaise,
    difference_paise: report.differencePaise,
    debit_total_display: formatInr(report.debitTotalPaise),
    credit_total_display: formatInr(report.creditTotalPaise),
  };
}

/**
 * @param {{ code: string, name: string, amountPaise: number, computed?: boolean }} row
 */
function presentAmountRow(row) {
  return {
    code: row.code,
    name: row.name,
    amount_paise: row.amountPaise,
    amount_display: formatInr(row.amountPaise),
    computed: row.computed === true,
  };
}

/**
 * @param {Awaited<ReturnType<import('../services/reporting.js').profitAndLoss>>} report
 */
export function presentProfitAndLoss(report) {
  return {
    from: report.dateFrom,
    to: report.dateTo,
    income: report.income.map(presentAmountRow),
    expenses: report.expenses.map(presentAmountRow),
    income_total_paise: report.incomeTotalPaise,
    expense_total_paise: report.expenseTotalPaise,
    profit_paise: report.profitPaise,
    income_total_display: formatInr(report.incomeTotalPaise),
    expense_total_display: formatInr(report.expenseTotalPaise),
    profit_display: formatInr(report.profitPaise),
  };
}

/**
 * @param {Awaited<ReturnType<import('../services/reporting.js').balanceSheet>>} report
 */
export function presentBalanceSheet(report) {
  return {
    as_of: report.asOf,
    assets: report.assets.map(presentAmountRow),
    liabilities: report.liabilities.map(presentAmountRow),
    equity: report.equity.map(presentAmountRow),
    balances: {
      assets_paise: report.balances.assetsPaise,
      liabilities_paise: report.balances.liabilitiesPaise,
      equity_including_earnings_paise: report.balances.equityIncludingEarningsPaise,
      difference_paise: report.balances.differencePaise,
      assets_display: formatInr(report.balances.assetsPaise),
      liabilities_display: formatInr(report.balances.liabilitiesPaise),
      equity_including_earnings_display: formatInr(report.balances.equityIncludingEarningsPaise),
      difference_display: formatInr(report.balances.differencePaise),
    },
  };
}

/**
 * @param {{ id: number, bankAccountCode: string, sourceFilename: string, uploadedBy: string, uploadedAt: Date | string, rowCount: number, counts: { matched: number, suggested: number, unmatched: number, rejected: number } }} statement
 */
export function presentBankStatement(statement) {
  return {
    id: statement.id,
    bank_account_code: statement.bankAccountCode,
    source_filename: statement.sourceFilename,
    uploaded_by: statement.uploadedBy,
    uploaded_at: statement.uploadedAt instanceof Date ? statement.uploadedAt.toISOString() : new Date(statement.uploadedAt).toISOString(),
    row_count: statement.rowCount,
    counts: statement.counts,
  };
}

/**
 * @param {{ id: number, rowNumber: number, txnDate: string, narration: string, amountPaise: number, bankBalancePaise: number | null, matchStatus: string, matchedJournalLineId: number | null, candidateJournalLineId: number | null, matchScore: number | null }} line
 */
export function presentBankLine(line) {
  return {
    id: line.id,
    row_number: line.rowNumber,
    txn_date: line.txnDate,
    narration: line.narration,
    amount_paise: line.amountPaise,
    amount_display: formatInr(line.amountPaise),
    bank_balance_paise: line.bankBalancePaise,
    bank_balance_display: line.bankBalancePaise == null ? null : formatInr(line.bankBalancePaise),
    match_status: line.matchStatus,
    matched_journal_line_id: line.matchedJournalLineId,
    candidate_journal_line_id: line.candidateJournalLineId,
    match_score: line.matchScore,
  };
}

/**
 * @param {{ journalLineId: number, entryDate: string, signedPaise: number, narration: string }} line
 */
export function presentOpenJournalLine(line) {
  return {
    id: line.journalLineId,
    entry_date: line.entryDate,
    signed_paise: line.signedPaise,
    amount_display: formatInr(line.signedPaise),
    narration: line.narration,
  };
}

/**
 * @param {{ id: number, statementLineId: number, journalLineId: number | null, action: string, score: number | null, actor: string, createdAt: Date | string, note: string | null }} event
 */
export function presentReconciliationEvent(event) {
  return {
    id: event.id,
    statement_line_id: event.statementLineId,
    journal_line_id: event.journalLineId,
    action: event.action,
    score: event.score,
    actor: event.actor,
    created_at: event.createdAt instanceof Date ? event.createdAt.toISOString() : new Date(event.createdAt).toISOString(),
    note: event.note,
  };
}

export function presentAccount(account) {
  return {
    code: account.code,
    name: account.name,
    type: account.type,
    parent_code: account.parentCode,
    is_group: account.isGroup,
    is_active: account.isActive,
    prevent_overdraft: account.preventOverdraft,
    description: account.description,
  };
}

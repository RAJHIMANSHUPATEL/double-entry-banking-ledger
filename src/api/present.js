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
 * @param {{ code: string, name: string, type: string, parentCode: string | null, isGroup: boolean, isActive: boolean, preventOverdraft: boolean, description: string | null }} account
 */
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

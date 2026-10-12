DROP TABLE IF EXISTS reconciliation_events CASCADE;
DROP TABLE IF EXISTS bank_statement_lines CASCADE;
DROP TABLE IF EXISTS bank_statements CASCADE;
DROP TABLE IF EXISTS idempotency_keys CASCADE;
DROP TABLE IF EXISTS journal_lines CASCADE;
DROP TABLE IF EXISTS journal_entries CASCADE;
DROP TABLE IF EXISTS ledger_meta CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;

DROP FUNCTION IF EXISTS assert_journal_entry_complete();
DROP FUNCTION IF EXISTS journal_line_sums_within_header();
DROP FUNCTION IF EXISTS journal_line_account_postable();
DROP FUNCTION IF EXISTS reject_journal_mutation();

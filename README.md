# Paise Ledger

The books are implemented. [plan.md](plan.md) is the phase plan this repository was built from. [BUILD_PROMPT.md](BUILD_PROMPT.md) is the stack this code actually uses.

Paise Ledger is a double-entry banking ledger for one fictional Indian small business. It is a portfolio project. Its job is to show financial-systems correctness, a clean service boundary, and tests that pin the accounting invariants down.

**Every name, GSTIN, account number, invoice, and rupee amount in this project is invented.** Nothing here is a real customer, a real bank account, or a real tax filing.

---

## Problem

Small-business books fail in a few repeatable ways. A posting is saved even though the debits do not equal the credits. A retry from a flaky client creates the same payment twice. Someone edits a posted salary entry in place, and the audit trail is gone. A bank CSV is reconciled by eye, so two identical amounts on the same day get crossed. Money is stored as a binary float, and a paisa disappears at the edge of a rupee.

Paise Ledger treats those as engineering constraints:

- A journal entry is a balanced set of lines, or it is not stored.
- A posted entry is a historical fact. A correction is a new reversing entry.
- Repeating a successful create returns the original result.
- Two overlapping withdrawals cannot both succeed when only one fits in the bank balance.
- Reports are queries over that journal, so the trial balance, the profit and loss statement, and the balance sheet are the same facts seen three ways.
- A bank statement is matched to those facts with explicit rules, and a human confirms anything the rules are unsure about.

The fictional business is **Anaya Studio**, a sole proprietorship in Pune, Maharashtra. Anaya Sharma designs brand identities for clients. The books cover 1 April 2026 through 30 September 2026. The synthetic GSTIN `27AAAAA0000A1Z5` and the bank account `50200011112222` are placeholders. Tax rates in the seed are illustrative: intra-state supplies use CGST 9% and SGST 9%. This dataset is not tax advice and is not a filing.

## What the project demonstrates

- Integer money, with rupee formatting isolated at the display edge.
- A posting service that commits a balanced entry, its hash-chain link, and its idempotency record in one transaction.
- Database constraints and triggers that still reject a bad write when a caller bypasses the service.
- An append-only journal, including a reversal link that does not update the original row.
- A concurrency test in which two withdrawals race and the cash balance never goes negative.
- A fast-check property test: after a random sequence of valid entries and reversals, total debits equal total credits and the trial balance difference is zero.
- Bank CSV matching with planted ambiguities, plus a React desk a reviewer can click through.
- OpenAPI at `/docs`.

## Stack

| Piece | Choice |
| --- | --- |
| Language | Node.js 20+ (Docker image: 22), JavaScript with JSDoc |
| API | Fastify 5, Zod |
| Database | PostgreSQL 16, accessed with `pg` |
| Migrations | Ordered SQL files in `migrations/`, applied by `src/db/migrate.js` |
| Tests | Vitest, v8 coverage, fast-check |
| Matcher | fuzzball `token_set_ratio`, scores stored as integers 0–100 |
| Spreadsheets | exceljs |
| UI | React 18, Vite, React Router. The browser calls `/api`; Vite strips that prefix |
| Packaging | Dockerfile, Dockerfile.web, docker-compose.yml, Makefile |

## Architecture

```mermaid
flowchart TB
  subgraph clients
    UI["React pages"]
  end

  subgraph api_layer ["src/api/"]
    ROUTES["Route handlers"]
    ERRORS["Error envelope and handlers"]
  end

  subgraph domain ["src/services/ + src/reports/ + src/importers/"]
    POST["PostingService"]
    REV["ReversalService"]
    IDEM["IdempotencyService"]
    HASH["HashChain"]
    REC["ReconciliationService"]
    REP["ReportingService"]
    CSV["Bank CSV parser"]
    MATCH["Matcher"]
    MONEY["Money"]
  end

  subgraph storage
    DB[("PostgreSQL")]
  end

  UI -->|"HTTP JSON, paise integers"| ROUTES
  ROUTES --> POST
  ROUTES --> REV
  ROUTES --> REC
  ROUTES --> REP
  POST --> IDEM
  POST --> HASH
  POST --> MONEY
  REV --> POST
  REC --> CSV
  REC --> MATCH
  REP --> DB
  POST --> DB
  REV --> DB
  REC --> DB
  ROUTES --> ERRORS
```

A posting moves through one critical section:

```mermaid
sequenceDiagram
  participant Client
  participant API
  participant Posting
  participant DB

  Client->>API: POST /entries, Idempotency-Key, X-Actor
  API->>Posting: validated command
  Posting->>DB: BEGIN, lock ledger_meta row
  Posting->>DB: look up idempotency key
  alt key already stored for this body
    Posting-->>API: original entry
    API-->>Client: 200 original body
  else new key
    Posting->>Posting: balance, leaf, overdraft checks
    Posting->>Posting: next sequence and SHA-256 link
    Posting->>DB: insert entry, lines, idempotency row, advance ledger_meta
    Posting->>DB: assert line sums equal header
    Posting->>DB: COMMIT
    API-->>Client: 201 entry
  end
```

### Layer rules

| Layer | Responsibility |
| --- | --- |
| `src/api/` | HTTP, status codes, auth-less actor header, OpenAPI. Calls a service and returns JSON. |
| `src/services/` | Transactions, invariants, locking, reversals, idempotency, report figures, reconciliation decisions. |
| `migrations/` | PostgreSQL tables, checks, and triggers. |
| `src/schemas/` | Zod request models. |
| `src/reports/` | Excel workbooks. Figures are computed in services. |
| `src/importers/` | CSV parsing and the pure matching function. |
| `src/domain/` | Integer paise and the UTC clock used by the hash. |
| `web/` | React pages and an HTTP client. Display formatting only. |

Route handlers do not compute balances, compare debits to credits, or score narrations. The React app does not open the database. The browser calls `/api/...`. Vite, in development and in the production preview server, strips that prefix before the request reaches Fastify. `/docs` stays on the API origin.

## Money

One rupee is 100 paise. Persistence, validation, hashing, matching, and totals use JavaScript integers (safe integers only).

`src/domain/money.js` is the only money helper:

- Construct only from a safe integer.
- Parse a rupee string at the edges (CSV cells, React inputs) with `BigInt`, never `parseFloat`.
- Reject a string with more than two decimal places.
- Format with `Intl` for `en-IN` and `INR`: last three digits, then groups of two, always two decimal places, prefix `₹`. Example: `123456789` paise renders as `₹12,34,567.89`. Negative amounts render as `-₹5,000.50`.

The HTTP API accepts and returns paise integers. Responses also carry a `*_display` string produced by `formatInr` so the UI does not reimplement grouping. The integer remains the source of truth. Match scores from fuzzball are rounded to integers immediately. Those scores are not money.

Per-line cap: `10**14` paise (₹1,000 crore). The cap is a sanity check for this SME ledger.

## Data model

Canonical schema for `migrations/0001_init.sql`. Types below are the PostgreSQL forms the migration creates (`integer`, `varchar`, `date`, `timestamptz`, `boolean`, `text`). Deferred constraint triggers reject a commit whose lines do not match the header.

Surrogate keys are integers. Account identity in the API is the stable `code`.

### accounts

| Column | Type | Rules |
| --- | --- | --- |
| `id` | integer PK | |
| `code` | varchar(16) | unique, not null. Seed codes are four digits |
| `name` | varchar(160) | not null |
| `type` | varchar(16) | `asset`, `liability`, `equity`, `income`, `expense` |
| `parent_id` | integer, null | self FK. Null only for the five root nodes |
| `is_group` | boolean | group accounts exist for structure. Lines cannot post to them |
| `is_active` | boolean | inactive accounts reject new lines |
| `prevent_overdraft` | boolean | meaningful for bank and cash assets |
| `description` | text, null | |
| `created_at` | timestamptz | UTC |

Service rules when creating an account: parent exists, child `type` equals parent `type`, parent is a group, the parent chain has no cycle, depth stays within 8.

Leaf posting is also a database trigger on `journal_lines`, so a raw insert into a group or inactive account fails.

### journal_entries

| Column | Type | Rules |
| --- | --- | --- |
| `id` | integer PK | |
| `sequence_no` | integer | unique, not null. Starts at 1. Assigned under the ledger lock |
| `entry_date` | date | accounting date. User supplied. Independent of `created_at` |
| `narration` | text | not null, trimmed, 1–500 characters |
| `reference` | varchar(64), null | invoice or voucher id |
| `reverses_entry_id` | integer, null | FK to `journal_entries.id`. Set on the new reversing entry |
| `debit_total_paise` | integer | `> 0` and `<=` per-line cap times line count, stored for the row check |
| `credit_total_paise` | integer | **CHECK** `credit_total_paise = debit_total_paise` |
| `created_by` | varchar(64) | actor, from `X-Actor` |
| `created_at` | timestamptz | server UTC. Clients cannot send it |
| `prev_hash` | char(64) | hex SHA-256 of the previous entry, or 64 zeroes for the first |
| `entry_hash` | char(64) | unique hex SHA-256 of the canonical content |

Partial unique index `uq_journal_entries_one_reversal` on `reverses_entry_id` where it is not null. An original entry can be reversed once.

There is no `reversed_by_entry_id` column. Writing that back onto the original row would be an update. "Has this been reversed?" is a query: `WHERE reverses_entry_id = :id`.

`BEFORE UPDATE` and `BEFORE DELETE` triggers abort with a fixed message. The same triggers protect `journal_lines`.

### journal_lines

| Column | Type | Rules |
| --- | --- | --- |
| `id` | integer PK | |
| `entry_id` | integer FK | not null |
| `account_id` | integer FK | not null, must be an active leaf at insert time |
| `line_no` | integer | unique with `entry_id`, starts at 1 |
| `debit_paise` | integer | `>= 0` |
| `credit_paise` | integer | `>= 0` |
| `line_narration` | text, null | |

**CHECK** exactly one side is positive:

```text
(debit_paise > 0 AND credit_paise = 0)
OR
(credit_paise > 0 AND debit_paise = 0)
```

An entry has at least two lines. The header totals equal the sum of the lines. Enforcement map:

| Rule | Service, before commit | PostgreSQL |
| --- | --- | --- |
| Header debits equal header credits | yes | CHECK |
| Each line is a single side, non-negative | yes | CHECK |
| Line sums equal the header | yes | deferred constraint trigger |
| At least two lines | yes | deferred constraint trigger |
| Running line sums do not exceed the header | yes | AFTER INSERT trigger |
| Leaf and active account | yes | trigger |
| No UPDATE or DELETE of posted rows | no repository method does this | trigger |
| One reversal per original | yes | partial unique index |
| Idempotency key unique | yes | UNIQUE |
| Overdraft on protected assets | yes, after all lines exist | `SELECT … FOR UPDATE` plus the same check |
| Hash chain | yes | unique `sequence_no` |

A raw SQL session that inserts a header and commits before the lines match is rejected by the deferred trigger. The service also checks the same invariant before commit. Tests run through the service and, separately, through the triggers.

### idempotency_keys

| Column | Type | Rules |
| --- | --- | --- |
| `key` | varchar(128) PK | the `Idempotency-Key` header |
| `request_hash` | char(64) | SHA-256 of the canonical JSON body |
| `entry_id` | integer | unique FK to `journal_entries.id` |
| `created_at` | timestamptz | |

The key is inserted in the same transaction as the entry, and only after the entry is accepted. A rejected body does not consume the key, so the client can correct the payload and retry with the same key.

The hash chain covers the economic content of the entry. It does not cover the idempotency key.

### ledger_meta

One row, `id = 1`, check constraint `id = 1`.

| Column | Type |
| --- | --- |
| `last_sequence` | integer, starts at 0 |
| `last_hash` | char(64), starts as 64 zeroes |

Every posting updates this row. The first update in the transaction is what serializes writers. This table is a cursor. It is allowed to change. The journal is not.

### bank_statements

| Column | Type |
| --- | --- |
| `id` | integer PK |
| `bank_account_id` | FK to a leaf asset account |
| `source_filename` | varchar(255) |
| `uploaded_by` | varchar(64) |
| `uploaded_at` | timestamptz |
| `row_count` | integer |

### bank_statement_lines

| Column | Type | Rules |
| --- | --- | --- |
| `id` | integer PK | |
| `statement_id` | FK | |
| `row_number` | integer | unique with `statement_id` |
| `txn_date` | date | |
| `narration` | text | empty string when the CSV cell is blank |
| `amount_paise` | integer | not zero. Positive means money into the bank (a ledger debit on the asset). Negative means money out (a ledger credit) |
| `bank_balance_paise` | integer, null | stored when the CSV has a balance cell. Not used as a match key |
| `match_status` | varchar(16) | `unmatched`, `suggested`, `matched`, `rejected` |
| `matched_journal_line_id` | FK, null | set only when status is `matched` |
| `candidate_journal_line_id` | FK, null | the suggestion |
| `match_score` | integer, null | 0–100 |
| `raw_json` | text | original cells |

Partial unique index on `matched_journal_line_id` where it is not null. One journal line pairs with at most one statement line.

CHECK: status `matched` implies `matched_journal_line_id` is not null. Any other status implies it is null.

### reconciliation_events

Append-only log of matcher and human decisions.

| Column | Type |
| --- | --- |
| `id` | integer PK |
| `statement_line_id` | FK |
| `journal_line_id` | FK, null |
| `action` | `auto_match`, `suggest`, `confirm`, `reject`, `manual_match` |
| `score` | integer, null |
| `actor` | varchar(64) |
| `created_at` | timestamptz |
| `note` | text, null |

UPDATE and DELETE on this table are aborted by trigger. The audit page reads `journal_entries` and `reconciliation_events` in time order.

```mermaid
erDiagram
  accounts ||--o{ accounts : parent
  accounts ||--o{ journal_lines : posted_to
  journal_entries ||--|{ journal_lines : contains
  journal_entries |o--o| journal_entries : reverses
  journal_entries ||--o| idempotency_keys : recorded_as
  accounts ||--o{ bank_statements : holds
  bank_statements ||--|{ bank_statement_lines : contains
  journal_lines |o--o| bank_statement_lines : matched
  bank_statement_lines ||--o{ reconciliation_events : decided_by
```

## Chart of accounts

Postings hit leaf accounts only. Group rows are parents.

Normal presentation, derived from `type` in reports (it is not a stored column, so it cannot drift):

| Type | Balance shown as |
| --- | --- |
| asset, expense | debits minus credits |
| liability, equity, income | credits minus debits |

Owner's drawings are an equity leaf. A drawing is a debit, so its equity presentation is negative, which reduces capital on the balance sheet. That is the whole of the contra-equity treatment. There is no sixth account type.

| Code | Name | Type | Group | Overdraft lock |
| --- | --- | --- | --- | --- |
| 1000 | Assets | asset | yes | |
| 1100 | Current Assets | asset | yes | |
| 1110 | Cash in Hand | asset | | yes |
| 1120 | Bank — HDFC Current Account | asset | | yes |
| 1130 | Accounts Receivable — Trade | asset | | |
| 1140 | Input CGST | asset | | |
| 1150 | Input SGST | asset | | |
| 1160 | Input IGST | asset | | |
| 1170 | TDS Receivable | asset | | |
| 1200 | Non-current Assets | asset | yes | |
| 1210 | Computer Equipment | asset | | |
| 1220 | Furniture and Fixtures | asset | | |
| 2000 | Liabilities | liability | yes | |
| 2100 | Accounts Payable — Trade | liability | | |
| 2210 | Output CGST | liability | | |
| 2220 | Output SGST | liability | | |
| 2230 | Output IGST | liability | | |
| 2300 | TDS Payable | liability | | |
| 2400 | Salary Payable | liability | | |
| 3000 | Equity | equity | yes | |
| 3100 | Owner's Capital | equity | | |
| 3200 | Owner's Drawings | equity | | |
| 4000 | Income | income | yes | |
| 4100 | Design Service Revenue | income | | |
| 4200 | Interest Income | income | | |
| 5000 | Expenses | expense | yes | |
| 5100 | Salaries and Wages | expense | | |
| 5200 | Rent | expense | | |
| 5300 | Software Subscriptions | expense | | |
| 5400 | Internet and Utilities | expense | | |
| 5500 | Contract Professional Fees | expense | | |
| 5600 | Bank Charges | expense | | |
| 5700 | Office Supplies | expense | | |

People named in the seed (Rohan Kulkarni, Meera Joshi, client brands, vendors) are fictional.

## Journal behaviour

### Create

`POST /entries` body:

- `entry_date`
- `narration`
- `reference` optional
- `lines`: at least 2, at most 50. Each line has `account_code`, exactly one of `debit_paise` / `credit_paise`, optional `line_narration`

Headers:

- `X-Actor` required on every mutating request. Pattern: letters, digits, `_`, `.`, `-`, length 1–64.
- `Idempotency-Key` optional. When present, 1–128 characters from the same pattern plus `:`.
- `X-Request-Id` optional. The server generates one when absent and echoes it.

The service, inside one transaction:

1. Take the ledger lock (see Concurrency).
2. If an idempotency key was sent, look it up. Matching request hash: return the stored entry and commit nothing new. Different hash: abort with `IDEMPOTENCY_CONFLICT`.
3. Resolve account codes. Unknown, group, or inactive accounts abort.
4. Require two or more lines, integer paise, exactly one side per line, and `sum(debit_paise) = sum(credit_paise) > 0`.
5. For each protected asset, `current_balance + effect_of_this_entry >= 0`. Balance of an asset is `sum(debit_paise - credit_paise)` over posted lines. A failure aborts with `OVERDRAFT` and the account code, the current balance, and the attempted effect.
6. Read `ledger_meta`, assign `sequence_no = last_sequence + 1`, compute hashes.
7. Insert the entry, the lines, and the idempotency row when a key was sent.
8. Re-read line sums and line count. They must equal the header and be at least 2. This is the in-transaction assertion.
9. Advance `ledger_meta.last_sequence` and `last_hash`.
10. Commit.

Any failure rolls the whole transaction back. A failed request leaves no entry, no lines, no idempotency row, and an unchanged hash head.

### Reverse

`POST /entries/{id}/reverse` with a narration, an entry date, `X-Actor`, and an optional idempotency key.

The new entry contains the same accounts with debit and credit swapped, `reverses_entry_id` set to the original, and its own sequence and hash. The original row is not modified.

A second reversal of the same original fails with `ALREADY_REVERSED` because of the partial unique index.

Reversals skip the overdraft refusal. Reversing a deposit after the money has been spent can leave cash negative; that negative balance is the signal that the books need a further real entry. The service logs `overdraft_on_reversal`. New entries that are not reversals still refuse an overdraft. A reversal of a reversal is just another reversal pointing at the reversing entry, and it is allowed once.

### Idempotency

Canonical request hash: SHA-256 over UTF-8 JSON with sorted keys, no insignificant whitespace, integers for every paise field, ISO dates. Key lookup happens only after the ledger lock is held, so two concurrent retries serialize behind `ledger_meta`.

| Situation | Result |
| --- | --- |
| No header | Post normally |
| New key, valid body | 201 and store the key |
| Same key, same body, after the first commit | 200 and the original entry. Sequence is unchanged |
| Same key, different body | 409 `IDEMPOTENCY_CONFLICT` |
| Same key, first attempt was rejected as unbalanced or overdrawn | Treated as a new key. The first attempt stored nothing |

### Concurrency

The hash chain needs a single total order, so postings share one global lock: the `ledger_meta` row.

The first statement in the posting transaction is `SELECT … FROM ledger_meta WHERE id = 1 FOR UPDATE`. The second writer waits, then re-reads balances.

Disjoint accounts still queue. That is the cost of one audit chain. A later design can shard chains per book once a single business ledger is no longer the goal.

### Hash chain

Canonical UTF-8 string, versioned so the format can change later:

```text
v1|{sequence_no}|{entry_date}|{narration}|{reference}|{reverses_entry_id}|{created_by}|{created_at}|{prev_hash}|{lines}
```

- `entry_date` is `YYYY-MM-DD`.
- Empty reference is an empty field, not the word null.
- Empty `reverses_entry_id` is an empty field.
- `created_at` is UTC `YYYY-MM-DDTHH:MM:SSZ` (seconds, no microseconds in the hash input; the stored timestamp is truncated to seconds before insert).
- `lines` are in `line_no` order, joined by `;`, each `line_no:account_id:debit_paise:credit_paise:line_narration` with `%` and `;` percent-encoded inside narrations.
- `prev_hash` for sequence 1 is 64 zeroes.
- `entry_hash` is the hex SHA-256 of that string.

`GET /verify-chain` walks `sequence_no` order, recomputes each hash, and checks `prev_hash` equals the previous `entry_hash`. Response is always HTTP 200:

```json
{"ok": true, "entries_checked": 301, "head_sequence": 301, "head_hash": "..."}
```

On a break, `ok` is false and the body includes the first bad `sequence_no`, the stored hash, and the recomputed hash. Verification is read-only and takes no ledger lock beyond a normal read.

## Reports

All report queries filter on `entry_date`. They include reversing entries as ordinary lines, which is what makes a reversal show up correctly.

### Account statement

`GET /accounts/{code}/statement?from=&to=`

Opening balance is the net of lines with `entry_date < from`. Each line in range updates a running balance. Debit-normal accounts (asset, expense) add debits and subtract credits. Credit-normal accounts do the opposite. The response includes opening, lines, and closing, in paise and display strings.

### Trial balance

`GET /reports/trial-balance?as_of=`

One row per leaf that has a non-zero net, or that had activity on or before `as_of`. The net sits in the debit column or the credit column. Grand debit paise equals grand credit paise. The API includes `difference_paise`, which is 0 when the book is consistent.

### Profit and loss

`GET /reports/profit-and-loss?from=&to=`

Income leaves: credits minus debits in the window. Expense leaves: debits minus credits. Net profit is income minus expense, in paise. A sales return is a debit to revenue and reduces income. No closing journal is required for the report.

### Balance sheet

`GET /reports/balance-sheet?as_of=`

- Assets: debit minus credit, as of the date.
- Liabilities: credit minus debit.
- Equity accounts: credit minus debit, so drawings reduce equity.
- Current earnings: income minus expense for every entry with `entry_date <= as_of`. There is no separate retained-earnings close in this version. Earnings sit in the equity section as a computed row, `Current earnings`.
- The report includes `balances` with `assets_paise`, `liabilities_paise`, `equity_including_earnings_paise`, and `difference_paise`. A consistent book has `difference_paise = 0`.

### Worked example the report tests must pin

Amounts in paise.

| Entry | Lines |
| --- | --- |
| Capital | Dr 1120 `50000`, Cr 3100 `50000` |
| Invoice receipt, paid immediately | Dr 1120 `11800`, Cr 4100 `10000`, Cr 2210 `900`, Cr 2220 `900` |
| Rent, no GST in this fixture | Dr 5200 `5000`, Cr 1120 `5000` |

Trial balance nets: Bank `56800` debit, Capital `50000` credit, Revenue `10000` credit, Output CGST `900` credit, Output SGST `900` credit, Rent `5000` debit. Debit total `61800`, credit total `61800`.

P&L: income `10000`, expense `5000`, profit `5000`.

Balance sheet: assets `56800`. Liabilities `1800`. Equity capital `50000` plus earnings `5000`. Difference `0`.

### Excel

`format=xlsx` on each report endpoint returns a workbook. Each sheet has a display column formatted as INR and a paise integer column. The paise column is what a reviewer ties back to the database.

## Bank reconciliation

### CSV

UTF-8, optional BOM. Header required:

```text
date,narration,withdrawal,deposit,balance
```

A row has a withdrawal or a deposit, not both, not neither. Amounts are rupee strings (`500000.00`, `1,18,000.00`, `₹1,180.00`). Parsing goes through `Money`. More than two decimal places rejects that row.

Date parsing is day-first, which matches Indian statements:

| Cell | Date |
| --- | --- |
| `2026-04-05` | 5 April 2026 |
| `02/04/2026` | 2 April 2026 |
| `15-Jun-2026` | 15 June 2026 |
| `02-04-26` | 2 April 2026 |

`10/12/2026` is 10 December 2026. A cell whose first number is greater than 12 and whose second number is a month is still day-first and parses. A cell that parses under neither ISO, `DD/MM/YYYY`, `DD-MM-YYYY`, `DD-Mon-YYYY`, nor the two-digit-year forms is a row error.

The import response lists accepted lines and rejected rows with reasons. One bad row does not discard the file. Zero accepted rows is HTTP 422.

### Match

Candidates are unmatched journal lines on that bank account where:

- the absolute paise equals the statement line, and
- the statement sign agrees with the ledger side (positive statement amount with a debit, negative with a credit), and
- `entry_date` is within three calendar days either way, inclusive, and
- the journal line is not already matched, and
- this statement line has not already rejected that journal line.

Narration score is `Math.round(fuzzball.token_set_ratio(...))`, clamped to 0–100, after lowercasing, collapsing whitespace, and stripping punctuation. The ledger narration is `line_narration` when present, otherwise the entry narration.

Assignment is greedy, most specific first: fewer candidates, then higher score. A journal line is consumed at most once inside a run.

| Outcome | Condition |
| --- | --- |
| `matched` (auto) | exactly one remaining candidate, score >= 95, both narrations non-empty |
| `suggested` | a unique best candidate with score >= 70, leading the runner-up by at least 10 points, or a single candidate with an empty narration |
| `unmatched` | no candidate, or the top two are within 9 points, or the best score is below 70 |

Empty narration never auto-matches. Exact amount is mandatory. A ₹1 difference is unmatched even when the words are identical. A date four or more days away is unmatched even when the words are identical.

### Human decisions

- Confirm a suggestion, or confirm an unmatched line by naming a journal line. Status becomes `matched`. A journal line already taken returns 409 `ALREADY_MATCHED`.
- Reject a suggestion. Status becomes `rejected`. The pair is recorded and will not be suggested again. `POST /bank-statements/{id}/rematch` may suggest a different line.
- Manual match uses the same uniqueness rule as confirm.

## HTTP API

Base URL in development: `http://localhost:3000`. Interactive docs: `GET /docs`. Schema: `GET /openapi.json`.

| Method | Path | Success |
| --- | --- | --- |
| GET | `/health` | 200 `{status, database}` |
| GET | `/accounts` | 200 tree or flat list with `parent_code` |
| POST | `/accounts` | 201 |
| POST | `/accounts/{code}/deactivate` | 200. Refuses a group that still has active children |
| GET | `/accounts/{code}/statement` | 200 or xlsx |
| POST | `/entries` | 201, or 200 on idempotent replay |
| GET | `/entries` | 200 paginated, `limit` default 50, max 200 |
| GET | `/entries/{id}` | 200 |
| POST | `/entries/{id}/reverse` | 201, or 200 on replay |
| GET | `/reports/trial-balance` | 200 or xlsx |
| GET | `/reports/profit-and-loss` | 200 or xlsx |
| GET | `/reports/balance-sheet` | 200 or xlsx |
| POST | `/bank-statements` | multipart file plus `bank_account_code`, 201 |
| GET | `/bank-statements/{id}` | 200 with counts by status |
| GET | `/bank-statements/{id}/lines?status=` | 200 |
| POST | `/bank-statements/{id}/rematch` | 200 |
| POST | `/bank-statement-lines/{id}/confirm` | 200 |
| POST | `/bank-statement-lines/{id}/reject` | 200 |
| POST | `/bank-statement-lines/{id}/match` | 200 body `{journal_line_id}` |
| GET | `/verify-chain` | 200 |
| GET | `/audit` | 200 journal events and reconciliation events |

### Error envelope

Every error uses this shape, including validation errors (a Fastify status below 500 becomes `VALIDATION_ERROR`):

```json
{
  "error": {
    "code": "UNBALANCED_ENTRY",
    "message": "Debits (150000 paise) do not equal credits (140000 paise).",
    "details": {"debit_paise": 150000, "credit_paise": 140000},
    "request_id": "..."
  }
}
```

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 422 | Zod, or a malformed query |
| `UNBALANCED_ENTRY` | 422 | Debits differ from credits, or fewer than two lines |
| `ACCOUNT_NOT_FOUND` | 404 | Unknown code |
| `ACCOUNT_NOT_POSTABLE` | 422 | Group or inactive account |
| `OVERDRAFT` | 422 | Protected asset would go negative |
| `IDEMPOTENCY_CONFLICT` | 409 | Same key, different body |
| `ENTRY_NOT_FOUND` | 404 | |
| `ALREADY_REVERSED` | 409 | |
| `ALREADY_MATCHED` | 409 | Journal line or statement line already matched |
| `STATEMENT_NOT_FOUND` | 404 | |
| `CSV_REJECTED` | 422 | No usable rows, or not a CSV |
| `ACTOR_REQUIRED` | 400 | Missing `X-Actor` on a write |

Logs are JSON via pino: `request_id`, `actor`, event name, `entry_id`, `sequence_no`, `duration_ms`. Log lines do not include full narrations from the bank CSV at info level.

## Seed data

`npm run seed` (and `make seed`) fills a migrated database. The planted file `data/seed/hdfc_apr_sep_2026.csv` is committed with the repository.

The generator uses a deterministic linear congruential generator seeded with 2026 (`Math.imul` by 1664525). The books and the CSV are stable across runs. It posts about 300 journal entries from 1 April 2026 through 30 September 2026. The acceptable band in the test that guards the generator is 280–320 entries. A checked run printed 297 entries, with debit and credit totals both `130564558` paise. The chain verifies afterwards, and the trial balance difference is 0.

Shape of the story, tuned inside the generator so the count lands in range:

| Activity | Rough count of entries |
| --- | --- |
| Capital introduction, 1 April, ₹5,00,000 into the bank | 1 |
| Client invoices, intra-state, revenue plus output CGST and SGST, mostly to accounts receivable | ~70 |
| Receipts of most of those invoices | ~60 |
| Two credit notes | 2 |
| Vendor bills (software, contractors), input GST, accounts payable | ~36 |
| Vendor payments, two left unpaid at 30 September | ~34 |
| Monthly rent with input GST | 6 |
| Monthly salaries for two fictional employees, with a flat illustrative TDS withheld | 6 |
| Monthly internet | 6 |
| Quarterly-style GST settlement each month: clear output against input, pay the net from the bank | 6 |
| TDS deposits | 6 |
| Owner drawings | 8 |
| Equipment and furniture purchases | 2 |
| Interest income | 3 |
| Office supplies and a few bank charges that do exist in the books | ~20 |

The bank CSV is built from lines that hit account `1120`, then edited with a fixed discrepancy recipe:

| # | What is planted | Expected matcher result |
| --- | --- | --- |
| 1 | Bank charge ₹118.00 on 15 June 2026 present only on the statement | unmatched |
| 2 | Bank charge ₹59.00 on 20 August 2026 present only on the statement | unmatched |
| 3 | Incoming ₹25,000.00 on 3 July 2026 with narration `NEFT unknown credit` | unmatched |
| 4 | September rent payment omitted from the CSV (outstanding in the books) | a ledger line with no statement line |
| 5 | One vendor payment dated two days later, narration `AWS Indai` against ledger `AWS India` | suggested |
| 6 | Two same-day payments of equal rupees and different narrations | each matches its own line |
| 7 | One statement amount ₹1.00 away from the ledger | unmatched |
| 8 | One statement date five days outside the ledger date | unmatched |
| 9 | One exact amount and date with a blank narration | suggested, never auto-matched |
| 10 | A duplicated statement row | the second copy stays unmatched because the journal line is consumed |
| 11 | Mixed date formats across the file | all of those rows parse |

The seed command refuses to run against a database that already has journal entries, so it cannot double-post a demo.

## React UI

`web/` is a Vite application. In development it listens on port 5173 and proxies `/api` to the Fastify process, stripping the prefix. The actor name is stored in `sessionStorage` under `actor` and sent as `X-Actor`. Rupee inputs call `parseRupees` from `src/domain/money.js`. Tables show the API's display strings.

| Page | What the user can do |
| --- | --- |
| Dashboard | Cash, bank, receivable, and month-to-date profit as metrics. A monthly income-versus-expense chart for the six seed months. The latest entries |
| Post Entry | Date, narration, reference, dynamic lines, live debit and credit totals, submit. The idempotency key is a UUID generated when the form opens, so a double click replays |
| Account Statement | Account, date range, running balance, Excel download |
| Trial Balance | As-of date, debit and credit totals, Excel download. P&L and balance sheet sit on this page as two further sections so the navigation stays inside the six requested screens |
| Reconciliation | Upload CSV, then lists for matched, suggested (confirm and reject), and unmatched (manual match) |
| Audit Log | Posted entries with actor, time, reversal link, and short hash. A verify button shows the chain result. Reconciliation events sit under the entries |

Rupee inputs are parsed with `Money` before the request is sent. The tables show the API's display strings.

Dashboard sketch after the seed has been loaded:

```text
Anaya Studio books                         actor: reviewer
Cash in hand     HDFC bank        Receivable       Profit, September
₹xx,xxx.xx       ₹x,xx,xxx.xx     ₹xx,xxx.xx       ₹xx,xxx.xx

Monthly income vs expense, April–September
[ bar chart ]

Latest entries
date        narration                     debit total
```

## Design decisions and trade-offs

### Integer paise

Addition, equality, and the overdraft check have to be exact. Paise are already the smallest unit in these books, so an integer is the stored amount. A rupee string is parsed with `BigInt` at the edge, and the result is an integer before it reaches a service. Display grouping, including lakhs and crores, happens when a string is built for a person or a spreadsheet. The database never sees a rupee float, and the journal hash is computed from the integers.

### Append-only journal

A posted line is a claim about the past: who recorded it, when, and what the hash chain said at the time. Corrections are new entries whose `reverses_entry_id` names the original. The original narration, actor, time, and hash stay queryable. Triggers refuse UPDATE and DELETE so a later feature cannot quietly grow an "edit voucher" path. Account metadata (name, active flag) can still change, because the chart is reference data. The audit of a posting is the posting.

The cost is storage and a stricter support workflow. You cannot patch a typo in a narration. You reverse and re-post. That is the workflow the UI should teach.

### Idempotency keys

Create is the operation a client will retry. The key is stored with a hash of the body in the same commit as the entry, after the ledger lock is held. A retry with the same body observes the first commit and returns it. A retry with a different body is a conflict, because silently posting the second meaning would hide a client bug. Keys are not burned by validation failures, because the user still needs to fix the form and submit it.

The header is optional so a script that posts once and does not retry stays easy to write. The post-entry form always sends one. The key is a UUID held in component state and replaced only after a successful post, so a rejected form retries with the same key.

### Concurrency

Two correct balances, computed a moment apart, can both believe the bank has the cash. The posting transaction locks `ledger_meta` with `SELECT … FOR UPDATE` and holds that row until commit. The loser then sees the winner's balance and, in the overdraft test, receives `OVERDRAFT`.

A single global lock also gives the hash chain a unique `prev_hash`. Finer locks per account would allow overlapping posts on disjoint accounts and would race the chain. One lock is the right scope while there is one chain per database. Throughput is one posting commit at a time, which is enough for the books of a studio this size.

### Other decisions that the plan treats as fixed

- Leaf-only posting, with group accounts for the chart.
- Server-set `created_at`. User-set `entry_date`.
- No user accounts and no passwords in this version. `X-Actor` is a displayed name, not a proof of identity.
- Reversals may drive a protected account negative. Ordinary entries may not.
- Day-first dates in bank CSVs.
- Reports compute current earnings in memory. They do not post closing journals.
- PostgreSQL is the only database. Compose starts `postgres:16-alpine`. Deferred triggers are part of the migration, and the tests run against PostgreSQL.
- The public API speaks paise. Rupee strings are an edge concern of CSV import and the React forms.

## Testing

| Area | What it locks |
| --- | --- |
| `tests/unit/money.test.js` | Parsing, rejection of extra decimal places, lakh grouping, negative display |
| `tests/unit/posting.test.js` | Balance, minimum lines, leaf and inactive accounts, overdraft, rollback cleanliness, trigger refusal of UPDATE and DELETE |
| `tests/unit/reversal.test.js` | Swapped lines, link, second reversal refused, reversal allowed when it overdrafts |
| `tests/unit/idempotency.test.js` | Replay, conflict, key not burned by a 422, sequence unchanged on replay |
| `tests/unit/hashChain.test.js` | Known canonical string, tamper detection, verify endpoint service |
| `tests/property/ledgerInvariants.test.js` | fast-check: random valid entries and reversals, debits equal credits, trial balance difference 0, chain ok |
| `tests/concurrency/concurrentPosting.test.js` | Two clients withdraw the full cash balance, one success, balance never negative |
| `tests/importers/csvMatcher.test.js` | Duplicate amounts, same-day pairs, blank narration, date formats, ±3 day window, ₹1 miss, unique assignment |
| `tests/reports/reports.test.js` | The worked example above, plus a reversal flowing through P&L |
| `tests/api/` | Envelope, status codes, OpenAPI route presence |

Coverage gate: 85% line coverage on `src/services`, `src/importers`, and `src/reports`, with `src/seed` omitted. `src/reports/excel.js` is included by one workbook test so the gate stays honest. The threshold is enforced on an unfiltered `npm test`. A filtered phase run still collects coverage and does not lower the gate.

The property test uses a chart whose accounts do not block overdraft, so a random balanced entry is a valid entry. Overdraft has its own examples. fast-check settings: `numRuns: 50`, seed `2026`.

Each test creates a private schema in `paise_ledger_test`, runs the migrations into it, and drops the schema afterwards. Tests do not delete journal rows, because the triggers forbid it. The concurrency test uses two separate `pg` clients against the same schema so `FOR UPDATE` actually blocks.

## How to run

These commands were run against this repository. Node.js 20 or newer is required. PostgreSQL must already be running for the npm commands, with the URL in `.env.example` (`postgres://paise:paise@localhost:5432/paise_ledger`). `npm test` creates `paise_ledger_test` when it can.

```bash
npm install
npm install --prefix web
npm run migrate
npm test
npm run seed
npm run dev          # API on 3000 and Vite on 5173
```

`make test`, `make migrate`, `make seed`, and `make lint` call those npm scripts. `make demo` migrates, then seeds. `make run` is `docker compose up --build`.

After `make run` (or `docker compose up --build`):

- API: `http://localhost:3000`
- Docs: `http://localhost:3000/docs`
- UI: `http://localhost:8080`

Load the demo inside the API container once the API is healthy:

```bash
docker compose exec api npm run seed
```

A second seed attempt exits with an error if entries already exist. Compose stores PostgreSQL data in the `pgdata` volume.

During development, open the UI at `http://localhost:5173`. Both the Vite dev server and the production preview server strip `/api` before proxying to Fastify. Set `API_PROXY_TARGET` when the API is not on `127.0.0.1:3000`.

## Screenshots

Captured from the React app against a database loaded by `npm run seed`:

| File | Must show |
| --- | --- |
| `docs/screenshots/dashboard.png` | Four balances and the six-month chart |
| `docs/screenshots/post-entry.png` | A balanced form and equal debit and credit totals |
| `docs/screenshots/account-statement.png` | HDFC account, a date filter, a running balance |
| `docs/screenshots/trial-balance.png` | Equal debit and credit grand totals |
| `docs/screenshots/reconciliation.png` | Matched, suggested with confirm, and unmatched rows together |
| `docs/screenshots/audit-log.png` | Chain verification with `ok: true` after the seed |

![Dashboard](docs/screenshots/dashboard.png)
![Post entry](docs/screenshots/post-entry.png)
![Account statement](docs/screenshots/account-statement.png)
![Trial balance](docs/screenshots/trial-balance.png)
![Reconciliation](docs/screenshots/reconciliation.png)
![Audit log](docs/screenshots/audit-log.png)

## What I'd do next

- Real authentication and roles: a bookkeeper can post, an auditor can read and verify, neither can turn triggers off.
- Period close: a posted closing entry that moves income and expense to retained earnings, with the balance sheet reading that entry once it exists.
- Multi-currency is out of scope until paise-style minor units exist per currency. I would not introduce floats to get there.
- Document attachments on a voucher, stored outside the hash canonicalization or explicitly versioned into it.
- A proper outstanding reconciliation report: book balance, statement balance, outstanding deposits, unpresented payments.
- Pagination and filters on the audit log, and a daily verify-chain job that fails loud when `ok` is false.
- Idempotency retention and a story for `in progress` if we ever split the key insert from the commit. The current single-transaction design does not need a recovery sweeper.

## Repository layout

```text
paise-ledger/
  README.md
  plan.md
  BUILD_PROMPT.md
  package.json
  Makefile
  Dockerfile
  Dockerfile.web
  docker-compose.yml
  LICENSE
  migrations/
  src/
    api/
    services/
    schemas/
    reports/
    importers/
    domain/
    seed/
    db/
  web/
  tests/
  data/seed/
  docs/screenshots/
```

Phase-by-phase work, tests, and commit messages are in [plan.md](plan.md).

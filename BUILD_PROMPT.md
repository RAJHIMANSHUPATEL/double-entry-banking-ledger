# Build prompt — Paise Ledger

You are a senior backend and full-stack developer shipping a portfolio project that a staff engineer would be willing to defend in a review. You own the outcome. Decide the small things the spec leaves open, and do not bounce those decisions back as questions. Write the code you would want to maintain: clear names, thin route handlers, transactions that match the invariants, tests that fail for the right reason, and no half-finished paths. When a shortcut would weaken an accounting rule, keep the rule. Review your own diff before each commit. If a test is red, fix the product. Do not weaken a check, a threshold, or the coverage gate to go green.

You are implementing the complete project in this directory. Do not stop to ask for approval between phases. Do not scaffold a partial demo and call it done. Build every phase below, run its tests, fix failures, commit, then continue until the definition of done passes.

Read these files first and treat them as the domain specification:

- `README.md` — problem, accounting rules, data model, API, seed story, design trade-offs, worked example
- `plan.md` — phase order, test cases, seed recipe, commit messages, traceability

Those files were written for Python, FastAPI, SQLAlchemy, SQLite, Alembic, pytest, Hypothesis, and Streamlit. **Ignore that stack.** Implement the same financial system with the stack in this prompt. When `plan.md` names a Python file, library, or command, translate it with the mapping table below. Keep the phase order, the test cases, the chart of accounts, the worked example numbers, the error codes, the hash canonical form, and the commit messages.

All business data is fictional. Keep the Anaya Studio disclaimer in the README.

## Stack (locked)

Use these choices. Do not swap them for alternatives.

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 20+ , ES modules (`"type": "module"`) |
| Language | JavaScript. JSDoc on service functions. No TypeScript |
| HTTP API | Fastify 5 |
| Validation | Zod. Reject any money value that is not a safe integer |
| Database | PostgreSQL 16 |
| SQL access | `pg` (node-postgres). Parameterized SQL only |
| Schema changes | Ordered SQL files in `migrations/`, applied by `src/db/migrate.js` |
| Logs | Pino, through Fastify |
| Tests | Vitest |
| Property tests | fast-check |
| HTTP tests | Fastify `inject` |
| CSV | `csv-parse` |
| Narration similarity | `fuzzball` `token_set_ratio`, stored as an integer 0–100 |
| Excel | `exceljs` |
| API docs | `@fastify/swagger` and `@fastify/swagger-ui` mounted at `/docs` |
| Frontend | React 18 + Vite + React Router. Plain CSS. No component library |
| Charts | Inline SVG on the dashboard. No chart framework |
| Containers | Docker Compose: `postgres`, `api`, `web` |
| Package manager | npm |

### Mapping from the written plan

| In README / plan.md | Implement with |
| --- | --- |
| pytest | vitest |
| Hypothesis | fast-check |
| FastAPI / Pydantic | Fastify / Zod |
| SQLAlchemy models | SQL migrations + query functions in `src/db/` |
| Alembic | `migrations/*.sql` and `npm run migrate` |
| SQLite, including its trigger limits | PostgreSQL. Implement the deferred constraint trigger for real |
| structlog | pino |
| openpyxl | exceljs |
| rapidfuzz | fuzzball |
| Streamlit pages | React routes |
| `Money` in Python | `src/domain/money.js` |
| `make test` | `npm test` (Makefile calls the npm scripts) |

## What you are building

A double-entry ledger for one fictional Indian small business.

1. Chart of accounts with types `asset`, `liability`, `equity`, `income`, `expense`, parent/child accounts, and stable codes. Seed the Anaya Studio chart from `README.md` exactly.
2. Journal entries with 2 or more lines. Total debits must equal total credits or the request is rejected with the error envelope.
3. Append-only posted entries. No HTTP route and no repository function updates or deletes them. Corrections are a new reversing entry with `reverses_entry_id`. Every entry stores `created_by` and server-set `created_at`.
4. `POST /entries` accepts `Idempotency-Key`. The same key and same body return the original entry and do not post twice. The same key and a different body return 409. A rejected body does not consume the key.
5. Reports: account statement with running balance and a date filter, trial balance, profit and loss, balance sheet. Each exports to Excel.
6. Bank CSV upload into `bank_statement_lines`. Auto-match on exact paise, a date window of ±3 days, and fuzzball narration score. Expose matched, suggested, and unmatched lines. Confirm and reject suggestions. Rematch after reject.
7. Each entry stores a SHA-256 hash of its canonical content plus the previous entry hash. `GET /verify-chain` recomputes the chain.

Money is integer paise. The database, the hash, the matcher, and every total use integers. Format INR with Indian digit grouping only when building a string for a person or a spreadsheet.

## Repository layout

```text
double-entry-ledger/
  package.json
  package-lock.json
  Dockerfile
  docker-compose.yml
  Makefile
  .env.example
  .gitignore
  README.md
  plan.md
  migrations/
    0001_init.sql
  src/
    server.js
    app.js
    config.js
    api/
      errors.js
      actor.js
      routes/
        health.js
        accounts.js
        entries.js
        reports.js
        bank.js
        audit.js
    schemas/
    services/
      exceptions.js
      posting.js
      reversal.js
      hashing.js
      idempotency.js
      accounts.js
      balances.js
      reporting.js
      reconciliation.js
    db/
      pool.js
      migrate.js
      tx.js
      queries/
    domain/
      money.js
      clock.js
    reports/
      excel.js
    importers/
      csvBank.js
      matcher.js
    seed/
      chart.js
      generate.js
  web/
    index.html
    vite.config.js
    src/
      main.jsx
      App.jsx
      api.js
      styles.css
      pages/
        Dashboard.jsx
        PostEntry.jsx
        AccountStatement.jsx
        TrialBalance.jsx
        Reconciliation.jsx
        AuditLog.jsx
  tests/
    unit/
    property/
    concurrency/
    importers/
    reports/
    api/
    seed/
```

The web UI is JSX, which Vite compiles. Application logic under `src/` stays plain `.js`. The UI calls the HTTP API only. It never opens Postgres.

## Layer rules

- `src/api/routes/*` parses the request with Zod, reads `X-Actor` and `Idempotency-Key`, calls one service, and sends the result. No balance math, no hash math, no fuzzball, no SQL.
- `src/services/*` owns transactions and business rules.
- `src/db/queries/*` is parameterized SQL only. No business branching.
- `src/importers/matcher.js` is a pure function with no database access.
- `src/reports/excel.js` turns service results into workbooks.

## Database

Implement the tables, columns, checks, and partial unique indexes from the **Data model** section of `README.md`.

PostgreSQL-specific requirements that the Python plan treated as optional are mandatory here:

- `NUMERIC` is not used for money. Paise columns are `bigint`.
- `CHECK (credit_total_paise = debit_total_paise)` on `journal_entries`.
- Line check: exactly one of `debit_paise` or `credit_paise` is positive, both are `>= 0`, both are `<= 100000000000000`.
- Partial unique index so an original entry has at most one reversal.
- Partial unique index so a journal line is matched to at most one statement line.
- `BEFORE UPDATE OR DELETE` triggers on `journal_entries`, `journal_lines`, and `reconciliation_events` that `RAISE EXCEPTION` with a fixed append-only message.
- Trigger on `journal_lines` that rejects a group account or an inactive account.
- A **constraint trigger** `DEFERRABLE INITIALLY DEFERRED` that, at commit, checks every touched entry has at least two lines and that the line sums equal the header totals.
- Genesis row in `ledger_meta`: `id = 1`, `last_sequence = 0`, `last_hash` = 64 zeroes.
- `pgcrypto` is unnecessary. Hash in Node with `node:crypto`.

Foreign keys are `ON DELETE RESTRICT`.

## Posting transaction

`postEntry` uses one database client and one transaction. On any failure it rolls back. A failed request leaves no entry, no lines, no idempotency row, and an unchanged `ledger_meta`.

Order inside the transaction:

1. `SELECT * FROM ledger_meta WHERE id = 1 FOR UPDATE`.
2. If an idempotency key was sent, look it up. Same request hash: roll back and return the stored entry (HTTP 200). Different hash: roll back and throw a conflict (HTTP 409).
3. Resolve account codes. Unknown, group, or inactive accounts fail.
4. Validate 2–50 lines, safe-integer paise, exactly one side per line, and equal positive totals.
5. For accounts with `prevent_overdraft`, refuse the entry when `current balance + effect < 0`. Asset balance is `sum(debit_paise - credit_paise)`. Reversals pass `skipOverdraft: true` and log a warning if a protected account would go negative.
6. Assign `sequence_no`, build the canonical `v1` string from `README.md`, store `prev_hash` and `entry_hash`. Truncate `created_at` to whole UTC seconds before insert and before hashing.
7. Insert the entry, the lines, and the idempotency row.
8. The deferred trigger checks line sums at commit. Also run the same check in the service before commit so the error message is the domain error, not only a trigger dump.
9. Advance `ledger_meta`.
10. `COMMIT`.

`created_at` comes from a `nowUtc()` function in `src/domain/clock.js` so tests can freeze time. Clients cannot send `created_at`. `entry_date` is the accounting date.

There is no `reversed_by_entry_id` column. Do not update the original row when reversing.

## Money

`src/domain/money.js`:

- `money(paise)` throws if the value is a boolean, a float, a string, or outside `Number.MAX_SAFE_INTEGER`.
- `parseRupees(input)` strips `₹`, `Rs`, `INR`, spaces, and Indian commas. Split on the decimal point. Reject more than two fractional digits. Compute `rupees * 100 + paise` with integer arithmetic. **Do not call `parseFloat`, `Number(decimalString)`, or use `Math.round` on a binary float.**
- `formatInr(paise)` uses `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })`. Pin the README examples: `123456789` → `₹12,34,567.89`, `-500050` → `-₹5,000.50`, `0` → `₹0.00`.

JSON request and response amounts are paise integers. Display strings are extra fields produced by `formatInr`.

## HTTP

Follow the route table, status codes, and error envelope in `README.md`. Every error looks like:

```json
{
  "error": {
    "code": "UNBALANCED_ENTRY",
    "message": "Debits (150000 paise) do not equal credits (140000 paise).",
    "details": {},
    "request_id": "..."
  }
}
```

Mutating routes require `X-Actor` (1–64 chars, `[A-Za-z0-9_.-]`). Missing actor is 400 `ACTOR_REQUIRED`.

Generate `X-Request-Id` when the client omits it, bind it to the pino log, and echo it on the response.

`GET /health` checks Postgres with `SELECT 1`.

Swagger UI is served at `/docs`.

## Reports

Implement the definitions in `README.md`, including current earnings as a computed equity row. Do not post closing journals.

Pin the worked example in `tests/reports` at the exact paise figures in the README:

- Trial balance debit and credit totals: 61800
- P&L profit: 5000
- Balance sheet assets: 56800, liabilities: 1800, equity including earnings: 55000, difference: 0
- Bank statement around the rent line: opening 61800, credit 5000, closing 56800

Excel cells contain both the INR display string and the integer paise.

## Reconciliation

Follow the CSV format, day-first date rules, sign convention, thresholds, and greedy assignment in `README.md`.

- Auto-match: one candidate, score ≥ 95, both narrations non-empty, exact paise, date within 3 days.
- Suggest: score ≥ 70 with a lead of at least 10, or a single candidate with an empty narration.
- Empty narration never auto-matches.
- A difference of 100 paise (₹1) never matches.
- A date 4 or more days away never matches.
- A journal line is used at most once.

Confirm enforces the same amount, sign, and date window. Reject records the pair so rematch will not offer it again.

## Seed

`npm run seed` runs `src/seed/generate.js`.

- Refuse to run when `ledger_meta.last_sequence > 0`.
- Use only `src/services` to post. No hand-written journal inserts.
- `random` source: a seeded generator with seed `2026`, not `Math.random()`.
- 280–320 entries from 1 April 2026 through 30 September 2026.
- Actor `seed-bot`. Idempotency keys `seed-{n}`.
- After posting, chain verification succeeds and the trial balance difference is 0.
- Write `data/seed/hdfc_apr_sep_2026.csv` using the planted discrepancy recipe in `README.md`.
- Integer GST: `cgst = revenuePaise * 9 / 100` using integer division, remainder on SGST, entry still balanced.
- Keep every name, GSTIN, and account number fictional.

## Frontend

Routes:

| Path | Page |
| --- | --- |
| `/` | Dashboard: cash, bank, receivables, month profit, SVG income-vs-expense bars for April–September 2026, latest 10 entries |
| `/post` | Post entry. Leaf accounts only. Live debit and credit totals. UUID idempotency key held in component state and regenerated only after HTTP 201. A 422 keeps the key |
| `/statement` | Account, date range, running balance, Excel download |
| `/trial-balance` | Trial balance, and sections for P&L and balance sheet, each with Excel download |
| `/reconciliation` | Upload CSV. Lists for matched, suggested (confirm and reject), unmatched (manual match) |
| `/audit` | Entries, reversal link, short hash, verify-chain button, reconciliation events |

The actor name lives in `sessionStorage` and is sent as `X-Actor`. Rupee inputs go through `parseRupees` before the request. Show `error.message` from the envelope.

Vite dev server proxies `/api` to Fastify. The browser calls `/api/...`. Fastify routes stay unprefixed (`/entries`, `/docs`). The proxy strips `/api`, or Fastify is mounted with prefix `/api` and `/docs` stays at the root. Pick one and document it. Tests call Fastify routes directly.

## How to work

Execute the phases in this order. After each phase run the listed tests. Commit with the message from `plan.md` for that phase only when the tests pass. Do not start the next phase on a red suite. Do not squash everything into one commit.

Translate the Python test names in `plan.md` into vitest files, but keep every case in those tables. The cases are the spec.

| Phase | Build | Then run |
| --- | --- | --- |
| A1 | package.json, Fastify health, pino, error envelope, `money.js` | `npm test -- tests/unit/money.test.js` |
| B1 | SQL migration, pool, migrator, chart seed, constraint tests | `npm test -- tests/schema` |
| C1 | Posting service and overdraft | `npm test -- tests/unit/posting.test.js` |
| D1 | Reversal, canonical hash, verify | `npm test -- tests/unit/reversal.test.js tests/unit/hashChain.test.js` |
| E1 | fast-check property test | `npm test -- tests/property` |
| F1 | Idempotency inside the locked transaction | `npm test -- tests/unit/idempotency.test.js` |
| G1 | Real Postgres concurrency test | `npm test -- tests/concurrency` |
| H1 | Account and entry routes, swagger | `npm test -- tests/api` |
| I1 | Reports and Excel, including the worked example | `npm test -- tests/reports` |
| J1 | CSV parser and pure matcher | `npm test -- tests/importers` |
| K1 | Confirm, reject, rematch | `npm test -- tests/api/reconciliation.test.js` |
| L1 | Seed generator and planted CSV | `npm test -- tests/seed` |
| M1 | React dashboard, post entry, statement | UI smoke against the API |
| M2 | Trial balance, reconciliation, audit pages | UI smoke |
| N1 | Docker Compose, Makefile, README, screenshots | full `npm test` and compose smoke |

From phase C1 onward the coverage gate is on:

```text
src/services/**/*.js
src/importers/**/*.js
src/reports/**/*.js
```

Fail the suite under 85% line coverage for those folders. Exclude `src/seed/**`.

### Test database

Tests run against PostgreSQL, not mocks, for anything that posts, locks, or checks a trigger.

`docker compose up -d postgres` creates user `paise`, password `paise`, database `paise_ledger`. Tests create a database `paise_ledger_test` if needed.

Journal deletes are forbidden by triggers, so do not clean up with `DELETE`. For each test, create a private schema (or a private database), run migrations into it, and drop it afterward. The concurrency test uses two separate `pg` clients against the same schema so `FOR UPDATE` actually blocks.

Concurrency cases from `plan.md`:

- Opening cash 10000 paise. Two parallel spends of 10000. Exactly one succeeds, the other is `OVERDRAFT`, final balance is 0, chain verifies.
- Ten parallel balanced entries on non-cash accounts all commit, sequences are contiguous, chain verifies.
- Two parallel posts with the same idempotency key and body produce one row, and both callers observe that row's id.

Run the concurrency file five times before committing phase G1. A failure is a product bug.

Property test: fast-check, 50 runs, seed fixed. Random valid balanced entries and reversals on a five-account chart with overdraft protection off. Afterwards total debits equal total credits, trial balance difference is 0, and `verifyChain` returns ok.

### npm scripts

```text
npm run migrate
npm run dev          # API and Vite
npm test             # vitest with coverage gate
npm run seed
npm run lint
```

Makefile targets `run`, `test`, `seed`, `migrate`, and `demo` call Docker or these scripts.

### Docker Compose

- `postgres:16-alpine`, volume `pgdata`, healthcheck `pg_isready`, published on `5432`.
- `api` runs migrations then `node src/server.js`, port `3000`, `DATABASE_URL` pointing at the postgres service.
- `web` serves the Vite production build and proxies API calls to `api`. Port `8080`.

`.env.example` holds `DATABASE_URL=postgres://paise:paise@localhost:5432/paise_ledger`.

`.gitignore` ignores `node_modules/`, coverage output, and `.env`. Commit `data/seed/hdfc_apr_sep_2026.csv`.

## README

When the app runs, rewrite `README.md` so a reviewer can follow it against this codebase:

- Keep the problem statement, the fictional-data warning, the mermaid architecture (updated to Fastify, Postgres, React), the data model, the design decisions, and "What I'd do next".
- Rewrite the design decisions so the reasons stay: integer paise, append-only reversals, idempotency keys, and a `ledger_meta` row lock with `SELECT … FOR UPDATE`.
- Replace setup with commands you have actually run: `docker compose up --build`, `npm test`, `npm run seed`, URLs for the app, `/docs`, and the UI.
- Add screenshots under `docs/screenshots/` from the running seed: dashboard, post entry, account statement, trial balance, reconciliation, audit log with chain `ok: true`.
- Point the architecture diagram at `src/api`, `src/services`, and Postgres.

Do not leave the README describing FastAPI, SQLite, Alembic, pytest, or Streamlit.

Add an MIT `LICENSE`.

## Definition of done

Stop only when all of these are true:

- Phases A1 through N1 are implemented and committed separately.
- `npm test` is green and coverage on services, importers, and reports is at least 85%.
- `GET /docs` lists the routes.
- An unbalanced post returns the error envelope and does not move the chain head.
- Repeating a post with the same idempotency key returns the original entry and does not allocate a new sequence.
- The concurrency test is part of the suite and passes against PostgreSQL.
- The fast-check property test is part of the suite.
- `npm run seed` loads 280–320 fictional entries, verification returns ok, and the planted CSV yields matched, suggested, and unmatched lines.
- The React app can post, filter a statement, show a balanced trial balance, confirm a suggestion, and verify the chain.
- `docker compose up --build` serves the API and the UI.
- The README matches those commands and says the data is fake.

## Do not

- Do not use `float`, `parseFloat`, or `NUMERIC` for money.
- Do not add an edit or delete endpoint for journal entries.
- Do not store a `reversed_by` column by updating the original entry.
- Do not put business rules in route handlers or in React components.
- Do not mock Postgres in the posting, trigger, idempotency, or concurrency tests.
- Do not skip a phase or merge the commits into one.
- Do not weaken a threshold, a check, or the coverage gate to make a test pass. Fix the product.
- Do not invent a real person's identity, a real GSTIN, or a real bank account. Keep Anaya Studio fictional.
- Do not install Python to satisfy the old plan.

# Paise Ledger — implementation plan

This is the build plan for the specification in [README.md](README.md). The schema, invariants, and API described there are canonical. This file says how to implement them in small milestones, what to test after each one, and what commit message to use.

No application code is created by writing this plan. Start Milestone A only after an explicit OK. If that OK does not change a locked default, implement the default as written.

## How to work

1. Implement one phase at a time, in the order below.
2. At the end of a phase, run the tests listed for that phase. They must pass before the commit.
3. Commit with the message given for that phase. One phase, one commit. Do not squash the milestone into a single commit.
4. Do not start the next phase on a red test.
5. Keep business rules in `app/services`, `app/reports`, and `app/importers`. Route functions stay thin.
6. When a phase finishes the README's "How to run" or screenshot section, update those sections so a reviewer can follow them.

Commit style: one sentence, imperative, focused on why the change exists. The messages below are ready to use.

Suggested cadence: about eight to twelve focused days. The estimates are for one person who already knows the stack. They are a sizing aid, not a schedule promise.

## Locked defaults

These are decided. Changing one means editing the README and the affected phase before writing code.

| Topic | Default |
| --- | --- |
| Product name | Paise Ledger |
| Fictional entity | Anaya Studio, Pune, sole proprietorship. All seed data fake |
| Money | `int` paise. `Decimal` only while parsing a rupee string. No `float` in the money path |
| API amounts | Paise integers. Display strings are extra fields |
| Account identity in the API | `code`, not the surrogate id |
| Postable accounts | Active leaves only |
| Drawings | Equity account. Reports show credit minus debit, so drawings reduce equity |
| `normal_balance` | Derived from `type` in report code. Not a column |
| Corrections | New entry with `reverses_entry_id`. No update of the original |
| Overdraft | Refused for new entries on accounts with `prevent_overdraft`. Allowed for reversals, with a warning log |
| Idempotency | Optional header. Stored only with a successful commit. Same body replays. Different body is 409. A 422 does not burn the key |
| Lock | Global `ledger_meta` row. Postgres `FOR UPDATE`. SQLite update-in-place plus `busy_timeout` |
| Hash | SHA-256, canonical `v1` string in the README, timestamps truncated to seconds UTC |
| Chain genesis | `prev_hash` is 64 zeroes, `last_sequence` is 0 |
| Dates in CSV | Day-first. ISO `YYYY-MM-DD` accepted |
| Match window | ±3 calendar days, exact paise, sign must agree with the ledger side |
| Auto-match | Score ≥ 95, one candidate, both narrations non-empty |
| Suggest | Score ≥ 70 and a lead of at least 10, or a single candidate with an empty narration |
| Earnings on the balance sheet | Computed. No closing journal in this version |
| Auth | `X-Actor` header only |
| Default database | SQLite file. Models and Alembic stay PostgreSQL-compatible |
| Coverage gate | 85% on `app/services`, `app/importers`, `app/reports`. Omit `app/seed` |
| Seed RNG | `random.Random(2026)`, 280–320 journal entries, April–September 2026 |
| License | MIT, added in the packaging phase |

## Milestone map

```mermaid
flowchart LR
  A["A Skeleton"] --> B["B Schema"]
  B --> C["C Posting"]
  C --> D["D Reversals and hash"]
  D --> E["E Property test"]
  E --> F["F Idempotency"]
  F --> G["G Concurrency test"]
  G --> H["H HTTP API"]
  H --> I["I Reports"]
  I --> J["J Bank CSV"]
  J --> K["K Confirm and reject"]
  K --> L["L Seed"]
  L --> M["M Streamlit"]
  M --> N["N Package and docs"]
```

| Milestone | Phase | Estimate | Commit headline |
| --- | --- | --- | --- |
| A. Skeleton | A1 | 0.5 day | Integer paise and a typed error envelope |
| B. Schema | B1 | 1 day | Append-only journal schema |
| C. Posting | C1 | 1.5 days | Balanced postings under the ledger lock |
| D. Reversal and hash | D1 | 1 day | Reversals and a verifiable hash chain |
| E. Property | E1 | 0.5 day | Invariants across random books |
| F. Idempotency | F1 | 0.5 day | Safe retries of a posting |
| G. Concurrency | G1 | 0.5 day | Prove the overdraft race |
| H. API | H1 | 1 day | HTTP for accounts, entries, and verify |
| I. Reports | I1 | 1 day | Statements, trial balance, P&L, balance sheet, Excel |
| J. Reconciliation | J1 | 1 day | CSV parse and match |
| K. Reconciliation | K1 | 0.5 day | Confirm, reject, rematch |
| L. Seed | L1 | 1 day | Six months of fake books and a planted CSV |
| M. UI | M1–M2 | 1.5 days | Streamlit desk |
| N. Package | N1 | 0.5 day | Docker, Makefile, README that matches reality |

---

## Phase A1 — Skeleton, logging, errors, Money

**Goal.** A runnable FastAPI process with health, JSON logs, one error shape, and a tested `Money` type. No tables yet.

**Create**

```text
pyproject.toml
app/__init__.py
app/main.py
app/api/__init__.py
app/api/errors.py
app/core/__init__.py
app/core/config.py
app/core/logging.py
app/core/money.py
app/schemas/errors.py
tests/conftest.py
tests/unit/test_money.py
tests/api/test_health.py
```

**pyproject.toml**

- Requires Python `>=3.11`.
- Dependencies: `fastapi`, `uvicorn[standard]`, `sqlalchemy>=2`, `alembic`, `pydantic>=2`, `pydantic-settings`, `python-multipart`, `openpyxl`, `rapidfuzz`, `structlog`, `httpx`.
- Dev: `pytest`, `pytest-cov`, `hypothesis`, `ruff`.
- Ruff line length 100, target `py311`.
- Coverage config:

```toml
[tool.coverage.run]
branch = true
source = ["app/services", "app/importers", "app/reports"]
omit = ["app/seed/*"]

[tool.coverage.report]
fail_under = 85
show_missing = true
```

The gate starts failing only once those packages exist and contain real code. Until Phase C1, run pytest without `--cov-fail-under`. From C1 onward, the Makefile target uses the gate. Early phases may show a coverage fail if the source list is empty; if that happens, keep the omit/source list and enable `fail_under` in Phase C1 when `app/services` first has logic. Do not weaken the gate later to go green.

**Settings** (`pydantic-settings`): `database_url` default `sqlite:///./data/ledger.db`, `log_level` default `INFO`, `fuzzy_suggest_threshold` default `70`, `fuzzy_auto_threshold` default `95`, `date_window_days` default `3`.

**Money API**

```text
Money(paise: int)                         raise TypeError if not int
Money.from_rupees_str(value: str) -> Money
Money.format_inr(self) -> str
```

Parsing rules to test:

| Input | Paise |
| --- | --- |
| `0` | 0 |
| `1` | 100 |
| `1500.5` | 150050 |
| `1500.50` | 150050 |
| `₹1,18,000.00` | 11800000 |
| `Rs 10` | 1000 |
| `-5,000.50` | -500050 |

Reject: `1500.501`, empty string, `1.2.3`, a `float` passed to `Money()`, `True` (bool is a subclass of int — reject bools explicitly).

Formatting to test:

| Paise | Display |
| --- | --- |
| 0 | `₹0.00` |
| 1 | `₹0.01` |
| 100 | `₹1.00` |
| 123456789 | `₹12,34,567.89` |
| -500050 | `-₹5,000.50` |
| 100000000000 | `₹1,00,00,00,000.00` |

**Errors.** `LedgerError` hierarchy lives in `app/api/errors.py` only as the HTTP mapping. Domain exceptions themselves are introduced in `app/services/exceptions.py` in Phase C1. In this phase, add the envelope schema and a handler that turns `RequestValidationError` into `VALIDATION_ERROR` / 422 with `details` as a list of `{loc, message}`. Include `request_id` from middleware.

**Logging.** structlog JSON to stdout. Middleware binds `request_id`, logs `http_request` with method, path, status, `duration_ms` on the way out. Generate `request_id` when `X-Request-Id` is absent. Echo the header on the response.

**Health.** `GET /health` returns `{"status": "ok"}` in this phase. Database status is added in Phase B1.

**Tests**

```bash
pytest -q tests/unit/test_money.py tests/api/test_health.py
ruff check app tests
```

**Done when**

- Money tests cover the tables above.
- A validation error from a dummy route (or a temporary test route removed before commit — prefer calling the handler in a unit test) has the envelope keys `code`, `message`, `details`, `request_id`.
- `GET /health` is 200.
- No `float` appears in `app/core/money.py`.

**Commit**

```text
Add an integer paise helper and a consistent API error envelope
```

---

## Phase B1 — Schema, migrations, chart seed data

**Goal.** A migrated SQLite database whose constraints match the README, plus the Anaya Studio chart loaded by a function tests can call. No posting service yet.

**Create**

```text
alembic.ini
alembic/env.py
alembic/versions/0001_initial.py
app/core/db.py
app/models/__init__.py
app/models/base.py
app/models/account.py
app/models/journal.py
app/models/idempotency.py
app/models/ledger_meta.py
app/models/bank.py
app/seed/chart.py
tests/schema/test_migration.py
tests/schema/test_constraints.py
```

**Engine rules in `app/core/db.py`**

- On SQLite connect: `PRAGMA foreign_keys=ON`, `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`.
- Session factory is `expire_on_commit=False` so response building after commit does not lazy-load unexpectedly. Services still re-read anything they need for assertions before commit.
- `get_session` dependency yields a session and closes it. Services own `commit` and `rollback`. The dependency does not commit.

**Models.** Map every column in the README data model. Use `Mapped[...]` and `mapped_column`. Relationships: account parent/children, entry lines, entry reversal target, statement lines.

Name the reversal relationship so it does not fight the self FK. `reverses_entry` on the child, `reversal_entries` on the parent (the partial unique index means there is at most one, but the ORM can still be a collection or a scalar `uselist=False` view). Prefer a scalar optional `reversal_entry` via `primaryjoin` if it stays readable; otherwise a collection and a service helper `find_reversal`.

**Migration `0001_initial`**

Create tables in FK order: `accounts`, `ledger_meta`, `journal_entries`, `journal_lines`, `idempotency_keys`, `bank_statements`, `bank_statement_lines`, `reconciliation_events`.

CHECK constraints as SQL text passed to `CheckConstraint`, because both dialects honor them:

- `accounts.type IN ('asset','liability','equity','income','expense')`
- `accounts.prevent_overdraft = false OR accounts.type = 'asset'` (use the boolean form SQLAlchemy emits, and assert it in a test rather than hand-writing `0` if the compiler already coerces)
- `journal_entries.credit_total_paise = journal_entries.debit_total_paise`
- `journal_entries.debit_total_paise > 0`
- `journal_entries.id <> journal_entries.reverses_entry_id` OR `reverses_entry_id IS NULL`
- line side CHECK from the README
- `journal_lines.debit_paise <= 100000000000000` and the same for credit
- `ledger_meta.id = 1`
- `bank_statement_lines.amount_paise <> 0`
- match status CHECK and the matched-implies-journal-line CHECK
- reconciliation action CHECK

Partial unique indexes:

```python
op.create_index(
    "uq_journal_entries_one_reversal",
    "journal_entries",
    ["reverses_entry_id"],
    unique=True,
    sqlite_where=text("reverses_entry_id IS NOT NULL"),
    postgresql_where=text("reverses_entry_id IS NOT NULL"),
)
```

Same pattern for `uq_bank_line_matched_journal_line` on `matched_journal_line_id`.

Indexes: `accounts.parent_id`, `accounts.code` (unique already), `journal_entries.entry_date`, `journal_entries.sequence_no` (unique), `journal_lines.account_id`, `journal_lines (entry_id, line_no)` unique, `bank_statement_lines (statement_id, match_status)`, `bank_statement_lines (txn_date, amount_paise)`.

Insert the genesis `ledger_meta` row in the migration: `id=1`, `last_sequence=0`, `last_hash='0' * 64`.

**Triggers.** Branch on `op.get_bind().dialect.name`.

SQLite, for each of `journal_entries`, `journal_lines`, `reconciliation_events`, both UPDATE and DELETE:

```sql
CREATE TRIGGER trg_journal_entries_no_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'append-only: journal_entries cannot be updated');
END;
```

Use the table name inside the message so tests can assert it.

SQLite AFTER INSERT on `journal_lines` to reject a group or inactive account, and to reject line sums that exceed the header debit total or credit total. Read the README enforcement table and implement those four conditions. Use `RAISE(ABORT, '...')` with distinct messages: `account is not postable`, `line sums exceed entry header`.

PostgreSQL equivalents use `CREATE FUNCTION ... LANGUAGE plpgsql` and `BEFORE UPDATE OR DELETE` triggers that `RAISE EXCEPTION` with the same messages. Add a **constraint trigger** `DEFERRABLE INITIALLY DEFERRED` on `journal_lines` that, at commit, checks for each touched `entry_id`:

- `count(*) >= 2`
- `sum(debit_paise) = journal_entries.debit_total_paise`
- `sum(credit_paise) = journal_entries.credit_total_paise`

The deferred trigger is PostgreSQL-only. Say so in a comment in the migration. Do not fake it on SQLite.

**Chart.** `app/seed/chart.py` exposes `seed_chart(session) -> None` and is idempotent on `code`. Insert the exact rows from the README chart table, parents before children. Set `prevent_overdraft` on `1110` and `1120` only. Set `created_at` to a fixed UTC timestamp `2026-04-01T00:00:00Z` so test snapshots stay stable. Do not post journals here.

**Test fixture strategy, introduced now and reused everywhere**

```text
session-scoped migrated template file via `alembic upgrade head`
function-scoped test copies that file to a temp path
engine and session pointed at the copy
```

Tests must not `metadata.create_all` as a substitute. The template exists so triggers are present. Document the helper in `tests/conftest.py`.

**Tests**

- Upgrade on a fresh SQLite file succeeds, and `ledger_meta` has the genesis row.
- Inserting an account with `type='cash'` fails the CHECK.
- Inserting a journal header with unequal totals fails the CHECK.
- Inserting a line with both sides positive fails the CHECK.
- Inserting a line whose account is a group fails the trigger.
- `UPDATE` and `DELETE` on `journal_entries` fail the trigger. Build a minimal balanced header-plus-two-lines with raw SQL inside the test so this does not depend on Phase C1. After the failed update, the narration is unchanged.
- Foreign key failure: a line with `account_id=999999` fails.
- `seed_chart` twice still yields one row per code.
- Downgrade drops the tables. Run upgrade → downgrade → upgrade once.

`GET /health` now checks `SELECT 1` and returns `database: ok`.

**Done when** the schema tests pass and a hand inspection of `alembic/versions/0001_initial.py` shows every README table.

**Commit**

```text
Add the ledger schema with checks that keep posted rows append-only
```

---

## Phase C1 — Posting engine

**Goal.** `PostingService.post` writes a balanced entry in one transaction under the ledger lock, or writes nothing.

**Create**

```text
app/services/__init__.py
app/services/exceptions.py
app/services/locking.py
app/services/posting.py
app/services/balances.py
tests/unit/test_posting.py
```

**Exceptions** (map names to README error codes in Phase H1; define them now):

`UnbalancedEntry`, `AccountNotFound`, `AccountNotPostable`, `Overdraft`, `InvariantViolation`.

`InvariantViolation` is for the pre-commit sum check failing. That means a bug. The service rolls back and raises. Tests should not expect it on valid input.

**Locking.** `lock_ledger(session)`:

- PostgreSQL: `select(LedgerMeta).where(LedgerMeta.id == 1).with_for_update()`.
- SQLite: `UPDATE ledger_meta SET last_sequence = last_sequence WHERE id = 1`, then refresh the ORM object.

Call this before any balance read that informs a decision.

**Balances.** `balance_paise(session, account_id) -> int` returns `sum(debit_paise - credit_paise)` for an asset. Use it for overdraft. Do not cache balances in a column in this version. The lock makes the read stable until commit.

**`post` input.** A dataclass, not a Pydantic model: `entry_date`, `narration`, `reference`, `created_by`, `lines: list[LineDraft]`, `reverses_entry_id: int | None = None`, `idempotency_key: str | None = None`, `request_hash: str | None = None`, `skip_overdraft: bool = False`.

Idempotency fields are accepted and ignored in this phase except for a comment and a test that passing `idempotency_key=None` works. Phase F1 fills in the lookup. Threading the arguments now avoids a second rewrite of the transaction boundary.

`skip_overdraft` is False for normal posts. Phase D1 sets it True for reversals.

**Algorithm.** Follow the ten steps in the README section "Create", skipping the idempotency lookup until Phase F1. Still take the lock in step 1 so the concurrency phase does not restructure the transaction.

Hash computation can be a placeholder in this phase: call `HashChain` only if it already exists. It does not. Write `prev_hash` and `entry_hash` using a temporary internal function that Phase D1 replaces with the real canonical form. To avoid a throwaway hash that tests pin wrongly, Phase C1 may store `prev_hash` as the current `ledger_meta.last_hash` and `entry_hash` as the SHA-256 of `f"{sequence_no}|{prev_hash}|{debit_total}"` **only behind a private function `provisional_hash`**. Phase D1 deletes `provisional_hash` in the same commit that adds the real canonicalization, and no test should snapshot the provisional digest. Tests in this phase assert the chain fields are 64 hex characters and that `sequence_no` is 1 then 2. The golden hash vector waits for Phase D1.

**Transaction shape**

```text
try:
    lock
    validate
    insert entry and lines
    assert sums
    advance ledger_meta
    session.commit()
except:
    session.rollback()
    raise
```

The service commits. Tests use a real session against the copied database file and then query with a second session to prove the commit.

**Unit tests**

| Case | Expect |
| --- | --- |
| Two-line balanced entry, cash debit, capital credit | One entry, sequence 1, totals stored, `ledger_meta.last_sequence == 1` |
| Three-line GST-shaped entry using the worked amounts 11800 / 10000 / 900 / 900 on a fresh db that also has the capital line | Sums match |
| Debits 150000, credits 140000 | `UnbalancedEntry`, zero rows in `journal_entries` |
| One line | `UnbalancedEntry`, zero rows |
| Empty narration | `UnbalancedEntry` or a dedicated validation error. Pick `UnbalancedEntry` only for arithmetic. Use a `ValidationFailed` exception for empty narration, too few lines, and both sides set, so the API can still collapse them under `UNBALANCED_ENTRY` and `VALIDATION_ERROR` as the README states. Empty narration and both-sides are `VALIDATION` style domain errors (`InvalidEntry`). Too few lines and unequal sums are `UnbalancedEntry`. |
| Unknown code | `AccountNotFound`, zero rows |
| Post to `1000` Assets | `AccountNotPostable` |
| Post to a deactivated leaf | `AccountNotPostable` |
| Cash opening 10000 paise, then a credit of 10001 | `Overdraft`, only the opening entry remains |
| Cash opening 10000, credit of 10000 | Success, balance 0 |
| Bool or a non-int sneaking into a draft | `InvalidEntry` before any insert |
| After a forced mid-function failure (monkeypatch the sum assertion), no entry row and `last_sequence` still 0 | Rollback |
| Two sequential posts | sequences 1 and 2, distinct hashes |
| Raw `UPDATE` of the posted narration | database error, value unchanged |

Build drafts in tests with account codes from `seed_chart`.

**Done when** `pytest -q tests/unit/test_posting.py tests/schema` passes, and a failed post leaves `ledger_meta` at the genesis hash.

**Commit**

```text
Post balanced journal entries inside one locked transaction
```

From this commit forward the Makefile `test` target, even if the Makefile file itself arrives in Phase N1, is the command developers run:

```bash
pytest -q --cov=app/services --cov=app/importers --cov=app/reports --cov-fail-under=85
```

Until importers and reports exist, limit `--cov` to packages that exist so the gate measures real code. When a package appears, add it to the command in that phase's test run. Phase N1 freezes the full command in the Makefile. Do not drop below 85% on `app/services` after this phase.

---

## Phase D1 — Reversals and the hash chain

**Goal.** Replace provisional hashes with the README canonical form. Add reversals. Add `verify_chain`.

**Create**

```text
app/services/hashing.py
app/services/reversal.py
tests/unit/test_reversal.py
tests/unit/test_hash_chain.py
```

**Hashing.**

- `canonical_v1(entry, lines) -> str` exactly as specified in the README.
- Percent-encode `%` and `;` in narrations and references.
- Truncate `created_at` to whole seconds before it is stored and before it is hashed. Store timezone-aware UTC.
- `entry_hash(canonical) -> str` SHA-256 hex.
- `verify_chain(session) -> VerifyResult` with `ok`, `entries_checked`, `head_sequence`, `head_hash`, and optional `failed_sequence`, `stored_hash`, `recomputed_hash`.

Delete the provisional hash helper from posting. Posting calls `canonical_v1`.

**Golden vector.** In the test, build one entry with frozen inputs: sequence forced by posting order on an empty journal, `created_at` monkeypatched or injected via a clock function `now_utc()` in `app/core/clock.py` defaulting to `datetime.now(timezone.utc)`. The test freezes the clock at `2026-04-01T10:00:00Z`, posts a known two-line entry, computes the expected digest in the test by calling `canonical_v1` and hashlib, and also pins the hex digest as a literal once observed. Process: run the test once to print `entry_hash`, paste the literal into `test_golden_vector`, and assert both the literal and a fresh recompute. If they ever diverge, the canonical form changed. Do not invent the hex in this plan; pin it during the phase and mention the pin in the commit body if useful. The subject line stays the one below.

**ReversalService.reverse(session, entry_id, *, entry_date, narration, created_by, idempotency_key=None, request_hash=None)`**

- Load the original or raise `EntryNotFound`.
- If a row already has `reverses_entry_id == entry_id`, raise `AlreadyReversed` before attempting the insert (the unique index is the backstop).
- Build swapped lines. Copy `line_narration`. Keep account ids.
- Call `PostingService.post` with `reverses_entry_id` set and `skip_overdraft=True`.
- If the projected balance of a protected account is negative, log `overdraft_on_reversal` at warning with `account_code` and `resulting_balance_paise`.

**Tests**

- Reversal of a two-line entry swaps paise, sets `reverses_entry_id`, does not change the original narration, hash, or `created_at`.
- Trial balance difference is 0 after post and after reversal (call the same SQL the later report will use; a local helper in the test is fine until Phase I1 extracts it).
- Second reversal raises `AlreadyReversed` and does not add a row.
- Cash deposit 5000 then full withdrawal 5000, then reverse the deposit: success, cash balance `-5000`, warning path executed (caplog).
- Ordinary post that would do the same overdraft still fails.
- `verify_chain` ok after three entries including one reversal.
- Tamper: execute raw SQL that disables the update trigger inside a test connection (`DROP TRIGGER`) and change `narration`, then `verify_chain` returns `ok` false and `failed_sequence` of that entry. Recreate nothing; this test uses its own file. This proves verification compares content, and it is allowed to drop the trigger only inside that test.
- Genesis: first entry `prev_hash` is 64 zeroes. Second entry `prev_hash` equals the first `entry_hash`.

**Done when** unit tests for posting, reversal, and hash pass, and posting tests still pass after the provisional hash is removed.

**Commit**

```text
Record reversing entries on a verifiable SHA-256 chain
```

---

## Phase E1 — Hypothesis property test

**Goal.** For any list of valid random operations, the books stay balanced and the chain verifies.

**Create**

```text
tests/property/test_ledger_invariants.py
tests/property/chart.py
```

**Chart for this test.** A tiny fixed chart, seeded in the test, all leaves, `prevent_overdraft` false: one asset, one liability, one equity, one income, one expense. Overdraft is intentionally absent so the property is the accounting identity. Say that in the module docstring.

**Strategies**

- `balanced_entry`: choose total paise from 1 to 1_000_000. Split into 1–3 debit parts and 1–3 credit parts that sum to the same total, using integer cut points (sort random cuts of the total). Assign parts to distinct accounts. At least one debit line and one credit line. If the split yields a zero part, drop it and retry inside the strategy. `entry_date` drawn from April–September 2026. Narration from `st.text` with a minimum length, or a simple `st.from_regex` of `[A-Za-z0-9 ]{1,40}`.
- `reversal`: an index into the entries posted so far that are not themselves selected twice. The strategy can be a dataclass `Reverse(index=int)` interpreted by the test against current state. If the index points at an already reversed entry or an empty book, the test skips that operation (it is a no-op draw, not a failure).

`@settings(max_examples=50, deadline=None)` and `derandomize=True` so CI is stable. Suppress the health check for function-scoped database fixtures if Hypothesis complains about fixtures; prefer building the session inside the test from the template path fixture, which is the pattern Hypothesis tolerates.

**Assert after each example**

- `sum(debit_paise) == sum(credit_paise)` across all lines.
- Trial balance debit column total equals credit column total. Implement a small function `trial_balance_difference(session) -> int` in `app/services/reporting.py` now, even though the full reports arrive later. This is the first function of that module. Difference is `sum(net_debit) - sum(net_credit)` over leaves, which is 0.
- `verify_chain(session).ok` is true.
- Every entry has at least two lines.
- Each reversal's lines, compared as a multiset of `(account_id, debit, credit)`, equal the swapped original.

**Done when** the property test passes twice in a row locally (it is derandomized, so this is a sanity check against order bugs) and coverage on `app/services` is still ≥ 85%.

**Commit**

```text
Prove debits equal credits across random entries and reversals
```

---

## Phase F1 — Idempotency

**Goal.** Retries do not double-post. Conflicting bodies are rejected. Failed validations do not store a key.

**Create**

```text
app/services/idempotency.py
tests/unit/test_idempotency.py
```

**Canonical body.** `request_hash(payload: dict) -> str` using `json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. Dates must already be ISO strings in that dict. The HTTP layer builds this dict from the raw body before validation mutates types, or from a stable `model_dump(mode="json")`. Pick `model_dump(mode="json")` of the Pydantic schema once it exists; until Phase H1, tests pass a dict. Put the function in `idempotency.py` so the API uses the same one later.

**Inside `PostingService.post`, immediately after the lock**

- If `idempotency_key` is None: continue.
- Load `IdempotencyKey`. If found and `request_hash` matches: copy the entry id out, rollback (so a pure replay does not bump `ledger_meta`), return the existing entry loaded in a new read. Cleaner approach that stays in one session: if found, do not rollback the lock if you have not dirtied economic rows; you already ran the SQLite lock `UPDATE`, which dirties `ledger_meta`. **Rollback is required** so `last_sequence = last_sequence` is not committed as a needless write, and so a replay does not extend a lock. After rollback, `session.get` the entry and return it. Document this in a comment above the lookup: replay rolls back because the lock statement is a write.
- If found and hash differs: rollback, raise `IdempotencyConflict`.
- If not found: post, then insert the key row before the sum assertion and before commit.

**Tests**

- Same key, same hash, called twice: one `journal_entries` row, second call returns the same id, `last_sequence` is 1.
- Same key, different hash: second call raises, still one row.
- First call `UnbalancedEntry` with a key: zero idempotency rows. Second call with a corrected body and the same key: one row.
- Reverse path accepts a key too, covered with one test that replays `ReversalService.reverse`.
- Key is not part of `canonical_v1`. Two entries with different keys and the same economic content (posted separately, no replay) have different sequences so their hashes differ for that reason; assert the canonical string builder's input list does not contain the key. A unit test on `canonical_v1` inspecting the string is enough.

**Done when** idempotency tests pass beside the posting tests, including the rollback-on-replay assertion that `ledger_meta.last_hash` equals the first entry's hash and not a further value.

**Commit**

```text
Return the original posting when a client retries the same idempotency key
```

---

## Phase G1 — Concurrency test

**Goal.** Prove two overlapping withdrawals cannot both spend the same cash.

**Create**

```text
tests/concurrency/test_concurrent_posting.py
```

**Setup**

- File-based SQLite from the template, not `:memory:`.
- `check_same_thread=False` on the engine.
- Seed chart, post opening Dr cash `10000` / Cr capital `10000` before starting threads.
- Two threads, each with its own session and its own engine connection, blocked on a `threading.Barrier(2)` immediately before `post`.
- Each tries to credit cash `10000` and debit an expense `10000` (a withdrawal / spend).
- `busy_timeout` is already 5000. The test timeout for joining threads is 15 seconds.

**Assert**

- Exactly one thread returns an entry. The other raises `Overdraft`.
- Cash balance is 0, never negative. Query after both join.
- Journal count is 2 (opening plus one spend).
- `verify_chain` ok.
- A follow-up single-threaded spend of 1 paise raises `Overdraft`.

**Second test in the same module.** Ten threads each post a balanced entry that does not touch cash: Dr expense 100, Cr income 100, distinct idempotency keys. All ten succeed. Sequences are a contiguous range. `verify_chain` ok. Total debits equal total credits. This proves the lock serializes the chain and does not drop a commit.

**Third test.** Two threads, same idempotency key, same body, opening balance large enough that either would succeed. Exactly one row. Both callers observe the same entry id (the loser must catch the unique conflict or block on the lock and replay). Because the lock is taken before insert, the expected mechanism is: the second blocks, then replays. Assert one row. If a unique-constraint error surfaces, the service must catch it, rollback, and return the winner — add that handler if the test shows the lock is not enough. Prefer the lock-then-insert order so the handler is a backstop. Test the backstop by a direct insert race only if the happy path does not cover it. At minimum, the two-thread same-key test passes with one row.

**Flake policy.** Run the file five times locally before committing. A failure is a product bug, not a reason to add `pytest.mark.flaky`.

Postgres is not required in CI for this phase. If `DATABASE_URL` starts with `postgresql`, the same tests run. Add a short comment in the test module describing that. Do not skip the SQLite run.

**Done when** the concurrency module is stable across five runs and the coverage gate holds.

**Commit**

```text
Serialize postings so concurrent spends cannot overdraft cash
```

---

## Phase H1 — HTTP API for accounts, entries, chain

**Goal.** The routes a client needs before reports and CSV. OpenAPI shows them. Handlers contain no balance arithmetic.

**Create**

```text
app/api/deps.py
app/api/routes/accounts.py
app/api/routes/entries.py
app/api/routes/audit.py
app/schemas/account.py
app/schemas/entry.py
app/services/accounts.py
tests/api/test_entries_api.py
tests/api/test_accounts_api.py
```

**Dependencies.** `get_session`. `require_actor` reads `X-Actor` and raises a domain `ActorRequired` mapped to 400. Mutating routes depend on it. GET routes do not.

**Exception map** in one place, a dict or a single handler registering each domain exception to `(status, code)`:

| Exception | HTTP | code |
| --- | --- | --- |
| `InvalidEntry` | 422 | `VALIDATION_ERROR` |
| `UnbalancedEntry` | 422 | `UNBALANCED_ENTRY` |
| `AccountNotFound`, `EntryNotFound` | 404 | matching README codes |
| `AccountNotPostable` | 422 | `ACCOUNT_NOT_POSTABLE` |
| `Overdraft` | 422 | `OVERDRAFT` |
| `IdempotencyConflict` | 409 | `IDEMPOTENCY_CONFLICT` |
| `AlreadyReversed` | 409 | `ALREADY_REVERSED` |
| `ActorRequired` | 400 | `ACTOR_REQUIRED` |

`Overdraft.details` includes `account_code`, `balance_paise`, `attempted_delta_paise`.

**Schemas.** Pydantic v2. `debit_paise` and `credit_paise` are `int`, `ge=0`, `le=10**14`. A model validator requires exactly one side positive. `lines` `min_length=2`, `max_length=50`. `EntryRead` includes ids, sequence, hashes, totals, lines with `account_code` and `account_name`, `reverses_entry_id`, `created_by`, `created_at`, and `debit_total_display` from `Money.format_inr`.

**Routes.** Implement the subset of the README table that this phase owns: health (already), accounts list and create and deactivate, statement deferred to Phase I1, post entry, list entries, get entry, reverse, verify-chain. Audit list can return journal rows now and add reconciliation events in Phase K1; shipping a partial audit route is fine if the response has `journal` and `reconciliation` keys, with reconciliation always `[]` until K1.

**Idempotency header.** `Idempotency-Key` optional. The route computes `request_hash` from `body.model_dump(mode="json")` and passes it to the service. Replay returns 200. Create returns 201. Use a response model for both.

**Accounts service.** Create with the parent/type/cycle/depth rules. Deactivate sets `is_active` false. Refuse deactivation when posted lines exist? The README says deactivate is allowed and new lines then fail. Allow deactivate even with history. Refuse deactivation of a group that has an active child. List returns flat rows with `parent_code` so the UI can indent.

**API tests using `httpx.ASGITransport` or FastAPI's TestClient.** Point the app database at the per-test file via dependency override.

| Case | Expect |
| --- | --- |
| Post balanced | 201, body totals equal |
| Post unbalanced | 422, `UNBALANCED_ENTRY`, subsequent GET list is empty |
| Missing actor | 400 |
| Replay with same key and body | 200, one row in the database |
| Replay with same key and different narration | 409 |
| Reverse | 201, GET original shows the same narration as before |
| Reverse again | 409 |
| Verify after two posts | `ok` true, `entries_checked` 2 |
| Create account under the wrong parent type | 422 |
| OpenAPI schema contains `/entries`, `/verify-chain`, `/accounts` | 200 on `/openapi.json` |

**Done when** these tests pass and a manual `uvicorn` smoke (optional) shows `/docs`. The automated OpenAPI assertion is the required check.

**Commit**

```text
Expose accounts, postings, reversals, and chain verification over HTTP
```

---

## Phase I1 — Reports and Excel

**Goal.** Statement, trial balance, P&L, balance sheet, and xlsx exports. Figures computed in the service. Excel is a rendering of those figures.

**Create**

```text
app/services/reporting.py          # extend the difference helper from E1
app/reports/excel.py
app/reports/__init__.py
app/api/routes/reports.py
app/schemas/report.py
tests/reports/test_reports.py
tests/reports/test_excel.py
tests/api/test_reports_api.py
```

**Service functions**

- `account_statement(session, code, date_from, date_to) -> Statement`
- `trial_balance(session, as_of) -> TrialBalance`
- `profit_and_loss(session, date_from, date_to) -> ProfitAndLoss`
- `balance_sheet(session, as_of) -> BalanceSheet`

Use the definitions in the README, including current earnings as a computed equity row. Group accounts do not appear as posting rows. They may appear as subtotals if that stays easy; the required rows are leaves plus the earnings plug and the grand totals. A leaf with zero activity and zero balance is omitted.

Running balance on the statement uses the account type to choose the sign, as specified.

**Routes.** Query params `from`, `to`, `as_of` as dates. `format` is `json` (default) or `xlsx`. Xlsx responses use a media type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and a filename like `trial-balance-2026-09-30.xlsx`.

**Excel.** openpyxl. Sheet header with the report name and the period. Columns include a display string and the paise integer. Number format on the display column: `₹#,##,##0.00` is acceptable if the Indian digit grouping is already in the string and the cell is text. Prefer writing the display as text produced by `Money.format_inr` so grouping is definitely Indian, and writing paise as integers. Do not let Excel's locale decide the grouping.

**Tests — pin the README worked example exactly**

Build the three entries with the posting service and frozen dates. Assert every figure named in the README section "Worked example":

- Trial balance debit total 61800, credit total 61800, difference 0.
- P&L income 10000, expense 5000, profit 5000 for a window that covers the entries.
- Balance sheet assets 56800, liabilities 1800, equity including earnings 55000, difference 0.
- Statement for bank `1120` from the rent date through the rent date: opening 61800, one credit line 5000, closing 56800. (Capital 50000 plus receipt 11800.)
- A window before any entries: opening 0, no lines, closing 0.
- Reverse the rent. P&L expense returns to 0. Bank closing returns to 61800. Difference stays 0.
- `format=xlsx` trial balance: response starts with PK zip bytes, openpyxl loads a sheet, a cell contains `₹618.00` (61800 paise) and another cell contains integer `61800`.

Add the account statement route on `GET /accounts/{code}/statement` in this phase.

**Done when** report tests pass and services/reports coverage is included in the gate at ≥ 85%.

**Commit**

```text
Add statement, trial balance, P&L, and balance sheet with Excel export
```

---

## Phase J1 — Bank CSV import and matcher

**Goal.** Parse the specified CSV, store lines, and classify them as matched, suggested, or unmatched. Pure matcher tests cover the edge cases before the service is wired.

**Create**

```text
app/importers/csv_bank.py
app/importers/matcher.py
app/importers/__init__.py
app/services/reconciliation.py
app/api/routes/bank.py
app/schemas/bank.py
tests/importers/test_csv_matcher.py
tests/api/test_bank_import.py
```

**Parser.** `parse_bank_csv(data: bytes) -> ParseResult` with `rows: list[ParsedRow]` and `errors: list[RowError]`.

Rules from the README, each with a test:

| Case | Result |
| --- | --- |
| Header missing | file-level error |
| `02/04/2026` | 2 April 2026 |
| `2026-04-05` | 5 April 2026 |
| `15-Jun-2026` | 15 June 2026 |
| `02-04-26` | 2 April 2026 |
| `10/12/2026` | 10 December 2026 |
| `32/01/2026` | row error |
| Withdrawal `1,180.50` and empty deposit | `amount_paise == -118050` |
| Deposit `₹500.00` | `+50000` |
| Both withdrawal and deposit filled | row error |
| Neither filled | row error |
| `10.999` | row error |
| Blank line | skipped |
| UTF-8 BOM | still parses |
| One bad row among three good rows | 1 error, 2 rows, no exception |

**Matcher.** A pure function:

```text
match_lines(statement_rows, journal_candidates, *, window_days, auto_threshold, suggest_threshold) -> list[Decision]
```

`journal_candidates` are dataclasses: `journal_line_id`, `entry_date`, `signed_paise` (positive for a bank debit / money in), `narration`. The function does not touch the database. That is what makes the edge cases fast.

Tests, with thresholds 95 and 70 and window 3:

| Case | Result |
| --- | --- |
| Exact amount, same day, identical narration | `matched`, score 100 |
| Exact amount, date +2 days, narration similar but under 95 and at or above 70, single candidate | `suggested` |
| Exact amount, date +2 days, score ≥ 95 | `matched` |
| Exact amount, date +4 days, identical narration | `unmatched` |
| Amount differs by 100 paise (₹1) | `unmatched` |
| Two ledger lines, same amount, same day, different narrations; CSV clearly closer to one | that one matched or suggested, the other unused |
| Two CSV lines, same amount, same day, two ledger lines | each ledger line used at most once |
| Empty CSV narration, one candidate, exact amount and date | `suggested`, not `matched` |
| Empty CSV narration, two candidates | `unmatched` |
| Top two scores 90 and 86 | `unmatched` because the lead is under 10 |
| Top score 90, runner-up 70 | `suggested` |
| Sign disagrees (CSV deposit vs ledger credit) | not a candidate |
| Already-used journal line passed in a `blocked_ids` set | not chosen |

Greedy order: sort statement rows by ascending candidate count, then descending best score, then row number. Document this in the matcher docstring so the duplicate-amount test has a defined winner when scores tie. Ties on score and candidate count fall back to the lower `journal_line_id`, and the test asserts that deterministic choice.

**Service.** `import_statement(session, *, bank_account_code, filename, content, actor)`:

1. Account must be an active leaf asset. For the seed this is `1120`. Refuse a non-asset.
2. Parse. If there are zero accepted rows, raise `CsvRejected`.
3. Insert statement and lines with status `unmatched`.
4. Load open journal lines on that account: lines not referenced by a `matched` statement line.
5. Run the matcher. Persist status, score, candidate id, matched id.
6. Insert `reconciliation_events` for auto_match and suggest.
7. Commit.
8. Return counts.

Do this inside one transaction. Import does not take the ledger lock, because it does not post. It does need to avoid matching a line that a concurrent confirm is matching. Take a lock by updating the `bank_statements` row you just inserted, and select candidate journal lines with their ids ordered. A partial unique index on `matched_journal_line_id` is the backstop if two imports race. Catch the unique failure, rollback, and raise a conflict the API maps to 409 `ALREADY_MATCHED`. One test can simulate this by pre-matching.

**API.** `POST /bank-statements` multipart: file field `file`, form field `bank_account_code`. Requires `X-Actor`. `GET` statement and `GET` lines with optional `status`.

**Done when** importer tests and one API import test pass, and coverage includes `app/importers`.

**Commit**

```text
Import bank CSVs and match lines by amount, date window, and narration
```

---

## Phase K1 — Confirm, reject, rematch

**Goal.** A person can accept or discard a suggestion, and can match an unmatched line by id, without double-using a journal line.

**Extend** `app/services/reconciliation.py` and `app/api/routes/bank.py`.

**Create** `tests/api/test_reconciliation_decisions.py`.

**Operations**

- `confirm(line_id, actor, journal_line_id: int | None)`. If `journal_line_id` is omitted, use the candidate. Require status `suggested` in that case. If a journal line id is supplied, allow status `suggested` or `unmatched`. Check the journal line belongs to the statement's bank account, the amount and sign agree, and the date window agrees. Confirm does not loosen the exact-amount rule. It may loosen the score rule, because a human is looking at it. It still enforces the window and the amount so a click cannot bind an unrelated voucher. Record `manual_match` when the chosen id was not the candidate; record `confirm` when it was.
- `reject(line_id, actor)`. Status must be `suggested`. Set `rejected`, clear the candidate column, keep the event so rematch will not pick that pair. Store the rejected pair as the event's `journal_line_id` plus action `reject`.
- `rematch(statement_id, actor)`. Re-run the matcher for lines whose status is `unmatched` or `rejected`. `rejected` lines re-enter as unmatched for other candidates, excluding any `(statement_line_id, journal_line_id)` pair that has a `reject` event. Lines already `matched` stay matched.

**Tests**

- Suggest then confirm: status `matched`, event `confirm`, second confirm is 409.
- Two statement lines suggested to different journal lines: confirming both succeeds.
- Two statement lines and a buggy candidate pointing at the same journal line: the second confirm is 409 and the first remains matched.
- Reject then rematch with another viable journal line: the rejected pair is not reused; the other pair can be suggested.
- Reject a matched line: 422.
- Audit route now returns the reconciliation event.

**Done when** decision tests pass.

**Commit**

```text
Let reviewers confirm or reject reconciliation suggestions once
```

---

## Phase L1 — Synthetic books and planted CSV

**Goal.** One command creates the demo dataset described in the README. A test checks the invariants and the planted discrepancies. The data stays fictional.

**Create**

```text
app/seed/__init__.py
app/seed/generate.py
app/seed/__main__.py          # python -m app.seed.generate
tests/seed/test_generate.py
data/seed/.gitkeep
```

**Generator**

- Require an empty journal (`last_sequence == 0`). Otherwise exit with a non-zero status and a one-line message. Do not add entries on top of a live book.
- `seed_chart` then post through `PostingService` and `ReversalService` only. Do not insert journal SQL by hand. The actor is `seed-bot`. Each post gets an idempotency key `seed-{n}` so a bug that calls the generator twice without the guard still could not duplicate inside one process if someone later removes the guard. The guard remains.
- `random.Random(2026)` for every randomized amount, day, and client name. No `random.random` from the global generator.
- Date range 1 April 2026 through 30 September 2026 inclusive.
- Target 280–320 entries. Assert that band at the end and fail the command if the story drifted.
- After posting, `verify_chain` must be ok and `trial_balance` difference must be 0. The command prints entry count, head sequence, and trial balance totals.
- Write the CSV to `data/seed/hdfc_apr_sep_2026.csv` using the discrepancy recipe in the README. Cycle date formats across rows. Apply the recipe by stable references (the seed's own `reference` values such as `RENT-2026-09`), not by list index alone, so a count change does not silently retarget a discrepancy. If a referenced voucher is missing, fail the command.
- Fictional names only. Module docstring states the data is fake and points at the README disclaimer.
- GST pattern for a typical invoice, intra-state: receivable debit = revenue + output CGST + output SGST, with CGST = SGST = 9% of revenue. Compute GST in integer paise: `cgst = revenue_paise * 9 // 100`, and if `2 * cgst` does not equal `revenue_paise * 18 // 100`, put the remainder on SGST so the line still balances. Test this helper with a revenue that does not divide cleanly, for example 101 paise of revenue, and show the entry balances.
- One credit note uses `ReversalService` or an explicit debit to revenue. Prefer an explicit credit-note entry so the books show a partial credit as well as a full reversal somewhere. Include one full reversal of a small office-supplies entry so the chain contains a `reverses_entry_id` in the demo.
- September rent is posted to the bank and then omitted from the CSV (recipe 4).
- Two vendor bills remain unpaid: they have no bank line, so they do not affect the CSV. That gives accounts payable a balance for the dashboard.

**Test**

- Run the generator against a temp database.
- Entry count in range, chain ok, trial balance difference 0, balance sheet difference 0.
- CSV file exists.
- Import that CSV through `import_statement` onto account `1120`.
- Assert the planted outcomes that can be checked without brittleness:
  - at least one unmatched line whose narration contains `unknown credit`
  - at least one unmatched line whose absolute amount is `11800` paise (₹118) or `5900` paise (₹59), the bank charges
  - at least one `suggested` line
  - no journal line id appears twice among matches
  - the September rent ledger line is not matched
  - parser accepted mixed formats (row errors list is empty)

Keep assertions on the recipe's narrations and amounts, which are fixed, and avoid asserting the exact auto-match count, which will move if fuzzy scores move. Assert `matched + suggested + unmatched == accepted rows`.

**Done when** `pytest -q tests/seed/test_generate.py` passes and the printed story is obviously fictional.

**Commit**

```text
Seed six months of fictional books and a bank CSV with known discrepancies
```

---

## Phase M1 — Streamlit client and the first three pages

**Goal.** Dashboard, Post Entry, and Account Statement work against the API.

**Create**

```text
streamlit_app/app.py
streamlit_app/pages/1_Post_Entry.py
streamlit_app/pages/2_Account_Statement.py
streamlit_app/ui/api.py
streamlit_app/ui/formatting.py
tests/ui/test_api_client.py
```

**Client.** `ui/api.py` uses `httpx` with `API_BASE_URL`. It returns parsed JSON or raises `ApiError` carrying `code`, `message`, `details`. Timeouts 10 seconds. The UI catches `ApiError` and shows `st.error(message)`.

**Formatting.** Display fields from the API when present. Rupee form inputs go through `Money.from_rupees_str` in `formatting.py`, which imports `app.core.money`. The Docker image for Streamlit will contain the `app` package for that import. Do not reimplement grouping in the UI.

**Dashboard (`app.py`)**

- Actor text input stored in `st.session_state["actor"]`, default `reviewer`.
- Calls balance sheet as of today, or as of 30 September 2026 when a checkbox "Demo period" is on. Default the checkbox on so a fresh seed looks populated even though "today" in development may be later. Also show cash `1110`, bank `1120`, receivable `1130` from the balance sheet rows or from statement closings.
- Month-to-date profit from P&L for the current month, and when demo period is on, for September 2026.
- Chart: six P&L calls, April through September 2026, `st.bar_chart` or plotly. Add `plotly` to dependencies in this phase if `st.bar_chart` cannot show two series clearly. Prefer `st.bar_chart` with a dataframe of income and expense to avoid a new library unless the labels are unreadable.
- Latest 10 entries from `GET /entries?limit=10`.

**Post Entry**

- Generate `st.session_state["idempotency_key"]` as a UUID when the form is first shown, and regenerate it after a successful 201 so the next voucher is new. A failed 422 keeps the key.
- Dynamic lines: start with two rows. Account select from `GET /accounts` filtered to active leaves, labeled `code — name`.
- Show running debit and credit display totals before submit. Disable submit when they differ or a line is incomplete. The API still enforces the invariant; the button is a courtesy.
- On 201, show sequence number and entry id.

**Account statement**

- Select, from, to. Table of lines plus opening and closing. Download button hits `format=xlsx` and uses `st.download_button`.

**Tests.** The UI client test mocks httpx with `respx` or a stub transport: envelope errors become `ApiError`, a 201 returns the entry id. Do not require Streamlit in the unit test. Add `pytest` coverage exclusion for `streamlit_app` (it is not in the source list).

Browser verification happens in Phase M2 and again in N1, with the app running. This phase's done check is the client test plus a manual click-through if the developer has the API up. Phase N1 makes that click-through mandatory before the last commit.

**Commit**

```text
Add Streamlit pages to post entries and read an account statement
```

---

## Phase M2 — Trial balance, reconciliation, audit

**Goal.** The remaining screens, still only talking to HTTP.

**Create**

```text
streamlit_app/pages/3_Trial_Balance.py
streamlit_app/pages/4_Reconciliation.py
streamlit_app/pages/5_Audit_Log.py
```

**Trial balance page.** As-of date. Table. Show debit and credit grand totals. Under it, two expanders: Profit and loss (from, to) and Balance sheet (as-of). Each has an Excel download. If `difference_paise` is ever non-zero, show the API message in `st.error`. The page does not compute the difference itself.

**Reconciliation page.**

- File uploader and bank account code default `1120`.
- After upload, three sections from `GET .../lines?status=`.
- Suggested rows have Confirm and Reject buttons that call the API and rerun.
- Unmatched rows have a select of recent unmatched journal line ids for that bank account. The API may need `GET /accounts/{code}/statement` or a small `GET /bank-statements/{id}/candidates` added in this phase if the UI cannot know journal line ids. Add `GET /bank-statements/{id}/open-journal-lines` returning id, date, signed paise, narration, display amount. That endpoint is read-only and lives in the reconciliation service. Test it.
- Show matcher score on suggestions.

**Audit page.**

- Table of journal entries: date, actor, narration, sequence, reversal id, first 12 hex chars of `entry_hash`.
- Button "Verify chain" calls `GET /verify-chain` and prints `ok` and `entries_checked`.
- Second table: reconciliation events.

**Manual script for the developer before commit**

1. `make seed` or the module equivalent against the dev database.
2. Run uvicorn and streamlit.
3. Open each page.
4. Post a balanced entry and see it on the dashboard's latest list.
5. Confirm one suggestion and reject one suggestion on the reconciliation page.
6. Verify the chain and see `ok` true.

If browser tools are available in the environment, use them for that script and fix anything that breaks the path. If they are not, say so in the commit body and keep the manual notes.

**Commit**

```text
Add Streamlit views for trial balance, reconciliation, and the audit log
```

---

## Phase N1 — Docker, Makefile, docs, screenshots

**Goal.** A reviewer can clone, compose, seed, test, and read a README that matches the commands they just ran.

**Create**

```text
Dockerfile
docker-compose.yml
Makefile
LICENSE
docs/screenshots/   # png files from the running app
.gitignore
```

**Dockerfile.** `python:3.12-slim`. Install the package. Working directory `/srv`. Default command is the API:

```text
alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000
```

One image is used by both compose services. The Streamlit service overrides the command:

```text
streamlit run streamlit_app/app.py --server.address 0.0.0.0 --server.port 8501
```

**docker-compose.yml**

- Service `api`: port `8000:8000`, env `DATABASE_URL=sqlite:////data/ledger.db`, volume `ledger-data:/data`, healthcheck `GET /health`.
- Service `streamlit`: port `8501:8501`, env `API_BASE_URL=http://api:8000`, `depends_on` api healthy.
- Named volume `ledger-data`.
- No Postgres service required. A commented example `DATABASE_URL` for Postgres can sit in `.env.example` as documentation of the supported dialect, not as a default that breaks `make run`.

**.env.example**

```text
DATABASE_URL=sqlite:///./data/ledger.db
API_BASE_URL=http://localhost:8000
LOG_LEVEL=INFO
```

**.gitignore:** `.venv/`, `__pycache__/`, `.pytest_cache/`, `data/ledger.db`, `htmlcov/`, `.coverage`. Do track `data/seed/hdfc_apr_sep_2026.csv` after generation so a reviewer can open the planted file without seeding, **or** generate it only via `make seed` and leave it gitignored. Decision: commit the CSV if it contains no secrets, which it must not, so the discrepancies are reviewable in the diff. The database file stays gitignored. The generator remains the source of the CSV; committing the output is so GitHub viewers see it. Regenerate and commit the CSV in this phase if the seed phase did not already add it. If the CSV is large but under a megabyte, commit it.

**Makefile** (GNU make; on Windows the README also lists the underlying commands because `make` may be absent):

```makefile
.PHONY: run test seed migrate demo lint

run:
	docker compose up --build

test:
	pytest -q --cov=app/services --cov=app/importers --cov=app/reports --cov-fail-under=85

seed:
	python -m app.seed.generate

migrate:
	alembic upgrade head

demo: migrate seed

lint:
	ruff check app tests streamlit_app
```

`make demo` is the local, non-Docker path. `make run` is Docker. The README explains both.

**README edits in this phase**

- Remove the "commands are not runnable yet" caveat.
- Keep the fictional-data warning.
- Insert the six screenshots.
- Check every path and endpoint against the code. If a route drifted, fix the code or the README in this same commit and say which one you aligned.
- Add a one-paragraph "Design decisions" pointer only if the section is already present — it is. Do not duplicate it.

**Screenshots.** Run the stack, seed the volume, capture the six files named in the README. Each must show the condition listed there. Crop browser chrome if it hides the data. Do not mock the numbers in an image editor.

**Verification before the commit**

```bash
make test
make lint
docker compose up --build
```

Then, against the compose stack: `/health`, `/docs`, post one entry with an idempotency key twice via curl and confirm a single sequence advance, `make seed` via `docker compose exec api python -m app.seed.generate`, open Streamlit and exercise dashboard, post, statement, trial balance, confirm a suggestion, verify chain. Then take screenshots.

If `make` is unavailable on the machine, run the underlying commands and note that in the README's Windows section with PowerShell equivalents. The Makefile still ships for reviewers on macOS and Linux.

**LICENSE.** MIT, copyright the author name already used in the git config. Read it from `git log` or the existing repo config without modifying git config.

**Done when**

- `make test` (or pytest equivalent) is green at ≥ 85% on the gated packages.
- Compose brings up `/docs` and Streamlit.
- The double-posted curl created one entry.
- Screenshots exist and are linked.
- README setup steps were executed as written.

**Commit**

```text
Package the ledger for Docker Compose and document how to run it
```

---

## Traceability

Every requirement in the original brief maps to a phase and a test.

| Requirement | Phase | Test |
| --- | --- | --- |
| Account types, parent/child, codes | B1, H1 | `test_constraints`, `test_accounts_api` |
| Indian small-business chart | B1, L1 | `seed_chart` idempotency, generator test |
| Entry has 2+ lines | C1 | `test_posting` one-line case |
| Debits equal credits, else a clear error | C1, H1 | unit test and 422 envelope |
| Append-only, no update or delete | B1 | trigger tests |
| Reversal via `reverses_entry_id` | D1 | `test_reversal` |
| `created_by`, `created_at` | C1, H1 | posting and API body |
| Idempotency-Key replay | F1, H1, G1 | unit, API, two-thread |
| Account statement with running balance and dates | I1, M1 | worked example window |
| Trial balance | I1, E1 | worked example and Hypothesis |
| P&L | I1 | worked example |
| Balance sheet | I1 | worked example |
| Excel export | I1 | zip bytes and paise cell |
| CSV upload into `bank_statement_lines` | J1 | import test |
| Auto-match amount, ±3 days, rapidfuzz | J1 | matcher table |
| Matched, unmatched, suggested lists | J1, M2 | API status filter, page |
| Manual confirm and reject | K1, M2 | decision tests |
| SHA-256 chain and `/verify-chain` | D1, H1 | golden vector, tamper, API |
| Integer paise, no float money | A1 | `test_money` |
| Money formatted as INR at display | A1, I1 | format table, Excel text |
| Invariant in the service and in the database | C1, B1 | service rollback test, CHECKs, triggers |
| Single transaction | C1 | rollback leaves no rows |
| Postgres row lock, SQLite serialized writes | C1, G1 | concurrency tests |
| Layers api / services / models / schemas / reports / importers | all | review at N1; no balance math in routes |
| Pydantic, error envelope, structured logs | A1, H1 | envelope test |
| Hypothesis property | E1 | `test_ledger_invariants` |
| Matcher edge cases | J1 | `test_csv_matcher` |
| 85% on services | C1 onward | coverage fail-under |
| ~300 fake transactions, planted CSV, disclaimer | L1, README | generator test, README banner |
| Streamlit pages listed | M1, M2 | manual plus browser pass in N1 |
| Dockerfile, compose, Makefile | N1 | compose smoke |
| README sections: problem, mermaid, data model, trade-offs, setup, screenshots, what next | README now, screenshots in N1 | checklist in N1 |
| OpenAPI `/docs` | H1, N1 | schema test and browser |

## Coverage map for `app/services`

Planned so the gate is a result of the tests above, not a last-minute scramble.

| Module | Functions | Tests |
| --- | --- | --- |
| `locking.py` | `lock_ledger` | posting and concurrency |
| `balances.py` | `balance_paise` | overdraft cases |
| `posting.py` | `post` | `test_posting`, API, property |
| `hashing.py` | `canonical_v1`, `verify_chain` | golden, tamper, property |
| `reversal.py` | `reverse` | `test_reversal` |
| `idempotency.py` | `request_hash`, lookup inside post | `test_idempotency` |
| `accounts.py` | create, deactivate, list | `test_accounts_api` |
| `reporting.py` | four reports plus difference | `test_reports`, property |
| `reconciliation.py` | import, confirm, reject, rematch | importer API tests, decision tests |

Error branches that must be executed at least once: unbalanced, one line, missing account, group account, inactive account, overdraft, idempotency conflict, replay, already reversed, CSV with zero good rows, confirm of a taken journal line, actor missing.

## Risk register

| Risk | What to do |
| --- | --- |
| SQLAlchemy opens a transaction before the SQLite lock update, so the lock is not actually first | In C1, log the SQL once. The lock `UPDATE` must be the first write. Reads before it are fine. If a hidden write happens first, move the lock into a `begin` event |
| `busy_timeout` still raises `database is locked` under load | The concurrency test is the proof. Increase timeout only if a slow hash shows the waiter gave up inside 5 seconds. Do not catch `database is locked` and report success |
| Hypothesis plus file-copy fixtures are slow | 50 examples is the cap. If a run exceeds a few minutes, shrink the chart setup, not the assertions |
| Deferred Postgres trigger is untested because CI is SQLite | The service assertion covers the invariant on SQLite. The trigger SQL is still in the migration. A later CI job can run it. Do not delete the Postgres branch because it is untested |
| Streamlit session state resubmits a voucher | The idempotency key stored on the form is the mitigation. M1 tests the client; M2 manual pass double-clicks submit |
| Seed count drifts out of 280–320 after a story edit | The generator test fails the command. Adjust counts deliberately |
| Fuzzy threshold makes the planted `AWS Indai` row auto-match or fall to unmatched | The seed test asserts `suggested` for that narration pair. If rapidfuzz scores it ≥ 95, change the typo in the recipe until the score sits in the suggest band, and record the score in a comment. Do not lower the global auto threshold to save one row |
| Indian number format reimplemented differently in Excel and UI | Both call `Money.format_inr` |
| An editor adds `float` in a report "just for the chart" | Chart dataframes use paise integers or the display string. Review the diff in I1 and M1 for the token `float` |

## Definition of done

The project is complete when all of the following are true:

- Phases A1 through N1 are committed in order.
- `pytest` with the coverage gate is green.
- `GET /docs` lists the routes in the README table.
- Posting an unbalanced entry returns the error envelope and leaves the chain head unchanged.
- Repeating a post with the same idempotency key returns the original entry.
- The concurrency test has been run and is part of the suite.
- The Hypothesis test is part of the suite.
- `python -m app.seed.generate` loads the fictional Anaya Studio books, the chain verifies, and the planted CSV produces matched, suggested, and unmatched lines.
- Streamlit can post, filter a statement, show a balanced trial balance, confirm a match, and verify the chain.
- The README's setup steps and screenshots match that run.
- The README still says the data is fake.

## What this plan deliberately leaves out

Authentication, period close, a Postgres compose service, multi-user editing, and a statement-balance reconciliation report are described under "What I'd do next" in the README. They are not phases. Do not start them during N1.

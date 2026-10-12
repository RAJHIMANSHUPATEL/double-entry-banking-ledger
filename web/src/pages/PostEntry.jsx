import { useEffect, useMemo, useState } from "react";
import { formatInr, parseRupees } from "@ledger/money";
import { ApiError, request } from "../api.js";
import { useActor } from "../actor.jsx";

function blankLine() {
  return { accountCode: "", amount: "", side: "debit" };
}

function paiseOf(line) {
  if (!line.amount.trim() || !line.accountCode) return null;
  try {
    const paise = parseRupees(line.amount);
    return paise > 0 ? paise : null;
  } catch {
    return null;
  }
}

export function PostEntry() {
  const { actor } = useActor();
  const [accounts, setAccounts] = useState([]);
  const [entryDate, setEntryDate] = useState("2026-09-30");
  const [narration, setNarration] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState([blankLine(), blankLine()]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [posted, setPosted] = useState(null);

  useEffect(() => {
    request("/accounts")
      .then((body) => setAccounts(body.accounts.filter((account) => account.is_active && !account.is_group)))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "Accounts could not be loaded."));
  }, []);

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let complete = narration.trim().length > 0;
    for (const line of lines) {
      const paise = paiseOf(line);
      if (paise == null) complete = false;
      else if (line.side === "debit") debit += paise;
      else credit += paise;
    }
    return { debit, credit, complete: complete && lines.length >= 2 && debit === credit && debit > 0 };
  }, [lines, narration]);

  function update(index, patch) {
    setLines((current) => current.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)));
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setPosted(null);
    const body = {
      entry_date: entryDate,
      narration: narration.trim(),
      reference: reference.trim() || null,
      lines: lines.map((line) => {
        const paise = paiseOf(line);
        return {
          account_code: line.accountCode,
          debit_paise: line.side === "debit" ? paise : 0,
          credit_paise: line.side === "credit" ? paise : 0,
        };
      }),
    };
    try {
      const result = await request("/entries", { method: "POST", body, actor, idempotencyKey });
      setPosted(result);
      setIdempotencyKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The entry was not posted.");
    }
  }

  return (
    <section>
      <h1>Post entry</h1>
      <p className="muted">Idempotency key {idempotencyKey}</p>
      {error ? <p className="error">{error}</p> : null}
      {posted ? (
        <p className="ok">
          Posted sequence {posted.sequence_no}, entry {posted.id}.
        </p>
      ) : null}
      <form onSubmit={submit} className="stack">
        <div className="row">
          <label>
            Date
            <input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required />
          </label>
          <label>
            Reference
            <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={64} />
          </label>
        </div>
        <label>
          Narration
          <input value={narration} onChange={(event) => setNarration(event.target.value)} maxLength={500} required />
        </label>
        {lines.map((line, index) => (
          <div className="line" key={index}>
            <select value={line.accountCode} onChange={(event) => update(index, { accountCode: event.target.value })}>
              <option value="">Account</option>
              {accounts.map((account) => (
                <option key={account.code} value={account.code}>
                  {account.code} — {account.name}
                </option>
              ))}
            </select>
            <select value={line.side} onChange={(event) => update(index, { side: event.target.value })}>
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
            </select>
            <input
              value={line.amount}
              placeholder="0.00"
              onChange={(event) => update(index, { amount: event.target.value })}
              inputMode="decimal"
            />
            {lines.length > 2 ? (
              <button type="button" className="ghost" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>
                Remove
              </button>
            ) : null}
          </div>
        ))}
        <div className="row totals">
          <span>Debit {formatInr(totals.debit)}</span>
          <span>Credit {formatInr(totals.credit)}</span>
          <button type="button" className="ghost" onClick={() => setLines((current) => [...current, blankLine()])}>
            Add line
          </button>
          <button type="submit" disabled={!totals.complete || !actor.trim()}>
            Post
          </button>
        </div>
      </form>
    </section>
  );
}

import { useEffect, useState } from "react";
import { ApiError, request, saveBlob } from "../api.js";

export function Statement() {
  const [accounts, setAccounts] = useState([]);
  const [code, setCode] = useState("1120");
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2026-09-30");
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    request("/accounts")
      .then((body) => setAccounts(body.accounts.filter((account) => account.is_active && !account.is_group)))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "Accounts could not be loaded."));
  }, []);

  async function load(event) {
    event.preventDefault();
    setError("");
    try {
      setStatement(await request(`/accounts/${code}/statement?from=${from}&to=${to}`));
    } catch (cause) {
      setStatement(null);
      setError(cause instanceof ApiError ? cause.message : "The statement could not be loaded.");
    }
  }

  async function download() {
    try {
      const blob = await request(`/accounts/${code}/statement?from=${from}&to=${to}&format=xlsx`);
      saveBlob(blob, `statement-${code}-${from}-${to}.xlsx`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The workbook could not be downloaded.");
    }
  }

  return (
    <section>
      <h1>Account statement</h1>
      {error ? <p className="error">{error}</p> : null}
      <form onSubmit={load} className="row">
        <label>
          Account
          <select value={code} onChange={(event) => setCode(event.target.value)}>
            {accounts.map((account) => (
              <option key={account.code} value={account.code}>
                {account.code} — {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} required />
        </label>
        <button type="submit">Show</button>
        <button type="button" className="ghost" onClick={download}>
          Excel
        </button>
      </form>
      {statement ? (
        <>
          <p>
            Opening {statement.opening_display} · Closing {statement.closing_display}
          </p>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Narration</th>
                <th>Debit</th>
                <th>Credit</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {statement.lines.map((line, index) => (
                <tr key={`${line.entry_id}-${index}`}>
                  <td>{line.entry_date}</td>
                  <td>{line.line_narration || line.narration}</td>
                  <td>{line.debit_display}</td>
                  <td>{line.credit_display}</td>
                  <td>{line.running_display}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

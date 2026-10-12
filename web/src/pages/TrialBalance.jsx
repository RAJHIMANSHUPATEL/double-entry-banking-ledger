import { useState } from "react";
import { ApiError, request, saveBlob } from "../api.js";

export function TrialBalance() {
  const [asOf, setAsOf] = useState("2026-09-30");
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2026-09-30");
  const [trial, setTrial] = useState(null);
  const [profit, setProfit] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [error, setError] = useState("");

  async function load(event) {
    event.preventDefault();
    setError("");
    try {
      const [trialBalance, profitAndLoss, balanceSheet] = await Promise.all([
        request(`/reports/trial-balance?as_of=${asOf}`),
        request(`/reports/profit-and-loss?from=${from}&to=${to}`),
        request(`/reports/balance-sheet?as_of=${asOf}`),
      ]);
      setTrial(trialBalance);
      setProfit(profitAndLoss);
      setSheet(balanceSheet);
      if (trialBalance.difference_paise !== 0) {
        setError(`Trial balance difference ${trialBalance.difference_display}`);
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The trial balance could not be loaded.");
    }
  }

  async function download(path, filename) {
    try {
      saveBlob(await request(path), filename);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The workbook could not be downloaded.");
    }
  }

  return (
    <section>
      <h1>Trial balance</h1>
      {error ? <p className="error">{error}</p> : null}
      <form onSubmit={load} className="row">
        <label>
          As of
          <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} required />
        </label>
        <button type="submit">Show</button>
        <button type="button" className="ghost" onClick={() => download(`/reports/trial-balance?as_of=${asOf}&format=xlsx`, `trial-balance-${asOf}.xlsx`)}>
          Excel
        </button>
      </form>
      {trial ? (
        <>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Account</th>
                <th>Debit</th>
                <th>Credit</th>
              </tr>
            </thead>
            <tbody>
              {trial.rows.map((row) => (
                <tr key={row.code}>
                  <td>{row.code}</td>
                  <td>{row.name}</td>
                  <td>{row.debit_display}</td>
                  <td>{row.credit_display}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td>Total</td>
                <td>{trial.debit_total_display}</td>
                <td>{trial.credit_total_display}</td>
              </tr>
            </tfoot>
          </table>
          <details>
            <summary>Profit and loss</summary>
            <div className="row">
              <label>
                From
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <label>
                To
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </label>
              <button type="button" onClick={load}>
                Refresh
              </button>
              <button type="button" className="ghost" onClick={() => download(`/reports/profit-and-loss?from=${from}&to=${to}&format=xlsx`, `profit-and-loss-${from}-${to}.xlsx`)}>
                Excel
              </button>
            </div>
            {profit ? (
              <p>
                Income {profit.income_total_display} · Expense {profit.expense_total_display} · Profit {profit.profit_display}
              </p>
            ) : null}
          </details>
          <details>
            <summary>Balance sheet</summary>
            <button type="button" className="ghost" onClick={() => download(`/reports/balance-sheet?as_of=${asOf}&format=xlsx`, `balance-sheet-${asOf}.xlsx`)}>
              Excel
            </button>
            {sheet ? (
              <p>
                Assets {sheet.balances.assets_display} · Liabilities {sheet.balances.liabilities_display} · Equity {sheet.balances.equity_including_earnings_display}
              </p>
            ) : null}
            {sheet?.balances.difference_paise !== 0 ? <p className="error">Balance sheet difference {sheet.balances.difference_display}</p> : null}
          </details>
        </>
      ) : null}
    </section>
  );
}

import { useEffect, useState } from "react";
import { ApiError, request } from "../api.js";

const MONTHS = [
  ["2026-04-01", "2026-04-30", "Apr"],
  ["2026-05-01", "2026-05-31", "May"],
  ["2026-06-01", "2026-06-30", "Jun"],
  ["2026-07-01", "2026-07-31", "Jul"],
  ["2026-08-01", "2026-08-31", "Aug"],
  ["2026-09-01", "2026-09-30", "Sep"],
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function Dashboard() {
  const [demo, setDemo] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const asOf = demo ? "2026-09-30" : today();
    const monthFrom = demo ? "2026-09-01" : `${asOf.slice(0, 7)}-01`;
    setError("");
    Promise.all([
      request(`/reports/balance-sheet?as_of=${asOf}`),
      request(`/reports/profit-and-loss?from=${monthFrom}&to=${asOf}`),
      Promise.all(MONTHS.map(([from, to]) => request(`/reports/profit-and-loss?from=${from}&to=${to}`))),
      request("/entries?limit=10"),
    ])
      .then(([sheet, profit, months, entries]) => {
        if (!cancelled) setData({ asOf, sheet, profit, months, entries: entries.entries });
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : "The dashboard could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [demo]);

  const row = (code) => data?.sheet.assets.find((item) => item.code === code);

  return (
    <section>
      <header className="page-head">
        <h1>Dashboard</h1>
        <label className="check">
          <input type="checkbox" checked={demo} onChange={(event) => setDemo(event.target.checked)} />
          Demo period
        </label>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {data ? (
        <>
          <div className="tiles">
            <Tile label="Cash" value={row("1110")?.amount_display ?? "₹0.00"} />
            <Tile label="Bank" value={row("1120")?.amount_display ?? "₹0.00"} />
            <Tile label="Receivable" value={row("1130")?.amount_display ?? "₹0.00"} />
            <Tile label="Month profit" value={data.profit.profit_display} />
          </div>
          <h2>April to September</h2>
          <MonthBars months={data.months} />
          <h2>Latest entries</h2>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Sequence</th>
                <th>Narration</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.entry_date}</td>
                  <td>{entry.sequence_no}</td>
                  <td>{entry.narration}</td>
                  <td>{entry.debit_total_display}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

function Tile({ label, value }) {
  return (
    <article className="tile">
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function MonthBars({ months }) {
  const peak = Math.max(1, ...months.flatMap((month) => [month.income_total_paise, month.expense_total_paise]));
  return (
    <svg className="bars" viewBox="0 0 640 220" role="img" aria-label="Income and expense by month">
      {months.map((month, index) => {
        const income = (month.income_total_paise / peak) * 150;
        const expense = (month.expense_total_paise / peak) * 150;
        const x = 30 + index * 100;
        return (
          <g key={MONTHS[index][2]}>
            <rect x={x} y={170 - income} width="28" height={income} fill="#9a3412" />
            <rect x={x + 34} y={170 - expense} width="28" height={expense} fill="#1c1915" />
            <text x={x + 28} y="196" textAnchor="middle" fill="#6b6258" fontSize="14">
              {MONTHS[index][2]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

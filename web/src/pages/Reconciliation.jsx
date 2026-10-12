import { useState } from "react";
import { ApiError, request } from "../api.js";
import { useActor } from "../actor.jsx";

export function Reconciliation() {
  const { actor } = useActor();
  const [code, setCode] = useState("1120");
  const [statement, setStatement] = useState(null);
  const [lines, setLines] = useState([]);
  const [openLines, setOpenLines] = useState([]);
  const [choices, setChoices] = useState({});
  const [error, setError] = useState("");

  async function refresh(id) {
    const [body, open] = await Promise.all([
      request(`/bank-statements/${id}/lines`),
      request(`/bank-statements/${id}/open-journal-lines`),
    ]);
    setLines(body.lines);
    setOpenLines(open.lines);
  }

  async function upload(event) {
    event.preventDefault();
    setError("");
    const file = event.target.elements.file.files[0];
    if (!file) return;
    const body = new FormData();
    body.append("bank_account_code", code);
    body.append("file", file);
    try {
      const imported = await request("/bank-statements", { method: "POST", body, actor });
      setStatement(imported);
      await refresh(imported.id);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The CSV could not be imported.");
    }
  }

  async function act(lineId, action, journalLineId) {
    setError("");
    try {
      if (action === "confirm") {
        await request(`/bank-statement-lines/${lineId}/confirm`, { method: "POST", body: {}, actor });
      } else if (action === "reject") {
        await request(`/bank-statement-lines/${lineId}/reject`, { method: "POST", actor });
      } else {
        await request(`/bank-statement-lines/${lineId}/match`, {
          method: "POST",
          body: { journal_line_id: Number(journalLineId) },
          actor,
        });
      }
      await refresh(statement.id);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The decision could not be saved.");
    }
  }

  const grouped = {
    suggested: lines.filter((line) => line.match_status === "suggested"),
    unmatched: lines.filter((line) => line.match_status === "unmatched"),
    matched: lines.filter((line) => line.match_status === "matched"),
  };

  return (
    <section>
      <h1>Reconciliation</h1>
      {error ? <p className="error">{error}</p> : null}
      <form onSubmit={upload} className="row">
        <label>
          Bank account
          <input value={code} onChange={(event) => setCode(event.target.value)} />
        </label>
        <label>
          CSV
          <input name="file" type="file" accept=".csv,text/csv" required />
        </label>
        <button type="submit" disabled={!actor.trim()}>
          Upload
        </button>
      </form>
      {statement ? (
        <p className="muted">
          Statement {statement.id}: {statement.counts.matched} matched, {statement.counts.suggested} suggested, {statement.counts.unmatched} unmatched
        </p>
      ) : null}
      <h2>Suggested</h2>
      <LineTable lines={grouped.suggested} extra={(line) => (
        <>
          <td>Score {line.match_score}</td>
          <td>
            <button type="button" onClick={() => act(line.id, "confirm")}>Confirm</button>
            <button type="button" className="ghost" onClick={() => act(line.id, "reject")}>Reject</button>
          </td>
        </>
      )} />
      <h2>Unmatched</h2>
      <LineTable lines={grouped.unmatched} extra={(line) => (
        <td>
          <select value={choices[line.id] ?? ""} onChange={(event) => setChoices({ ...choices, [line.id]: event.target.value })}>
            <option value="">Journal line</option>
            {openLines.map((journal) => (
              <option key={journal.id} value={journal.id}>
                {journal.id} · {journal.entry_date} · {journal.amount_display} · {journal.narration}
              </option>
            ))}
          </select>
          <button type="button" disabled={!choices[line.id]} onClick={() => act(line.id, "match", choices[line.id])}>
            Match
          </button>
        </td>
      )} />
      <h2>Matched</h2>
      <LineTable lines={grouped.matched} extra={() => null} />
    </section>
  );
}

function LineTable({ lines, extra }) {
  if (lines.length === 0) return <p className="muted">None.</p>;
  return (
    <table>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id}>
            <td>{line.txn_date}</td>
            <td>{line.narration || "(blank narration)"}</td>
            <td>{line.amount_display}</td>
            {extra(line)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

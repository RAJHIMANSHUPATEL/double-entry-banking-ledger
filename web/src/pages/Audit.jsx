import { useEffect, useState } from "react";
import { ApiError, request } from "../api.js";

export function Audit() {
  const [journal, setJournal] = useState([]);
  const [events, setEvents] = useState([]);
  const [chain, setChain] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    const body = await request("/audit");
    setJournal(body.journal);
    setEvents(body.reconciliation);
  }

  useEffect(() => {
    load().catch((cause) => setError(cause instanceof ApiError ? cause.message : "The audit log could not be loaded."));
  }, []);

  async function verify() {
    setError("");
    try {
      setChain(await request("/verify-chain"));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The chain could not be verified.");
    }
  }

  return (
    <section>
      <header className="page-head">
        <h1>Audit log</h1>
        <button type="button" onClick={verify}>Verify chain</button>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {chain ? (
        <p className={chain.ok ? "ok" : "error"}>
          ok: {String(chain.ok)} · entries checked {chain.entries_checked}
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Actor</th>
            <th>Narration</th>
            <th>Sequence</th>
            <th>Reverses</th>
            <th>Hash</th>
          </tr>
        </thead>
        <tbody>
          {journal.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.entry_date}</td>
              <td>{entry.created_by}</td>
              <td>{entry.narration}</td>
              <td>{entry.sequence_no}</td>
              <td>{entry.reverses_entry_id ?? ""}</td>
              <td>{entry.entry_hash.slice(0, 12)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Reconciliation</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Journal line</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{event.created_at}</td>
              <td>{event.action}</td>
              <td>{event.actor}</td>
              <td>{event.journal_line_id ?? ""}</td>
              <td>{event.score ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

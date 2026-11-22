import React, { useMemo, useState } from "react";
import Json from "../components/JsonPane";
import "./run-observability.css";

/*
  "What each layer logged for this run" (Rule 27): the log lines one run left behind, in time order, for six layers.
  The family's one panel for it. The record is built server-side by runObservability.js (vendored beside the server code).

  <RunObservability record={record} source="mock" | "real" streams={[{ product, lives, streams }]} />
  Optional: title (heading).

  record = {                                     (collectRun() output; a lab's API answers it as JSON)
    runId, window: { from, to }, source: "mock" | "real", excerpt: true, truncated,
    rows: [{ id, at (ISO) | null, atExact?, layer, product, outcome: "allowed"|"refused"|"blocked"|"info",
             message, origin: "logged"|"simulated"|"response"|"not-logged", basis?: "measured-shape"|"unverified-shape",
             matchedBy?: "id"|"window", detail? }],
    coverage: { person|agent|authorize|privilege|gateway|resource: "logged"|"simulated"|"response"|"not-logged"|"unreachable" },
    reasons: { <layer>: string },                (why a layer is not-logged or unreachable)
    summary: { allowed, refused, blocked, info }
  }
  A lab's API that failed answers { error, message } (Rule 23): pass that as the record and the panel shows it.
  streams: where each product's logs live and where they stream (Rule 27). The lab's README says the same.

  HONESTY. origin "logged" = a real line read from the product's own log, with its own timestamp. "simulated" = the lab's mock computed it.
  "response" = a decision the lab already holds as an API response (a PingOne Authorize permit or deny and its policy): real, but it was NOT
  read from a log, so it is never tagged or counted as logged.
  "not-logged" = no line was found: the panel says so and never claims one. An "info" row is never counted as passed.
  Any JSON is drawn by the shared JsonPane (Rule 24): the lab vendors it at web/src/components/JsonPane.jsx.
*/

const LAYERS = [
  { id: "person", label: "Person", what: "who signed in" },
  { id: "agent", label: "Agent", what: "who acted for them" },
  { id: "authorize", label: "Authorize", what: "PingOne Authorize decisions" },
  { id: "privilege", label: "Privilege", what: "policy, AI Guard and approvals" },
  { id: "gateway", label: "Agent gateway", what: "allowed, refused or blocked" },
  { id: "resource", label: "Resource server", what: "the tool call served or refused" },
];
const LABEL = Object.fromEntries(LAYERS.map((l) => [l.id, l.label]));
const COVERAGE_LABEL = { logged: "Logged", simulated: "Simulated", response: "Response", "not-logged": "Not logged", unreachable: "Unreachable" };
const OUTCOME_LABEL = { allowed: "ALLOWED", refused: "REFUSED", blocked: "BLOCKED", info: "INFO" };
const GLYPH = { allowed: "✓", refused: "✕", blocked: "■", info: "i" };
const ORIGIN_LABEL = { logged: "logged", simulated: "simulated", response: "response", "not-logged": "not logged" };
const ORIGIN_NOTE = {
  logged: "A line read, read-only, from the product's own log, shown with that line's own timestamp. Ids, tokens and addresses are masked.",
  simulated: "Computed by the lab's mock. It was not read from any product log.",
  response: "A decision the lab already holds as the response of an API call. It is real, but it was not read from a product log, so it is not marked logged.",
  "not-logged": "No line was found for this layer in the run's window. The product may not log this event; nothing is claimed here.",
};
const HOT = ["outcome", "origin", "basis"];

const timeOf = (r) => (r.at ? r.atExact || r.at : "no timestamp");
const byTime = (a, b) => (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : a.at ? -1 : b.at ? 1 : 0);

function Lane({ layer, rows, coverage, reason, active, onPick }) {
  const own = rows.filter((r) => r.layer === layer.id && r.origin !== "not-logged");
  return (
    <li className="ro-lane" data-testid={`ro-lane-${layer.id}`} data-layer={layer.id} data-coverage={coverage || "unknown"}>
      <button type="button" className="ro-lane-name" aria-pressed={active} onClick={onPick} title={`Show only ${layer.label} rows`}>
        {layer.label}
      </button>
      <span className="ro-chip" data-coverage={coverage || "unknown"} data-testid={`ro-coverage-${layer.id}`}>
        {COVERAGE_LABEL[coverage] || "Not reported"}
      </span>
      <span className="ro-what">{layer.what}</span>
      <span className="ro-marks" aria-label={`${own.length} events`}>
        {own.map((r) => (
          <span key={r.id} className="ro-mark" data-outcome={r.outcome} title={`${timeOf(r)}: ${r.outcome}: ${r.message}`} role="img" aria-label={`${r.outcome} at ${timeOf(r)}`}>{GLYPH[r.outcome]}</span>
        ))}
      </span>
      {reason && <span className="ro-reason" data-testid={`ro-reason-${layer.id}`}>{reason}</span>}
    </li>
  );
}

function Detail({ row, hot }) {
  const { id, ...shown } = row; // eslint-disable-line no-unused-vars
  return (
    <div className="ro-detail" data-testid={`ro-detail-${row.id}`}>
      <p className="ro-muted">{ORIGIN_NOTE[row.origin]}</p>
      {row.basis === "unverified-shape" && (
        <p className="ro-muted" data-testid={`ro-unverified-${row.id}`}><strong>UNVERIFIED line shape.</strong> This kind of line has not been measured against a real product log, so read the outcome with care.</p>
      )}
      {row.matchedBy === "window" && <p className="ro-muted">Matched by the run's time window only, not by an id from the run.</p>}
      <Json value={shown} label="Log row" testId={`ro-row-${row.id}`} hot={hot} />
    </div>
  );
}

const LEGEND = [
  ["logged", "a line read, read-only, from the product's own log, with its own timestamp"],
  ["response", "a decision the lab holds as an API response; real, but not read from a log"],
  ["simulated", "computed by the lab's mock"],
  ["not-logged", "no line was found; nothing is claimed"],
];

function Legend() {
  return (
    <ul className="ro-legend" data-testid="ro-legend" aria-label="What the origin tags mean">
      {LEGEND.map(([o, t]) => <li key={o}><span className="ro-chip" data-origin={o}>{ORIGIN_LABEL[o]}</span> {t}</li>)}
    </ul>
  );
}

function Streams({ streams }) {
  const list = Array.isArray(streams) ? streams : [];
  return (
    <details className="ro-streams" data-testid="ro-streams">
      <summary>Where these logs live and where they stream</summary>
      {list.length === 0
        ? <p className="ro-muted" data-testid="ro-streams-empty">This lab has not said where its logs live or where they stream.</p>
        : (
          <ul>
            {list.map((s) => (
              <li key={s.product}><strong>{s.product}</strong>: lives in {s.lives}; streams to {s.streams}.</li>
            ))}
          </ul>
        )}
    </details>
  );
}

export default function RunObservability({ record, source, streams, title = "What each layer logged for this run", hot }) {
  const [layer, setLayer] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const keys = Array.isArray(hot) ? hot : HOT;
  const rows = useMemo(() => (Array.isArray(record?.rows) ? [...record.rows].sort(byTime) : []), [record]);
  const shown = layer ? rows.filter((r) => r.layer === layer) : rows;
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const head = (
    <>
      <h2>{title}</h2>
      <p className="ro-lead">Excerpt of this run's logs. Ids, tokens and addresses are masked.</p>
      <p className="ro-muted" data-testid="ro-basis">
        {source === "real"
          ? "Real: each row marked logged is a line read, read-only, from the product's own log, with its own timestamp. A layer shows not logged when no line was found for this run; nothing is claimed for it. A row marked response is a decision the lab holds as an API response, not a log line."
          : "Simulated: the lab's mock computed these rows. None of them was read from a product log."}
      </p>
    </>
  );

  let body;
  if (!record) {
    body = <p className="ro-muted" data-testid="ro-empty">Run the demo: the log lines each layer wrote for the run appear here, in time order.</p>;
  } else if (record.error) {
    body = (
      <div className="ro-error" role="alert" data-testid="ro-error">
        <strong>The run's logs could not be collected.</strong> {record.message || record.error}
      </div>
    );
  } else if (record.source && source && record.source !== source) {
    body = (
      <div className="ro-error" role="alert" data-testid="ro-mismatch">
        <strong>Not shown.</strong> This record was collected in {record.source} mode but the page is in {source} mode. Run again.
      </div>
    );
  } else {
    const counted = rows.filter((r) => r.origin !== "not-logged");
    const n = (o) => counted.filter((r) => r.outcome === o).length;
    body = (
      <>
        <p className="ro-summary" data-testid="ro-summary">
          {counted.length === 0
            ? "No log lines in this excerpt."
            : `${n("allowed")} allowed, ${n("refused")} refused, ${n("blocked")} blocked, ${n("info")} for information (information is not a pass).`}
          {" "}Window {record.window?.from} to {record.window?.to}.
        </p>
        <Legend />
        <ol className="ro-lanes" data-testid="ro-lanes" aria-label="Layers">
          {LAYERS.map((l) => (
            <Lane key={l.id} layer={l} rows={rows} coverage={record.coverage?.[l.id]} reason={record.reasons?.[l.id]}
              active={layer === l.id} onPick={() => setLayer(layer === l.id ? null : l.id)} />
          ))}
        </ol>
        {record.truncated && <p className="ro-muted" data-testid="ro-truncated">This excerpt was cut at the row or line cap; narrow the run's window to see the rest.</p>}
        {layer && (
          <p className="ro-muted" data-testid="ro-filter-note">
            Showing {shown.length} of {rows.length} rows ({LABEL[layer]} only).{" "}
            <button type="button" className="ro-link" onClick={() => setLayer(null)}>Show all layers</button>
          </p>
        )}
        {shown.length === 0
          ? <p className="ro-muted" data-testid="ro-no-rows">No rows to show. The layers above say why: a layer that is not logged or unreachable has no lines.</p>
          : (
            <table className="ro-table" data-testid="ro-table">
              <thead>
                <tr><th scope="col">Time</th><th scope="col">Layer</th><th scope="col">Product</th><th scope="col">Outcome</th><th scope="col">Message</th><th scope="col">Origin</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const isOpen = open.has(r.id);
                  return (
                    <React.Fragment key={r.id}>
                      <tr className="ro-row" data-testid={`ro-row-${r.id}-line`} data-layer={r.layer} data-outcome={r.outcome} data-origin={r.origin}>
                        <td data-label="Time" className="ro-time">
                          <button type="button" className="ro-expand" aria-expanded={isOpen} aria-controls={`ro-x-${r.id}`} onClick={() => toggle(r.id)}>
                            <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> {timeOf(r)}
                          </button>
                        </td>
                        <td data-label="Layer">{LABEL[r.layer] || r.layer}</td>
                        <td data-label="Product">{r.product}</td>
                        <td data-label="Outcome"><span className="ro-chip" data-outcome={r.outcome}>{OUTCOME_LABEL[r.outcome] || r.outcome}</span></td>
                        <td data-label="Message" className="ro-msg">{r.message}</td>
                        <td data-label="Origin">
                          <span className="ro-chip" data-origin={r.origin}>{ORIGIN_LABEL[r.origin] || r.origin}</span>
                          {r.basis === "unverified-shape" && <span className="ro-tag">UNVERIFIED shape</span>}
                          {r.matchedBy === "window" && <span className="ro-tag">time window</span>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="ro-xrow" id={`ro-x-${r.id}`}><td colSpan={6}><Detail row={r} hot={keys} /></td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
      </>
    );
  }

  return (
    <section className="ro" data-testid="run-observability" aria-label={title}>
      {head}
      {body}
      <Streams streams={streams} />
    </section>
  );
}

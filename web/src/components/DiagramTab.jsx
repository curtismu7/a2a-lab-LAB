import { useEffect, useMemo, useState } from "react";
import PatternDiagram from "./PatternDiagram";
import { getJson } from "../api";

// The run's hops name the actors (agent, gateway, registry, tool); the diagram names the parties
// (user, idp, generalist, idp2, specialist, gateway, tool). The specialist IS the calling agent;
// the registry check happens inside the gateway, so a hop that only touches it draws no arrow.
const HOP_NODE = { agent: "specialist", gateway: "gateway", tool: "tool", registry: null };

/** The run's hops as the kit's call data, one entry per arrow. Verdict: PERMIT→ok, DENY/protocol→deny, else held. */
export function hopCalls(run) {
  if (!run || !Array.isArray(run.hops)) return [];
  const verdict = run.decision === "PERMIT" ? "ok" : run.decision === "DENY" || run.stage === "protocol" ? "deny" : "held";
  return run.hops
    .map((h) => ({ from: HOP_NODE[h.from] ?? h.from, to: HOP_NODE[h.to] ?? h.to, hop: { title: h.label, fact: h.label, verdict, request: h.request, response: h.response } }))
    .filter((c) => c.from && c.to && c.from !== c.to);
}

export default function DiagramTab({ vertical, resetSignal, run = null }) {
  const [pattern, setPattern] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setPattern(null); getJson(`/api/diagram?vertical=${encodeURIComponent(vertical)}&name=delegation-flow`).then(setPattern, (e) => setError(e.message)); }, [vertical]);
  // The last gate run's hops ride on the matching arrows: the expanded box shows what went over the wire.
  const withHops = useMemo(() => {
    if (!pattern) return null;
    const calls = hopCalls(run);
    if (!calls.length) return pattern;
    const steps = pattern.steps.map((s) => ({ ...s }));
    let ci = 0;
    for (const s of steps) if (s.from === calls[ci]?.from && s.to === calls[ci]?.to) s.hop = calls[ci++].hop;
    return { ...pattern, steps };
  }, [pattern, run]);
  if (error) return <p className="field-error" role="alert">Could not load the diagram ({error}).</p>;
  if (!pattern) return <p className="muted">Loading...</p>;
  return (
    <>
      <PatternDiagram key={vertical} pattern={withHops} resetSignal={resetSignal} />
    </>
  );
}

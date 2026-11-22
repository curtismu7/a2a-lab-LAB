import { useCallback, useEffect, useRef, useState } from "react";
import Json from "./Json";
import { runTool, getRegistry, setRegistration, exchangeOne, exchangeTwo, getAgentCard, getRunObservability } from "../api";
import RunObservability from "../run-observability/RunObservability";
import { visible } from "../safeText";

const STATUS_CLASS = { measured: "tag tag--ok", inferred: "tag", UNVERIFIED: "tag tag--warn" };
const GENERALIST = "generalist-agent";

export function Hops({ hops, traceId }) {
  return (
    <section aria-label="Mock hops with traceparent" data-testid="hops">
      <h3>Hops (W3C traceparent) <span className="muted">trace {traceId}</span></h3>
      <div className="hops-grid">
      {hops.map((h) => (
        <details key={h.n} open={h.n === 1}>
          <summary>{h.n}. {h.label}</summary>
          <p className="muted">Request</p><Json value={h.request} label={`Request of hop ${h.n}`} hot={["method", "skill"]} />
          <p className="muted">Response</p><Json value={h.response} label={`Response of hop ${h.n}`} />
        </details>
      ))}
      </div>
    </section>
  );
}

// Rule 27: where this lab's own logs live and where they stream (the README says the same).
export const RUN_OBS_STREAMS = [
  { product: "A2A Lab server (this lab)", lives: "the lab container's stdout: one timestamped line per decision (actor, outcome, code, trace id; never a token)", streams: "the family log collector to demo-logs-a2a-lab, then a SIEM, when the collector is set to watch this container (the lab does not ship them itself)" },
  { product: "PingOne Authorize, Privilege, the agent gateway", lives: "not run by this lab: its gateway, registry and policy are mocks", streams: "nothing to stream" },
];

/** What each layer logged for the run above. Mock: simulated rows from the decisions the mock computed. Real is reserved: no record. */
export function RunObs({ run, tick, mode }) {
  const [record, setRecord] = useState(null);
  useEffect(() => {
    let live = true;
    if (!run || mode === "real") { setRecord(null); return undefined; }
    getRunObservability().then((b) => { if (live) setRecord(b && "record" in b ? b.record : b); }, () => { if (live) setRecord({ error: "unreachable", message: "Could not reach the server." }); });
    return () => { live = false; };
  }, [run, tick, mode]);
  if (mode === "real") {
    return (
      <div className="panel">
        <section className="ro" data-testid="ro-real-not-offered" aria-label="What each layer logged for this run">
          <h2>What each layer logged for this run</h2>
          <p className="ro-muted">Not offered in Real mode. This lab's Real mode is reserved: it has no live data path, so there is no real run whose logs could be read, and nothing is shown rather than something made up. Switch to Mock to see the simulated record.</p>
        </section>
      </div>
    );
  }
  return <div className="panel"><RunObservability record={record} source="mock" streams={RUN_OBS_STREAMS} /></div>;
}

const WORDS = {
  PERMIT: ["allow", "PERMITTED — the gateway routed the specialist call; the chain is fully attributable"],
  DENY: ["deny", "DENIED — the call was refused; nothing executed"],
};

export function Verdict({ run }) {
  if (!run) return <p className="muted" data-testid="verdict-empty">Pick a scenario to run it.</p>;
  const [cls, word] = WORDS[run.decision] || ["deny", run.decision];
  const stageText = run.stage === "protocol" ? "the PROTOCOL answered (401 before anything else)"
    : run.stage === "gateway" ? "the GATEWAY refused the chain"
    : "the POLICY decided from the registry";
  return (
    <div className={`verdict verdict--${cls}`} data-testid="verdict" role="status">
      <strong className="verdict__word">{word}</strong>
      {run.stage && <p className="muted" data-testid="stage">Stage: {stageText}</p>}
      {run.reason && <p className="reason" data-reason="policy">{visible(run.reason)}</p>}
      {run.user && (
        <p data-testid="who">
          Token: sub=<code>{visible(run.user)}</code>, act=<code>{visible(run.act?.sub || "(none)")}{run.act?.act ? ` -> ${visible(run.act.act.sub)}` : ""}</code>
          {" "}— chain depth {run.chainDepth ?? "?"}, scope [ {visible(run.scope || "")} ]
        </p>
      )}
    </div>
  );
}

/** The A2A handoff: exchange #1 (user consents, generalist acts), exchange #2 (specialist acts
 *  via the generalist), then the gated call. The nested act chain is built step by step. */
function AgentCall({ tools, onResult, user }) {
  const [specialist, setSpecialist] = useState("portfolio-specialist");
  const [scope, setScope] = useState("a2a:get_portfolio_summary");
  const [generalist, setGeneralist] = useState(GENERALIST);
  const [t1, setT1] = useState(null);
  const [t2, setT2] = useState(null);
  const [fail, setFail] = useState(null);

  const doExchangeOne = async () => {
    setFail(null); setT1(null); setT2(null);
    const r = await exchangeOne({ user, generalist: generalist || GENERALIST, scope }).catch(() => ({ ok: false, body: {} }));
    if (!r.ok) { setFail(r.body.detail || "Exchange #1 failed."); return; }
    setT1(r.body.token);
  };
  const doExchangeTwo = async () => {
    setFail(null); setT2(null);
    const r = await exchangeTwo({ generalistToken: t1, specialist: specialist || "portfolio-specialist", scope }).catch(() => ({ ok: false, body: {} }));
    if (!r.ok) { setFail(r.body.detail || "Exchange #2 failed."); return; }
    setT2(r.body.token);
  };
  const call = async () => {
    setFail(null);
    const res = await runTool({ token: t2, tool: tools[0]?.name || "get_portfolio_summary" }).catch(() => ({ ok: false, status: 0, body: {} }));
    if (res.body.decision) onResult(res.body);
    else setFail(`Could not evaluate (${res.body.detail || res.body.error || res.status}).`);
  };
  const chain = (t) => t ? `sub=${t.sub} -> act={${t.act.sub}${t.act.act ? ` -> ${t.act.act.sub}` : ""}}` : null;
  return (
    <section className="panel" aria-labelledby="call-h" data-testid="agent-call">
      <h2 id="call-h"><span className="step-num" aria-hidden="true">2</span>The A2A handoff</h2>
      <p className="muted">Two RFC 8693 exchanges build the nested act chain — act=&#123;specialist, act:&#123;generalist&#125;&#125; — then the gateway routes the specialist call only when the SPECIALIST is registered.</p>
      <div className="agent-call-grid">
        <div>
          <label htmlFor="call-user">Acting for (token sub)</label>
          <input id="call-user" type="text" maxLength={64} defaultValue={user} data-testid="call-user" />
        </div>
        <div>
          <label htmlFor="call-generalist">Generalist (exchange #1 actor)</label>
          <input id="call-generalist" type="text" maxLength={64} value={generalist} onChange={(e) => setGeneralist(e.target.value)} data-testid="call-generalist" />
        </div>
        <div>
          <label htmlFor="call-specialist">Specialist (exchange #2 actor)</label>
          <input id="call-specialist" type="text" maxLength={64} value={specialist} onChange={(e) => setSpecialist(e.target.value)} data-testid="call-specialist" />
        </div>
        <div>
          <label htmlFor="call-scope">Requested scope (narrowed at exchange #2)</label>
          <input id="call-scope" type="text" maxLength={200} value={scope} onChange={(e) => setScope(e.target.value)} data-testid="call-scope" />
        </div>
      </div>
      <div className="agent-call-bottom">
        <div className="seg" role="group" aria-label="Handoff steps">
          <button type="button" className="primary" onClick={doExchangeOne} data-testid="ex1-run">1. Consent &amp; exchange</button>
          <button type="button" onClick={doExchangeTwo} disabled={!t1} data-testid="ex2-run">2. Handoff to specialist</button>
          <button type="button" onClick={call} disabled={!t2} data-testid="call-run">3. Call as the specialist</button>
        </div>
        <ol className="facts" data-testid="chain-view">
          <li>Exchange #1: <code>{chain(t1) || "(not minted)"}</code></li>
          <li>Exchange #2: <code>{chain(t2) || "(not minted)"}</code></li>
          <li>Scope granted to the specialist: <code>{t2 ? t2.scope || "(narrowed away)" : "—"}</code></li>
        </ol>
      </div>
      {fail && <p className="field-error" role="alert">{fail}</p>}
    </section>
  );
}

/** The live Agent Card registry (UC2.6): register or revoke a specialist; the very next decision moves. */
function RegistryBoard({ onChanged }) {
  const [specialists, setSpecialists] = useState(null);
  const [name, setName] = useState("rogue-specialist");
  const [msg, setMsg] = useState(null);
  const load = useCallback(async () => {
    const j = await getRegistry().catch(() => null);
    if (j) setSpecialists(j.specialists);
  }, []);
  useEffect(() => { load(); }, [load, onChanged]);
  const flip = async (registered) => {
    setMsg(null);
    const r = await setRegistration({ specialist: name.trim() || "rogue-specialist", registered }).catch(() => ({ ok: false, body: {} }));
    if (r.ok) { setMsg(`${r.body.specialist} -> ${r.body.registered ? "registered" : "revoked"}`); await load(); if (onChanged) onChanged(); }
    else setMsg(r.body.detail || "Could not flip the registration.");
  };
  return (
    <section className="panel" aria-labelledby="reg-h" data-testid="registry-board">
      <h2 id="reg-h"><span className="step-num" aria-hidden="true">4</span>Agent Card registry (UC2.6)</h2>
      <p className="muted">The registry is read on EVERY decision — authorization keys on WHO is acting, not just who they act for. Register or revoke a specialist and the next handoff moves. Flips are per workspace.</p>
      <label htmlFor="reg-name">Specialist</label>
      <input id="reg-name" type="text" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} data-testid="reg-name" />
      <div className="seg" role="group" aria-label="Registration flips">
        <button type="button" data-testid="reg-add" onClick={() => flip(true)}>Register</button>
        <button type="button" data-testid="reg-remove" onClick={() => flip(false)}>Revoke</button>
      </div>
      {msg && <p className="muted" role="status" data-testid="reg-msg">{msg}</p>}
      {specialists && (
        <ul className="facts" data-testid="reg-list">
          {specialists.map((s) => <li key={s}><code>{visible(s)}</code></li>)}
        </ul>
      )}
    </section>
  );
}

/** UC2.7 protocol beat: the Agent Card is a real document; show it. */
function AgentCardPanel() {
  const [card, setCard] = useState(null);
  useEffect(() => { getAgentCard().then(setCard, () => setCard(null)); }, []);
  return (
    <section className="panel" aria-labelledby="card-h" data-testid="agent-card-panel">
      <h2 id="card-h"><span className="step-num" aria-hidden="true">5</span>Agent Card (UC2.7)</h2>
      <p className="muted">The well-known discovery document of the A2A protocol. The TOOL call is what requires the bearer — a call without one is a real 401 before anything else.</p>
      {card ? <Json value={card} label="Agent Card" testId="agent-card" hot={["name", "url", "skills"]} /> : <p className="muted">Could not load the card.</p>}
    </section>
  );
}

export default function PolicyGate({ story, resetSignal, requestedId, onSelect, mode = "mock" }) {
  const known = (v) => story.scenarios.some((s) => s.id === v);
  const [id, setId] = useState(known(requestedId) ? requestedId : story.scenarios[0].id);
  useEffect(() => { if (known(requestedId)) setId(requestedId); }, [requestedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [run, setRun] = useState(null);
  const [fail, setFail] = useState(null);
  const scenario = story.scenarios.find((s) => s.id === id) || story.scenarios[0];
  const [boardTick, setBoardTick] = useState(0);

  // Run a shipped scenario: perform the handoff exactly as the scenario states, then the gated call.
  const runToken = useRef(0);
  const runScenario = useCallback(async (sid) => {
    const token = ++runToken.current;
    const drop = () => token !== runToken.current;
    setFail(null);
    const sc = story.scenarios.find((s) => s.id === sid) || story.scenarios[0];
    if (sc.protocolProbe) {
      // UC2.7: show the 401 first (no bearer), then the full handoff and the permit.
      const unauth = await runTool({ tool: "get_portfolio_summary" }).catch(() => ({ ok: false, status: 0, body: {} }));
      if (drop()) return;
      if (unauth.status !== 401) { setRun(null); setFail(`Expected a 401 without the bearer, got ${unauth.status}.`); return; }
      setRun(unauth.body);
    }
    if (sc.generalist == null) return;
    const e1 = await exchangeOne({ user: sc.user, generalist: sc.generalist, scope: sc.scope }).catch(() => ({ ok: false, body: {} }));
    if (drop()) return;
    if (!e1.ok) { setRun(null); setFail(e1.body.detail || "Exchange #1 failed."); return; }
    if (sc.specialist == null) { setRun(null); setFail("This scenario has no handoff: the generalist token alone is the depth-1 refusal, shown above."); return; }
    const e2 = await exchangeTwo({ generalistToken: e1.body.token, specialist: sc.specialist, scope: sc.scope }).catch(() => ({ ok: false, body: {} }));
    if (drop()) return;
    if (!e2.ok) { setRun(null); setFail(e2.body.detail || "Exchange #2 failed."); return; }
    const res = await runTool({ token: e2.body.token, tool: "get_portfolio_summary" }).catch(() => ({ ok: false, status: 0, body: {} }));
    if (drop()) return;
    if (res.body.decision) setRun(res.body); else { setRun(null); setFail(`Could not evaluate (${res.body.detail || res.body.error || res.status}).`); }
  }, [story]);

  useEffect(() => { setRun(null); }, [resetSignal]);
  useEffect(() => { runScenario(id); }, [id, resetSignal, runScenario]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="gate">
      <section className="panel" aria-labelledby="sc-h">
        <h2><span className="step-num" aria-hidden="true">1</span>Scenarios</h2>
        <div className="seg" role="group" aria-label="Scenario">
          {story.scenarios.map((s) => <button key={s.id} type="button" aria-pressed={s.id === id} onClick={() => { setId(s.id); if (onSelect) onSelect(s.id); }}>{s.title}</button>)}
        </div>
        <p className="lesson" data-testid="lesson">{scenario.lesson}</p>
      </section>
      <AgentCall tools={story.tools} onResult={(r) => setRun(r)} user="demoUser" />
      <section className="panel" aria-labelledby="res-h">
        <h2><span className="step-num" aria-hidden="true">3</span>Decision</h2>
        {fail && <p className="field-error" role="alert">{fail}</p>}
        <Verdict run={run} />
        {run && <Hops hops={run.hops} traceId={run.traceId} />}
      </section>
      <RunObs run={run} tick={`${resetSignal}-${boardTick}`} mode={mode} />
      <div className="duo">
        <RegistryBoard onChanged={() => setBoardTick((n) => n + 1)} />
        <AgentCardPanel />
      </div>
      <section className="panel" aria-labelledby="scen-h">
        <h2><span className="step-num" aria-hidden="true">6</span>Scenario (decoded)</h2>
        <p className="tag tag--warn">{story.tokenLabel}</p>
        <Json value={{ user: scenario.user, generalist: scenario.generalist, specialist: scenario.specialist, scope: scenario.scope, protocolProbe: scenario.protocolProbe, expected: scenario.expected }} label="Scenario input" testId="scenario-prefs" hot={["specialist", "expected"]} />
        <h3>What we know, and how well</h3>
        <ul className="facts" data-testid="facts">
          {story.facts.map((f) => <li key={f.id}><span className={STATUS_CLASS[f.status] || "tag"}>{f.status}</span> {visible(f.text)} <span className="muted">({visible(f.source)})</span></li>)}
        </ul>
      </section>
    </div>
  );
}

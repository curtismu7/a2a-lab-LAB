import { useCallback, useEffect, useState } from "react";
import PolicyGate from "./components/PolicyGate";
import DiagramTab from "./components/DiagramTab";
import TalkTrack from "./components/TalkTrack";
import TalkTrackDialog from "./talk-track/TalkTrackDialog";
import HelpDialog from "./help-dialog/HelpDialog";
import { HELP_SECTIONS } from "./helpContent";
import TopMenu, { applyFontSize } from "./top-menu/TopMenu.jsx";
import "./top-menu/top-menu.css";
import ReturnLink from "./return-link/ReturnLink.jsx";
import { readReturnContext } from "./return-link/returnTargets.js";
import { scenarioFor, verticalFor } from "./handoffMap";
import { getJson, resetWorkspace, setMode } from "./api";
import VerifyMark from "./components/VerifyMark.jsx";
import ModeModal from "./mode-modal/ModeModal.jsx";

export const TABS = [
  { id: "gate", label: "Delegation & entitlement" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
// The Real-or-mock modal replaced the long simulation banner. Its line is never blank and never claims "not hosted" before it knows: until /api/info
// or /api/scenarios answers (or if both fail) the Mock line says both, honestly. Hosted is Mock only, so it is a Mock line, not a mode.
const TAIL = "Nothing here calls a real gateway, identity provider or tenant.";
const CHAIN = "a mock A2A delegation chain, a mock Agent Card registry and a mock RFC 8693 exchange";
export const MODE_LINES = {
  mock: `Everything on this page is simulated: ${CHAIN}. ${TAIL}`,
  hosted: `Hosted simulation: ${CHAIN}. ${TAIL}`,
  unknown: `Simulated, and possibly a hosted simulation: ${CHAIN}. ${TAIL}`,
  real: `Real is reserved in this build: it has no live data path, so the runs still use ${CHAIN}. ${TAIL}`,
};

const hashParts = () => {
  const h = window.location.hash.replace("#", "");
  const m = /^scenario-([a-z0-9-]{1,40})$/.exec(h);
  if (m) return { tab: "gate", scenario: m[1] };
  return { tab: TABS.some((t) => t.id === h) ? h : "gate", scenario: null };
};

export default function App() {
  // Opened from Customer Agent LAB: preselect the matching scenario and vertical (handoffMap.js), once, on load.
  const [handoff] = useState(() => readReturnContext(window.location.search));
  const [vertical, setVertical] = useState(() => verticalFor(handoff) || "retail");
  const [story, setStory] = useState(null);
  const [info, setInfo] = useState(undefined); // undefined = loading, null = failed
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(hashParts().tab);
  const [requested, setRequested] = useState(() => hashParts().scenario || scenarioFor(handoff));
  const [lastRun, setLastRun] = useState(null); // the gate tab's last run; the diagram tab shows its hops in the expanded boxes
  const [presenter, setPresenter] = useState(false);
  const [talkOpen, setTalkOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("a2a-theme") || "auto");
  const [fontStep, setFontStep] = useState(() => localStorage.getItem("a2a-font") || "M");
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("a2a-theme", theme); }, [theme]);
  useEffect(() => { applyFontSize(fontStep); localStorage.setItem("a2a-font", fontStep); }, [fontStep]);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");

  useEffect(() => { getJson("/api/info").then(setInfo, () => setInfo(null)); }, []);
  useEffect(() => { getJson(`/api/scenarios?vertical=${encodeURIComponent(vertical)}`).then((j) => { setStory(j); setError(null); }, (e) => setError(e.message)); }, [vertical]);
  useEffect(() => {
    const on = () => { const p = hashParts(); setTab(p.tab); setRequested(p.scenario); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const select = (id) => { setTab(id); setRequested(null); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };
  const pickScenario = (sid) => { try { window.history.replaceState(null, "", `#scenario-${sid}`); } catch { /* ignore */ } };

  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    setResetSignal((n) => n + 1);
    setResetMsg(ok ? "Reset: your workspace's directory flips and runs are back to defaults." : "Reset failed on the server; the view was reset.");
  }, []);

  const hosted = story ? !!story.hosted : info ? !!info.hosted : null;
  const mockLine = hosted === true ? MODE_LINES.hosted : hosted === false ? MODE_LINES.mock : MODE_LINES.unknown;
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header className="shell-bar">
        <span className="shell-brand">
          <span className="shell-logo" aria-hidden="true">A2A</span>
          <h1>A2A Lab</h1>
          {info && info.mode === "real"
            ? <span className="shell-badge shell-badge--real" data-testid="mode-badge">Real</span>
            : <span className="shell-badge" data-testid="mode-badge">Mock</span>}
        </span>
        <nav className="shell-nav" aria-label="Lab sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); select(t.id); }}>{t.label}</a>
          ))}
        </nav>
        <TopMenu
          mode={{ value: info ? info.mode : "mock", onChange: async (m) => { const res = await setMode(m).catch(() => ({ ok: false })); if (res.ok) window.location.reload(); else setResetMsg(res.body?.detail || "Could not switch mode."); }, realAvailable: info ? info.realAvailable : null }}
          theme={{ value: theme, onChange: setTheme }}
          fontSize={{ value: fontStep, onChange: setFontStep }}
          present={{ active: presenter, onToggle: () => setPresenter((v) => !v) }}
          talkTrack={{ active: talkOpen, onToggle: () => setTalkOpen((v) => !v) }}
          help={{ onClick: () => setHelpOpen(true), title: "What this lab is, and what is simulated" }}
          onReset={reset}
        >
          <VerifyMark id="a2a-lab" />
          <ReturnLink app="a2a-lab" variant="header" />
        </TopMenu>
      </header>
      <main className="page">
        <ReturnLink app="a2a-lab" />
        {error && <p className="app-error" role="alert">Could not load the lab ({error}). Is the server running?</p>}
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        {!presenter && (
          <div className="page-head">
            {story && <p className="intro">{story.intro}</p>}
            <label className="inline">Vertical{" "}
              <select value={vertical} onChange={(e) => setVertical(e.target.value)}>
                {(story ? story.verticals : ["retail"]).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
        )}
        <div id={`panel-${tab}`}>
          {error ? null : !story ? <p className="muted">Loading...</p> : (
            <>
              {presenter && tab !== "talk" && (
                <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
                  {story.talkTrack.filter((t) => (tab === "gate" ? ["say-first", "two-things", "chain", "least-privilege", "who-acting", "unverified"] : ["say-first"]).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
                </aside>
              )}
              {tab === "gate" && <PolicyGate key={vertical} story={story} resetSignal={resetSignal} requestedId={requested} onSelect={pickScenario} mode={info ? info.mode : "mock"} onRun={setLastRun} />}
              {tab === "diagram" && <DiagramTab vertical={vertical} resetSignal={resetSignal} run={lastRun} />}
              {tab === "talk" && <TalkTrack talk={story.talkTrack} />}
      <TalkTrackDialog isOpen={talkOpen} onClose={() => setTalkOpen(false)} talk={story?.talkTrack || []} />
      <HelpDialog isOpen={helpOpen} onClose={() => setHelpOpen(false)} sections={HELP_SECTIONS} docsUrl="https://github.com/curtismu7/a2a-lab-LAB#readme" />
            </>
          )}
        </div>
      </main>
      <ModeModal mode={info && info.mode === "real" ? "real" : "mock"} lines={{ mock: mockLine, real: MODE_LINES.real }} storageKey="a2a-mode" />
    </div>
  );
}

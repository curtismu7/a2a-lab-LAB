import { useCallback, useEffect, useRef, useState } from "react";
import PolicyGate from "./components/PolicyGate";
import DiagramTab from "./components/DiagramTab";
import TalkTrack from "./components/TalkTrack";
import TalkTrackDialog from "./talk-track/TalkTrackDialog";
import TopMenu, { applyFontSize } from "./top-menu/TopMenu.jsx";
import "./top-menu/top-menu.css";
import ReturnLink from "./return-link/ReturnLink.jsx";
import { readReturnContext } from "./return-link/returnTargets.js";
import { scenarioFor, verticalFor } from "./handoffMap";
import { getJson, resetWorkspace, setMode } from "./api";

export const TABS = [
  { id: "gate", label: "Delegation & entitlement" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
// The banner is never blank and never claims "not hosted" before it knows: until /api/info or /api/scenarios answers (or if both fail)
// it says both, honestly.
const TAIL = "Nothing here calls a real gateway, identity provider or tenant.";
export const BANNER_UNKNOWN = `SIMULATED / HOSTED SIMULATION: a mock A2A delegation chain, a mock Agent Card registry and a mock RFC 8693 exchange. ${TAIL}`;
const BANNER_LOCAL = `SIMULATED: a mock A2A delegation chain, a mock Agent Card registry and a mock RFC 8693 exchange. ${TAIL}`;
const BANNER_HOSTED = `HOSTED SIMULATION: a mock A2A delegation chain, a mock Agent Card registry and a mock RFC 8693 exchange. ${TAIL}`;

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
  const [presenter, setPresenter] = useState(false);
  const [talkOpen, setTalkOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("a2a-theme") || "auto");
  const [fontStep, setFontStep] = useState(() => localStorage.getItem("a2a-font") || "M");
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("a2a-theme", theme); }, [theme]);
  useEffect(() => { applyFontSize(fontStep); localStorage.setItem("a2a-font", fontStep); }, [fontStep]);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");
  const tabsRef = useRef(null);

  useEffect(() => { getJson("/api/info").then(setInfo, () => setInfo(null)); }, []);
  useEffect(() => { getJson(`/api/scenarios?vertical=${encodeURIComponent(vertical)}`).then((j) => { setStory(j); setError(null); }, (e) => setError(e.message)); }, [vertical]);
  useEffect(() => {
    const on = () => { const p = hashParts(); setTab(p.tab); setRequested(p.scenario); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const select = (id) => { setTab(id); setRequested(null); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };
  const pickScenario = (sid) => { try { window.history.replaceState(null, "", `#scenario-${sid}`); } catch { /* ignore */ } };

  // Keep the active tab fully in view in the scrolling tab strip (375px).
  useEffect(() => {
    const strip = tabsRef.current; const el = document.getElementById(`tab-${tab}`);
    if (!strip || !el) return;
    const left = el.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, left - 8);
  }, [tab]);

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

  const onKeyTab = (e, i) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    select(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const hosted = story ? !!story.hosted : info ? !!info.hosted : null;
  const banner = story ? story.banner : hosted === true ? BANNER_HOSTED : hosted === false ? BANNER_LOCAL : BANNER_UNKNOWN;
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header>
        <p className="banner" role="status" data-testid="banner">{banner}</p>
        <ReturnLink app="a2a-lab" />
        <div className="head">
          <div>
            <h1>A2A Lab</h1>
            {!presenter && story && <p className="intro">{story.intro}</p>}
          </div>
          {!presenter && (
              <label className="inline">Vertical{" "}
                <select value={vertical} onChange={(e) => setVertical(e.target.value)}>
                  {(story ? story.verticals : ["retail"]).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            )}
          <TopMenu
            mode={{ value: info ? info.mode : "mock", onChange: async (m) => { const res = await setMode(m).catch(() => ({ ok: false })); if (res.ok) window.location.reload(); else setResetMsg(res.body?.detail || "Could not switch mode."); }, realAvailable: info ? info.realAvailable : null }}
            theme={{ value: theme, onChange: setTheme }}
            fontSize={{ value: fontStep, onChange: setFontStep }}
            present={{ active: presenter, onToggle: () => setPresenter((v) => !v) }}
            talkTrack={{ active: talkOpen, onToggle: () => setTalkOpen((v) => !v) }}
            help={undefined}
            onReset={reset}
          >
            <ReturnLink app="a2a-lab" variant="header" />
          </TopMenu>
        </div>
      </header>
      <main>
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        <div role="tablist" aria-label="Lab sections" className="tabs" ref={tabsRef}>
          {TABS.map((t, i) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)} onKeyDown={(e) => onKeyTab(e, i)}>{t.label}</button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {error ? <p className="app-error" role="alert">Could not load the lab ({error}). Is the server running?</p> : !story ? <p className="muted">Loading...</p> : (
            <>
              {presenter && tab !== "talk" && (
                <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
                  {story.talkTrack.filter((t) => (tab === "gate" ? ["say-first", "two-things", "chain", "least-privilege", "who-acting", "unverified"] : ["say-first"]).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
                </aside>
              )}
              {tab === "gate" && <PolicyGate key={vertical} story={story} resetSignal={resetSignal} requestedId={requested} onSelect={pickScenario} />}
              {tab === "diagram" && <DiagramTab vertical={vertical} resetSignal={resetSignal} />}
              {tab === "talk" && <TalkTrack talk={story.talkTrack} />}
      <TalkTrackDialog isOpen={talkOpen} onClose={() => setTalkOpen(false)} talk={story?.talkTrack || []} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// Rule 27: this lab's side of the shared run-observability panel. Pure functions around the vendored collector
// (runObservability.js, never edited here): the one stdout line each decision leaves, the run an event belongs to, the
// "current run" slice of a workspace's decision events, and the record builder.
//
// Mock only: every row is `simulated` and is one of the events this lab's own mock computed on this run (nothing is invented; a
// layer the mock never touched says so). This lab's Real mode is RESERVED (no live data path): the route offers no real record, and the
// panel will read Elasticsearch when Real exists.
import { createHash } from 'node:crypto';
import { createRunObservability, LAYERS } from './runObservability.js';

export const MAX_EVENTS = 100;
const SERVICE = 'a2a-lab';
const ID = /[^A-Za-z0-9._:@-]/g;
const idText = (v) => String(v == null || v === '' ? '-' : v).replace(ID, '_').slice(0, 64);

// One timestamped line per decision: actor and outcome, never a token. This is what a collector would ship to demo-logs-a2a-lab.
export function decisionLine(e) {
  return `${e.at} ${SERVICE} decision actor=${idText(e.actor)} outcome=${idText(e.outcome)} code=${idText(e.code)} stage=${idText(e.kind)} trace=${idText(e.traceId)}`;
}

// A correlation key for a mock token (not a secret): exchange #2 receives the exchange-#1 token and /api/tool the exchange-#2 token, so
// the same key ties a call back to the exchange that minted its token. Identical tokens (same claims, same second) are indistinguishable.
export const tokenKey = (t) => (t && typeof t === 'object'
  ? createHash('sha256').update(JSON.stringify([t.sub, t.act?.sub, t.act?.act?.sub, t.scope, t.iat, t.exp])).digest('hex').slice(0, 12)
  : null);

const last = (events, f) => { for (let i = events.length - 1; i >= 0; i -= 1) if (f(events[i])) return events[i]; return null; };
const isProbe = (e) => e.kind === 'tool' && e.code === 'missing_bearer';

// The run an event belongs to. Exchange #1 starts a run. Exchange #2 and a gated call join the run whose token they carry, else the latest
// run for the same subject, else none (the event is logged but not part of any record). A registry flip joins the latest run only while
// that run has no verdict yet; after the verdict it starts and joins nothing.
export function runIdFor(events, e) {
  if (e.kind === 'exchange-1') return `r${1 + Math.max(0, ...events.map((x) => Number(String(x.runId || '').slice(1)) || 0))}`;
  const startOf = (f) => last(events, (x) => x.kind === 'exchange-1' && x.runId && f(x));
  if (e.kind === 'exchange-2') return (startOf((x) => e.parentKey && x.tokenKey === e.parentKey) || startOf((x) => e.sub && x.sub === e.sub))?.runId ?? null;
  if (e.kind === 'tool') {
    if (isProbe(e)) return null;
    const via = last(events, (x) => x.kind === 'exchange-2' && x.runId && e.tokenKey && x.tokenKey === e.tokenKey);
    return (via || startOf((x) => e.sub && x.sub === e.sub))?.runId ?? null;
  }
  const latest = startOf(() => true);
  return latest && !last(events, (x) => x.kind === 'tool' && !isProbe(x) && x.runId === latest.runId) ? latest.runId : null;
}

// The current run: the latest one started (an exchange #1, or a lone no-bearer 401 probe), and only its events. [] before any run.
export function currentRun(events) {
  const start = last(events, (e) => (e.kind === 'exchange-1' && e.runId) || (isProbe(e) && !e.runId));
  if (!start) return [];
  return start.runId ? events.filter((e) => e.runId === start.runId) : [start];
}

// Append an event (tagged with its run) and bound the list: older events go first and the current run's events last; the event that started it is never evicted.
export function addEvent(events, e, max = MAX_EVENTS) {
  const event = { ...e };
  if (event.runId === undefined) event.runId = runIdFor(events, event);
  const prev = events[events.length - 1];
  if (event.kind === 'exchange-1' && prev && isProbe(prev) && !prev.runId) prev.runId = event.runId; // the 401 probe right before the handoff is part of its run
  events.push(event);
  if (events.length > max) {
    const run = currentRun(events);
    const keep = new Set(run);
    // Oldest first: events outside the current run, then the current run's own, but never the event that started it.
    for (const guard of [(e) => keep.has(e), (e) => e === run[0]]) {
      for (let i = 0; i < events.length && events.length > max;) { if (guard(events[i])) i += 1; else events.splice(i, 1); }
    }
  }
  return event;
}

const WHY = {
  person: 'This lab has no sign-in step: the person is the name given to exchange #1, so the mock produced no person event.',
  authorize: 'This lab has no separate Authorize decision: the mock gateway token policy decides, shown under Agent gateway.',
  privilege: 'This lab has no Privilege policy, AI Guard or approval step.',
  agent: 'No token exchange ran in this run.',
  gateway: 'The gateway was not called in this run.',
  resource: 'This lab has no tool server: /api/tool only returns the gateway verdict, which is the last event.',
};
const PRODUCT = { agent: 'lab mock exchanger', gateway: 'lab mock A2A gateway' };

// A mock layer spec per layer, from only the events the mock computed. `reason` is used by the collector when a layer has none.
export function mockLayers(events) {
  return LAYERS.map((layer) => ({
    layer, products: [], reason: WHY[layer],
    simulated: events.filter((e) => e.layer === layer).map((e) => ({ at: e.at, product: PRODUCT[layer], outcome: e.outcome, message: e.message, detail: e.detail })),
  }));
}

// The ids of this run (raw: compared before masking, then masked on the way out).
export function correlationOf(run) {
  const latest = (k) => [...run].reverse().find((e) => e[k])?.[k];
  return { sub: latest('sub'), actClientId: latest('actor'), traceId: latest('traceId') };
}

export async function buildRunRecord({ events, clock = Date.now }) {
  const run = currentRun(events);
  if (!run.length) return null;
  return createRunObservability({ clock }).collectRun({
    runId: `a2a-${Date.parse(run[0].at)}`, startedAt: run[0].at, endedAt: run[run.length - 1].at,
    correlation: correlationOf(run), source: 'mock', layers: mockLayers(run),
  });
}

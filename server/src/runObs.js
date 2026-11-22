// Rule 27: this lab's side of the shared run-observability panel. Pure functions around the vendored collector
// (runObservability.js, never edited here): the one stdout line each decision leaves, the "current run" slice of a
// workspace's decision events, and the record builder.
//
// Mock: every row is `simulated` and is one of the events this lab's own mock computed on this run (nothing is invented; a
// layer the mock never touched says so). Real: this lab's Real mode is RESERVED (no live data path), so the route never offers a
// real record; buildRunRecord still builds one through the Elasticsearch reader so the contract is tested and ready.
import { createRunObservability, defaultLayers, LAYERS } from './runObservability.js';

const SERVICE = 'a2a-lab';
const ID = /[^A-Za-z0-9._:@-]/g;
const idText = (v) => String(v == null || v === '' ? '-' : v).replace(ID, '_').slice(0, 64);

// One timestamped line per decision: actor and outcome, never a token. This is what a collector ships to demo-logs-a2a-lab.
export function decisionLine(e) {
  return `${e.at} ${SERVICE} decision actor=${idText(e.actor)} outcome=${idText(e.outcome)} code=${idText(e.code)} stage=${idText(e.kind)} trace=${idText(e.traceId)}`;
}

// The current run: from the latest exchange #1 (plus the no-bearer 401 probe right before it), or a lone 401 probe. [] before any run.
export function currentRun(events) {
  let i = events.map((e) => e.kind).lastIndexOf('exchange-1');
  if (i > 0 && events[i - 1].kind === 'tool' && events[i - 1].code === 'missing_bearer') i -= 1;
  if (i < 0) i = events.map((e) => e.code).lastIndexOf('missing_bearer');
  return i < 0 ? [] : events.slice(i);
}

const WHY = {
  person: 'This lab has no sign-in step: the person is the name given to exchange #1, so the mock produced no person event.',
  authorize: 'This lab has no separate Authorize decision: the mock gateway token policy decides, shown under Agent gateway.',
  privilege: 'This lab has no Privilege policy, AI Guard or approval step.',
  agent: 'No token exchange ran in this run.',
  gateway: 'The gateway was not called in this run.',
  resource: 'The call did not reach the resource server: it was refused first, or has not been made.',
};
const PRODUCT = { agent: 'lab mock exchanger', gateway: 'lab mock A2A gateway', resource: 'lab mock tool server' };

// A mock layer spec per layer, from only the events the mock computed. `reason` is used by the collector when a layer has none.
export function mockLayers(events) {
  return LAYERS.map((layer) => ({
    layer, products: [], reason: WHY[layer],
    simulated: events.filter((e) => e.layer === layer).map((e) => ({ at: e.at, product: PRODUCT[layer], outcome: e.outcome, message: e.message, detail: e.detail })),
  }));
}

// The ids of this run (raw: compared before masking, then masked on the way out).
export function correlationOf(run) {
  const last = (k) => [...run].reverse().find((e) => e[k])?.[k];
  return { sub: last('sub'), actClientId: last('actor'), traceId: last('traceId') };
}

export async function buildRunRecord({ source, events, readers = [], clock = Date.now }) {
  const run = currentRun(events);
  if (!run.length) return null;
  const obs = createRunObservability({ readers, clock });
  return obs.collectRun({
    runId: `a2a-${Date.parse(run[0].at)}`, startedAt: run[0].at, endedAt: run[run.length - 1].at,
    correlation: correlationOf(run), source,
    layers: source === 'mock' ? mockLayers(run) : defaultLayers(),
  });
}

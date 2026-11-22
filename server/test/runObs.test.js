// Rule 27: the run-observability record this lab builds, and the decision lines its server writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { ElasticsearchReader, assertRunObservability, readersFromEnv } from '../src/runObservability.js';
import { buildRunRecord, currentRun, decisionLine } from '../src/runObs.js';

const ESKEY = ['read', 'only', 'test', 'value'].join('-');
const REAL_ENV = { A2ALAB_REAL_URL: 'https://gw.example', A2ALAB_REAL_CLIENT_ID: 'cid', A2ALAB_REAL_CLIENT_SECRET: 'x' };

async function withLab(fn, { env = {} } = {}) {
  const lines = [];
  const health = createHealth({ intervalMs: 3_600_000 });
  await health.ready;
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health, configFile: '/nonexistent/c.json', log: (l) => lines.push(l) }) });
  const base = url.replace(/\/$/, '');
  const call = async (method, path, body, ws = 'obs-a') => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: base, 'x-workspace': ws }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  // The scenario the page runs: exchange #1, exchange #2, the gated call.
  const run = async (specialist = 'portfolio-specialist', ws = 'obs-a', user = 'demoUser') => {
    const e1 = await call('POST', '/api/exchange/one', { user, generalist: 'generalist-agent', scope: 'a2a:get_portfolio_summary' }, ws);
    const e2 = await call('POST', '/api/exchange/two', { generalistToken: e1.body.token, specialist, scope: 'a2a:get_portfolio_summary' }, ws);
    const tool = await call('POST', '/api/tool', { token: e2.body.token, tool: 'get_portfolio_summary' }, ws);
    return { e1, e2, tool };
  };
  try { await fn({ call, run, lines }); } finally {
    health.stop(); await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const rec = async (call, ws) => (await call('GET', '/api/run-observability', undefined, ws)).body.record;

test('mock: a permitted run gives a record every row of which the mock computed (simulated), and assertRunObservability passes', async () => {
  await withLab(async ({ call, run }) => {
    const { tool } = await run();
    assert.equal(tool.status, 200);
    const r = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.equal(r.source, 'mock');
    assert.ok(r.rows.filter((x) => x.origin !== 'not-logged').every((x) => x.origin === 'simulated'));
    assert.deepEqual(r.coverage, { person: 'not-logged', agent: 'simulated', authorize: 'not-logged', privilege: 'not-logged', gateway: 'simulated', resource: 'simulated' });
    const msgs = r.rows.filter((x) => x.origin === 'simulated').map((x) => `${x.layer}|${x.outcome}|${x.message}`);
    assert.equal(msgs.length, 5, msgs.join('\n'));
    assert.match(msgs[0], /^agent\|allowed\|RFC 8693 exchange #1 .*act=\{generalist-agent\}/);
    assert.match(msgs[1], /^agent\|allowed\|RFC 8693 exchange #2 .*portfolio-specialist -> generalist-agent/);
    assert.match(msgs[2], /^gateway\|info\|Agent Card registry lookup: "portfolio-specialist" is registered/);
    assert.match(msgs[3], /^gateway\|allowed\|PERMIT/);
    assert.match(msgs[4], /^resource\|allowed\|Tool get_portfolio_summary dispatched/);
    assert.deepEqual(r.summary, { allowed: 4, refused: 0, blocked: 0, info: 1 });
    for (const l of ['person', 'authorize', 'privilege']) assert.ok(r.reasons[l], `${l} says why it is not logged`);
    const times = r.rows.filter((x) => x.at).map((x) => Date.parse(x.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });
});

test('mock: an unregistered specialist is a refusal the record shows, and the resource layer says it was never reached', async () => {
  await withLab(async ({ call, run }) => {
    const { tool } = await run('rogue-specialist');
    assert.equal(tool.status, 403);
    const r = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.equal(r.coverage.resource, 'not-logged');
    assert.match(r.reasons.resource, /refused first/);
    const gw = r.rows.filter((x) => x.layer === 'gateway');
    assert.deepEqual(gw.map((x) => x.outcome), ['info', 'refused']);
    assert.match(gw[0].message, /"rogue-specialist" is not registered/);
    assert.match(gw[1].message, /unregistered_specialist/);
    assert.equal(r.summary.refused, 1);
  });
});

test('mock: the no-bearer 401 probe before the handoff is part of the run and is refused at the gateway', async () => {
  await withLab(async ({ call, run }) => {
    assert.equal((await call('POST', '/api/tool', { tool: 'get_portfolio_summary' })).status, 401);
    let r = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.deepEqual(r.rows.filter((x) => x.origin === 'simulated').map((x) => [x.layer, x.outcome]), [['gateway', 'refused']]);
    assert.equal(r.coverage.agent, 'not-logged');
    await run();
    r = await rec(call);
    assert.equal(r.rows.filter((x) => x.origin === 'simulated').length, 6, 'the 401 and the handoff are one run');
    assert.equal(r.rows.find((x) => x.origin === 'simulated').outcome, 'refused');
  });
});

test('mock: a second run replaces the first; empty before a run; workspaces and Reset keep runs apart', async () => {
  await withLab(async ({ call, run }) => {
    assert.deepEqual((await call('GET', '/api/run-observability')).body, { record: null, message: 'No run yet in this workspace: run the demo.' });
    await run('rogue-specialist');
    await run('wire-specialist');
    assert.equal((await rec(call)).summary.refused, 0, 'only the latest run');
    assert.equal((await call('GET', '/api/run-observability', undefined, 'obs-b')).body.record, null, 'another workspace has no run');
    await call('POST', '/api/reset', {});
    assert.equal((await call('GET', '/api/run-observability')).body.record, null);
  });
});

test('mock: hostile and long names stay inert and bounded; no token or secret reaches the record or the log lines', async () => {
  await withLab(async ({ call, run, lines }) => {
    const nasty = `x${'long-name-'.repeat(8)}<img src=x onerror=alert(1)>\nFAKE decision actor=admin outcome=PERMIT`;
    await run(nasty, 'obs-a', 'user.with.a.very.long.name@corp.example');
    const r = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    const text = JSON.stringify(r) + lines.join('\n');
    assert.ok(!/eyJ[\w-]{8,}/.test(text), 'no JWT');
    assert.ok(!/\bBearer\s+\S{8,}/i.test(text));
    for (const l of lines) { assert.ok(!l.includes('\n')); assert.match(l, /^\d{4}-\d\d-\d\dT[\d:.]+Z a2a-lab decision actor=\S+ outcome=\S+ code=\S+ stage=\S+ trace=\S+$/); }
    assert.ok(lines.every((l) => !l.includes('FAKE decision')) || lines.every((l) => l.split(' decision ').length === 2), 'a newline in a name cannot forge a second line');
  });
});

test('the lab server writes one timestamped stdout line per decision: actor and outcome, no token', async () => {
  await withLab(async ({ call, run, lines }) => {
    await call('POST', '/api/tool', { tool: 't' });
    await run();
    await call('POST', '/api/registry/set', { specialist: 'wire-specialist', registered: false });
    assert.deepEqual(lines.map((l) => l.split(' ').slice(3, 6).join(' ')), [
      'actor=- outcome=refused code=missing_bearer',
      'actor=generalist-agent outcome=allowed code=-',
      'actor=portfolio-specialist outcome=allowed code=-',
      'actor=portfolio-specialist outcome=info code=registered',
      'actor=portfolio-specialist outcome=allowed code=-',
      'actor=portfolio-specialist outcome=allowed code=-',
      'actor=wire-specialist outcome=info code=revoked',
    ]);
    assert.match(lines[0], / trace=[0-9a-f]{32}$/);
  });
});

test('rule 19 still switches both ways; the record follows the mode: mock offers it, real (reserved) refuses with JSON, never a faked record', async () => {
  await withLab(async ({ call, run }) => {
    assert.equal((await call('POST', '/api/mode', { source: 'real' })).status, 409);
    assert.equal((await call('POST', '/api/mode', { source: 'mock' })).status, 200);
    await run();
    assert.equal((await rec(call)).source, 'mock');
    assert.equal((await call('GET', '/api/info')).body.source, 'mock');
  });
  await withLab(async ({ call, run }) => {
    assert.equal((await call('POST', '/api/mode', { source: 'real' })).status, 200);
    assert.equal((await call('POST', '/api/mode', { source: 'mock' })).status, 200);
    assert.equal((await call('GET', '/api/info')).body.source, 'real');
    await run();
    const r = await call('GET', '/api/run-observability');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'real_not_offered');
    assert.match(r.body.message, /reserved/);
    assert.equal(r.body.record, undefined);
  }, { env: REAL_ENV });
  await withLab(async ({ call, run }) => { // back to Mock after Real: the record is offered again
    await run();
    assert.equal((await rec(call)).source, 'mock');
  });
});

test('currentRun: nothing before a run, the latest exchange #1 onward after one', () => {
  const ev = (kind, code) => ({ kind, code: code ?? null, at: '2026-11-22T10:00:00.000Z' });
  assert.deepEqual(currentRun([]), []);
  assert.deepEqual(currentRun([ev('registry', 'revoked')]), []);
  const all = [ev('exchange-1'), ev('tool'), ev('registry', 'revoked'), ev('exchange-1'), ev('exchange-2')];
  assert.equal(currentRun(all).length, 2);
});

test('decisionLine strips anything that could forge a second line and caps long names', () => {
  const l = decisionLine({ at: '2026-11-22T10:00:00.000Z', actor: `a b\n${'z'.repeat(200)}`, outcome: 'allowed', code: null, kind: 'tool', traceId: undefined });
  assert.ok(!/\n/.test(l));
  assert.ok(l.length < 300);
  assert.match(l, / code=- stage=tool trace=-$/);
});

// ---- Real record against an in-process fake Elasticsearch (Real mode is reserved: the route never offers it, but the builder is ready) ----
async function fakeEs(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization }); const [status, body] = handler(); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}
const EVENTS = [
  { at: '2026-11-22T10:00:01.000Z', kind: 'exchange-1', layer: 'agent', outcome: 'allowed', actor: 'generalist-agent', sub: 'demoUser', message: 'x' },
  { at: '2026-11-22T10:00:03.000Z', kind: 'tool', layer: 'gateway', outcome: 'allowed', actor: 'portfolio-specialist', sub: 'demoUser', traceId: 'a'.repeat(32), message: 'PERMIT' },
];

test('real record via the Elasticsearch reader: logged rows with their own timestamps, never simulated, assertRunObservability passes', async () => {
  const es = await fakeEs(() => [200, { hits: { hits: [
    { _source: { '@timestamp': '2026-11-22T10:00:02.500Z', ping_product: 'pinggateway', message: '[P1AZ] DECISION: PERMIT | backend=real | sub=demoUser | tool=get_portfolio_summary | method=tools/call' } },
  ] } }]);
  try {
    const r = await buildRunRecord({ source: 'real', events: EVENTS, readers: [new ElasticsearchReader({ url: es.url, apiKey: ESKEY })] });
    assert.deepEqual(assertRunObservability(r), []);
    assert.equal(r.source, 'real');
    assert.ok(r.rows.every((x) => x.origin !== 'simulated'));
    const az = r.rows.find((x) => x.layer === 'authorize');
    assert.equal(az.origin, 'logged');
    assert.equal(az.matchedBy, 'id');
    assert.equal(az.atExact, '2026-11-22T10:00:02.500Z');
    assert.equal(r.coverage.person, 'not-logged');
    assert.ok(es.seen.length > 0 && es.seen.every((s) => s.method === 'POST' && /\/_search$/.test(s.url) && s.auth === `ApiKey ${ESKEY}`), 'read-only searches only');
    assert.ok(!JSON.stringify(r).includes(ESKEY), 'the read key never reaches the record');
  } finally { await es.close(); }
});

test('real record without a reader or with a failing one: unreachable with a reason, never blank, never simulated', async () => {
  const none = await buildRunRecord({ source: 'real', events: EVENTS, readers: readersFromEnv({}) });
  assert.deepEqual(assertRunObservability(none), []);
  assert.ok(Object.values(none.coverage).every((c) => c === 'unreachable'));
  assert.match(none.reasons.person, /RUN_OBS_ES_URL/);
  const es = await fakeEs(() => [401, { error: 'no' }]);
  try {
    const bad = await buildRunRecord({ source: 'real', events: EVENTS, readers: [new ElasticsearchReader({ url: es.url, apiKey: ESKEY })] });
    assert.deepEqual(assertRunObservability(bad), []);
    assert.equal(bad.coverage.gateway, 'unreachable');
    assert.match(bad.reasons.gateway, /refused the read credential/);
  } finally { await es.close(); }
});

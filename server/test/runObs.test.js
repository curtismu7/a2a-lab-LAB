// Rule 27: the run-observability record this lab builds, and the decision lines its server writes.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { assertRunObservability } from '../src/runObservability.js';
import { addEvent, currentRun, decisionLine } from '../src/runObs.js';

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
    assert.deepEqual(r.coverage, { person: 'not-logged', agent: 'simulated', authorize: 'not-logged', privilege: 'not-logged', gateway: 'simulated', resource: 'not-logged' });
    assert.match(r.reasons.resource, /no tool server/);
    assert.ok(!r.rows.some((x) => x.layer === 'resource' && x.origin === 'simulated'), 'no resource event was computed, so none is shown');
    const msgs = r.rows.filter((x) => x.origin === 'simulated').map((x) => `${x.layer}|${x.outcome}|${x.message}`);
    assert.equal(msgs.length, 4, msgs.join('\n'));
    assert.match(msgs[0], /^agent\|allowed\|RFC 8693 exchange #1 .*act=\{generalist-agent\}/);
    // The masker shortens every id this run declares in `correlation` (here the specialist, the actor client id) to its first 4 and last 2 characters.
    assert.match(msgs[1], /^agent\|allowed\|RFC 8693 exchange #2 .*port…st -> generalist-agent/);
    assert.match(msgs[2], /^gateway\|info\|Agent Card registry lookup: "port…st" is registered/);
    assert.match(msgs[3], /^gateway\|allowed\|PERMIT/);
    assert.deepEqual(r.summary, { allowed: 3, refused: 0, blocked: 0, info: 1, unverified: 0 });
    for (const l of ['person', 'authorize', 'privilege', 'resource']) assert.ok(r.reasons[l], `${l} says why it is not logged`);
    const times = r.rows.filter((x) => x.at).map((x) => Date.parse(x.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });
});

test('declared ids (sub, specialist, trace id) are shortened inside row detail without marking the record truncated', async () => {
  await withLab(async ({ call, run }) => {
    await run('portfolio-specialist', 'obs-a', 'user-with-a-long-name');
    const r = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.equal(r.truncated, false, 'shortening a declared id is not a cut');
    const detailText = JSON.stringify(r.rows.filter((x) => x.detail).map((x) => x.detail));
    assert.match(detailText, /user…me/, 'the sub is shortened in detail');
    assert.match(detailText, /port…st/, 'the specialist is shortened in detail');
    assert.match(detailText, /"traceId":"[0-9a-f]{4}…[0-9a-f]{2}"/, 'the trace id is shortened in detail');
  });
});

test('mock: an unregistered specialist is a refusal the record shows, and the resource layer says it was never reached', async () => {
  await withLab(async ({ call, run }) => {
    const { tool } = await run('rogue-specialist');
    assert.equal(tool.status, 403);
    const r = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.equal(r.coverage.resource, 'not-logged');
    assert.match(r.reasons.resource, /no tool server/);
    const gw = r.rows.filter((x) => x.layer === 'gateway');
    assert.deepEqual(gw.map((x) => x.outcome), ['info', 'refused']);
    assert.match(gw[0].message, /"rogu…st" is not registered/);
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
    assert.equal(r.rows.filter((x) => x.origin === 'simulated').length, 5, 'the 401 and the handoff are one run');
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

test('decisionLine strips anything that could forge a second line and caps long names', () => {
  const l = decisionLine({ at: '2026-11-22T10:00:00.000Z', actor: `a b\n${'z'.repeat(200)}`, outcome: 'allowed', code: null, kind: 'tool', traceId: undefined });
  assert.ok(!/\n/.test(l));
  assert.ok(l.length < 300);
  assert.match(l, / code=- stage=tool trace=-$/);
});

// ---- one run per record ----
const msgsOf = (r) => r.rows.filter((x) => x.origin === 'simulated').map((x) => x.message);
const ex1 = (call, user, ws = 'obs-a') => call('POST', '/api/exchange/one', { user, generalist: 'generalist-agent', scope: 'a2a:get_portfolio_summary' }, ws);
const ex2 = (call, t1, ws = 'obs-a') => call('POST', '/api/exchange/two', { generalistToken: t1, specialist: 'portfolio-specialist', scope: 'a2a:get_portfolio_summary' }, ws);
const tool = (call, t2, ws = 'obs-a') => call('POST', '/api/tool', { token: t2, tool: 'get_portfolio_summary' }, ws);

test('overlapping runs on one workspace: exchange #1 (A), #1 (B), #2 (A), call (A) never put A rows in B record', async () => {
  await withLab(async ({ call }) => {
    const a1 = await ex1(call, 'user-aaaa');
    const b1 = await ex1(call, 'user-bbbb');
    const a2 = await ex2(call, a1.body.token);
    assert.equal((await tool(call, a2.body.token)).status, 200);
    let r = await rec(call);
    assert.deepEqual(assertRunObservability(r), []);
    assert.deepEqual(msgsOf(r).map((m) => /user…bb/.test(m)), [true], 'B alone: only its exchange #1');
    assert.ok(!/user[-…]aa/.test(JSON.stringify(r)), 'nothing of A');
    const b2 = await ex2(call, b1.body.token);
    await tool(call, b2.body.token);
    r = await rec(call);
    assert.equal(msgsOf(r).length, 4);
    assert.ok(msgsOf(r).every((m) => !/user[-…]aa/.test(m)) && msgsOf(r).slice(0, 2).every((m) => /user…bb/.test(m)));
  });
});

test('a call whose token is unknown joins the latest run of the same subject, else none', async () => {
  await withLab(async ({ call }) => {
    await ex1(call, 'user-cccc');
    const forged = { sub: 'user-cccc', act: { sub: 'portfolio-specialist', act: { sub: 'generalist-agent' } }, aud: 'a2a-gateway', scope: 'a2a:get_portfolio_summary', iat: 1, exp: 4102444800 };
    await tool(call, forged);
    assert.equal(msgsOf(await rec(call)).length, 3, 'exchange #1, then the lookup and the verdict, joined by subject');
    await tool(call, { ...forged, sub: 'stranger' });
    assert.ok(!JSON.stringify(await rec(call)).includes('stranger'), 'no run for that subject: logged, not in the record');
  });
});

test('a run ends at its verdict: a registry flip after it is not part of the record and does not stretch the window', async () => {
  await withLab(async ({ call, run }) => {
    await run();
    const before = await rec(call);
    await new Promise((r) => setTimeout(r, 15));
    await call('POST', '/api/registry/set', { specialist: 'wire-specialist', registered: false });
    const after = await rec(call);
    assert.deepEqual(after.rows, before.rows);
    assert.equal(after.window.to, before.window.to);
  });
  await withLab(async ({ call }) => { // a flip BETWEEN exchange #1 and the verdict is part of the run
    const a1 = await ex1(call, 'user-dddd');
    await call('POST', '/api/registry/set', { specialist: 'portfolio-specialist', registered: false });
    const a2 = await ex2(call, a1.body.token);
    assert.equal((await tool(call, a2.body.token)).status, 403);
    const r = await rec(call);
    assert.ok(msgsOf(r).some((m) => /was revoked/.test(m)), 'the flip that caused the refusal is in the run');
    assert.equal(r.summary.refused, 1);
  });
});

test('the current run survives the cap: one run then 150 registry flips still returns that run', async () => {
  await withLab(async ({ call, run }) => {
    await run();
    const before = await rec(call);
    for (let i = 0; i < 150; i += 1) await call('POST', '/api/registry/set', { specialist: `flip-${i % 7}`, registered: i % 2 === 0 });
    const after = await rec(call);
    assert.deepEqual(after.rows, before.rows);
  });
  const events = []; // the same on the list itself, with a small cap
  addEvent(events, { at: '2026-11-22T10:00:00.000Z', kind: 'exchange-1', sub: 'u-1234', tokenKey: 'k1' }, 5);
  for (let i = 0; i < 20; i += 1) addEvent(events, { at: '2026-11-22T10:00:01.000Z', kind: 'registry', code: 'revoked' }, 5);
  assert.equal(events.length, 5);
  assert.equal(events[0].kind, 'exchange-1', 'the run start is never evicted');
  assert.equal(currentRun(events).length, 5, 'the run start plus the newest flips made while it had no verdict yet');
});

test('currentRun: nothing before a run; a lone 401 probe is a run; the probe before exchange #1 joins that run', () => {
  const t = '2026-11-22T10:00:00.000Z';
  const events = [];
  assert.deepEqual(currentRun(events), []);
  addEvent(events, { at: t, kind: 'registry', code: 'revoked' });
  assert.deepEqual(currentRun(events), [], 'a flip alone is no run');
  addEvent(events, { at: t, kind: 'tool', code: 'missing_bearer' });
  assert.equal(currentRun(events).length, 1);
  addEvent(events, { at: t, kind: 'exchange-1', sub: 'u-1234', tokenKey: 'k1' });
  assert.equal(currentRun(events).length, 2);
});

test('a failure building the record is logged (code and message only) and answered as JSON { error, message }', async () => {
  const err = mock.method(console, 'error', () => {});
  try {
    await withLab(async ({ call }) => {
      const r = await call('GET', '/api/run-observability');
      assert.equal(r.status, 500);
      assert.equal(r.body.error, 'internal_error');
      assert.ok(r.body.message);
      assert.equal(err.mock.callCount(), 1);
      assert.match(err.mock.calls[0].arguments[0], /run-observability failed: Error: MODE=bogus/);
    }, { env: { MODE: 'bogus' } });
  } finally { err.mock.restore(); }
});

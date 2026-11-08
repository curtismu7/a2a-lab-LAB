import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawHttp, withServer } from './helpers.js';

test('GET /api/health answers demo-health/1, ready and offline', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.schema, 'demo-health/1');
    assert.equal(j.state, 'ready');
    assert.equal(j.runtime, 'offline');
    assert.equal(j.demo.id, 'a2a-lab');
  });
});

test('health is GET only', async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/api/health`, { method: 'POST', headers: { origin: url } })).status, 405);
  });
});

test('POST /api/reset confirms and refuses a cross-origin caller', async () => {
  await withServer(async (url) => {
    assert.equal((await (await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: '{}' })).json()).reset, 'ok');
    assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })).status, 403);
  });
});

test('a non-loopback Host header is refused (DNS rebinding)', async () => {
  await withServer(async (url) => {
    assert.equal((await rawHttp(`${url}/api/health`, { headers: { host: 'evil.example.invalid' } })).status, 403);
  });
});

test('unknown API paths are 404 JSON', async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/api/nope`)).status, 404);
    assert.equal((await (await fetch(`${url}/api/nope`)).json()).error, 'not_found');
  });
});

test('GET /api/info: mock, simulated, hosted only when asked', async () => {
  await withServer(async (url) => {
    assert.deepEqual(await (await fetch(`${url}/api/info`)).json(), { mode: 'mock', source: 'mock', simulated: true, hosted: false, realAvailable: false });
    assert.match((await (await fetch(`${url}/api/scenarios`)).json()).banner, /^SIMULATED/);
  });
  await withServer(async (url) => {
    assert.deepEqual(await (await fetch(`${url}/api/info`)).json(), { mode: 'mock', source: 'mock', simulated: true, hosted: true, realAvailable: false });
    assert.match((await (await fetch(`${url}/api/scenarios`)).json()).banner, /^HOSTED SIMULATION/);
  }, { hosted: true });
});

test('oversized or malformed body: short JSON error, never a stack trace', async () => {
  await withServer(async (url) => {
    const post = (body) => fetch(`${url}/api/exchange/one`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body });
    assert.equal((await post(JSON.stringify({ pad: 'x'.repeat(9000) }))).status, 413);
    assert.deepEqual(await (await post(JSON.stringify({ pad: 'x'.repeat(9000) }))).json(), { error: 'payload_too_large' });
    const bad = await post('{not json');
    assert.equal(bad.status, 400);
    assert.equal(JSON.stringify(await bad.json()), JSON.stringify({ error: 'bad_request' }));
    assert.equal((await fetch(`${url}/api/health`)).status, 200, 'the server stays up');
  });
});

test('GET /api/scenarios: filled story, verticals switch the cast, config read per request', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-')), 'customer.config.json');
  await withServer(async (url) => {
    let j = await (await fetch(`${url}/api/scenarios`)).json();
    assert.equal(j.scenarios.length, 5);
    assert.ok(!/\{\{/.test(JSON.stringify(j)), 'no unfilled token');
    assert.ok(j.tools.length >= 1);
    j = await (await fetch(`${url}/api/scenarios?vertical=finance`)).json();
    assert.match(j.rule.appliesTo, /fabrikam/);
    j = await (await fetch(`${url}/api/scenarios?vertical=__proto__`)).json();
    assert.match(j.rule.appliesTo, /northwind/, 'unknown vertical keeps the default');
    fs.writeFileSync(file, JSON.stringify({ cast: { host: 'customhost' } }));
    j = await (await fetch(`${url}/api/scenarios`)).json();
    assert.match(j.rule.appliesTo, /customhost/);
  }, { configFile: file });
});

test('UC2.7 protocol: the Agent Card is served; no bearer is a real 401 with WWW-Authenticate', async () => {
  await withServer(async (url) => {
    const card = await (await fetch(`${url}/a2a/agent-card`)).json();
    assert.equal(card.name, 'Generalist Banking Agent');
    assert.match(card.url, /a2a\./);
    assert.ok(card.skills.length >= 1);
    // both mounts serve the same card
    const card2 = await (await fetch(`${url}/api/a2a/agent-card`)).json();
    assert.equal(card2.protocolVersion, '0.2.9');
    // no bearer: 401 with the WWW-Authenticate shape
    const r = await fetch(`${url}/api/tool`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': 'w0' }, body: JSON.stringify({ tool: 'get_portfolio_summary' }) });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /Bearer realm="a2a-gateway"/);
    const j = await r.json();
    assert.equal(j.decision, 'DENY');
    assert.equal(j.stage, 'protocol');
    assert.equal(j.code, 'missing_bearer');
    assert.equal(j.hops.length, 2);
  });
});

test('UC2: two exchanges build the nested chain; the registered specialist PERMITs', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    const t1 = await (await post('/api/exchange/one', { user: 'demoUser', generalist: 'generalist-agent', scope: 'a2a:get_portfolio_summary' }, 'w1')).json();
    assert.equal(t1.token.act.sub, 'generalist-agent');
    assert.equal(t1.token.sub, 'demoUser');
    const t2 = await (await post('/api/exchange/two', { generalistToken: t1.token, specialist: 'portfolio-specialist', scope: 'a2a:get_portfolio_summary' }, 'w1')).json();
    assert.equal(t2.token.act.sub, 'portfolio-specialist');
    assert.equal(t2.token.act.act.sub, 'generalist-agent', 'nested chain');
    assert.equal(t2.token.sub, 'demoUser', 'still acting for the SAME user');
    const r = await post('/api/tool', { token: t2.token, tool: 'get_portfolio_summary' }, 'w1');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.decision, 'PERMIT');
    assert.equal(j.chainDepth, 2);
    assert.ok(j.registered.includes('portfolio-specialist'));
    assert.ok(j.hops.some((h) => h.label.includes('registry')));
  });
});

test('UC2.6: an unregistered specialist is DENIED; a registry flip moves the next decision', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    const t1 = await (await post('/api/exchange/one', { user: 'demoUser' }, 'w2')).json();
    const t2 = await (await post('/api/exchange/two', { generalistToken: t1.token, specialist: 'rogue-specialist' }, 'w2')).json();
    const r = await post('/api/tool', { token: t2.token, tool: 'get_portfolio_summary' }, 'w2');
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.decision, 'DENY');
    assert.equal(j.code, 'unregistered_specialist');
    assert.match(j.reason, /WHO is acting/);
    // register the rogue: the next handoff permits
    await post('/api/registry/set', { specialist: 'rogue-specialist', registered: true }, 'w2');
    const t3 = await (await post('/api/exchange/two', { generalistToken: t1.token, specialist: 'rogue-specialist' }, 'w2')).json();
    assert.equal((await (await post('/api/tool', { token: t3.token, tool: 'get_portfolio_summary' }, 'w2')).json()).decision, 'PERMIT');
    // revoke again: denied afresh
    await post('/api/registry/set', { specialist: 'rogue-specialist', registered: false }, 'w2');
    const t4 = await (await post('/api/exchange/two', { generalistToken: t1.token, specialist: 'rogue-specialist' }, 'w2')).json();
    assert.equal((await (await post('/api/tool', { token: t4.token, tool: 'get_portfolio_summary' }, 'w2')).json()).decision, 'DENY');
    // another workspace never saw the flips
    const other = await (await fetch(`${url}/api/registry`, { headers: { 'x-workspace': 'w3' } })).json();
    assert.ok(!other.specialists.includes('rogue-specialist'));
  });
});

test('SCOPE: exchange #2 narrows to at most the generalist grant; an ungranted scope is denied', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    const t1 = await (await post('/api/exchange/one', { user: 'demoUser', scope: 'a2a:get_portfolio_summary' }, 'w4')).json();
    const t2 = await (await post('/api/exchange/two', { generalistToken: t1.token, specialist: 'portfolio-specialist', scope: 'a2a:unrelated_scope' }, 'w4')).json();
    assert.equal(t2.token.scope, '', 'narrowed away entirely');
    const j = await (await post('/api/tool', { token: t2.token, tool: 'get_portfolio_summary' }, 'w4')).json();
    assert.equal(j.decision, 'DENY');
    assert.equal(j.code, 'scope_narrowed_away');
  });
});

test('NOT A HANDOFF: a plain act={agent} token (depth 1) is refused', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    const t1 = await (await post('/api/exchange/one', { user: 'demoUser' }, 'w5')).json();
    const j = await (await post('/api/tool', { token: t1.token, tool: 'get_portfolio_summary' }, 'w5')).json();
    assert.equal(j.decision, 'DENY');
    assert.equal(j.code, 'chain_not_nested');
    assert.match(j.reason, /nested act chain/);
  });
});

test('bad inputs are refused with short JSON', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws = 'w9') => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    assert.equal((await post('/api/exchange/one', { user: '' }, 'w9')).status, 400);
    assert.equal((await post('/api/exchange/two', {}, 'w9')).status, 400);
    assert.equal((await post('/api/exchange/two', { generalistToken: 'junk' }, 'w9')).status, 400);
    assert.equal((await post('/api/registry/set', { specialist: '' }, 'w9')).status, 400);
    assert.equal((await post('/api/registry/set', { specialist: 'x' }, 'w9')).status, 400);
    assert.equal((await post('/api/tool', { token: 'junk' }, 'w9')).status, 403);
  });
});

test('GET /api/diagram serves the a2a-flow diagram-studio data, uncached', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/diagram`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await r.json();
    assert.equal(j.steps.length, 5);
    assert.ok(j.nodes.some((n) => n.label.includes('A2A gateway')));
  });
});

test('rule 19: POST /api/mode switches (mock) and answers 409 when Real is not configured', async () => {
  await withServer(async (url) => {
    const post = (body) => fetch(`${url}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(body) });
    assert.deepEqual(await (await post({ source: 'mock' })).json(), { source: 'mock' });
    assert.equal((await post({ source: 'real' })).status, 409);
    assert.equal((await post({ source: 'banana' })).status, 400);
    assert.equal((await post({})).status, 400);
  });
});

test('GET /api/shelf is reachable without a web build and reads SHELF_URL; POST is refused', async () => {
  const prev = process.env.SHELF_URL;
  process.env.SHELF_URL = 'https://shelf.example:8443/';
  try {
    await withServer(async (url) => {
      const r = await fetch(`${url}/api/shelf`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { shelfUrl: 'https://shelf.example:8443' });
      assert.notEqual((await fetch(`${url}/api/shelf`, { method: 'POST', headers: { origin: url } })).status, 200);
    });
  } finally {
    if (prev === undefined) delete process.env.SHELF_URL; else process.env.SHELF_URL = prev;
  }
});

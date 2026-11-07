import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHops, formatTraceparent, newTrace, parseTraceparent } from '../src/trace.js';
import { DEFAULT_CAST } from '../src/cast.js';
import { rawDiagram } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';
import { withServer } from './helpers.js';

const GOOD = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const TOK = { sub: 'demoUser', act: { sub: 'portfolio-specialist', act: { sub: 'generalist-agent' } }, aud: 'a2a-gateway', scope: 'a2a:get_portfolio_summary' };

test('parseTraceparent accepts the W3C shape and refuses everything else', () => {
  assert.deepEqual(parseTraceparent(GOOD), { traceId: '0af7651916cd43dd8448eb211c80319c', parentId: 'b7ad6b7169203331', flags: '01' });
  for (const bad of [undefined, '', 'x', GOOD.toUpperCase(), `00-${'0'.repeat(32)}-b7ad6b7169203331-01`, `00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`, `${GOOD}-extra`, 5, `00-${'a'.repeat(32)}-${'b'.repeat(16)}-ff`]) assert.equal(parseTraceparent(bad), null);
});

test('hops differ by stage; one trace id, distinct valid span ids per hop', () => {
  const trace = newTrace(GOOD);
  assert.equal(trace.traceId, '0af7651916cd43dd8448eb211c80319c');
  const proto = buildHops({ trace, cast: DEFAULT_CAST, stage: 'protocol', code: 'missing_bearer', reason: 'no bearer', tool: 'get_portfolio_summary', token: null, registry: [] });
  assert.equal(proto.length, 2);
  assert.ok(proto[1].response.includes('401'));
  const deny = buildHops({ trace, cast: DEFAULT_CAST, stage: 'policy-deny', code: 'unregistered_specialist', reason: 'not registered', tool: 'get_portfolio_summary', token: TOK, registry: ['portfolio-specialist'] });
  assert.equal(deny.length, 4);
  assert.ok(deny.some((h) => h.label.includes('registry')));
  const permit = buildHops({ trace, cast: DEFAULT_CAST, stage: 'policy-permit', code: null, reason: 'ok', tool: 'get_portfolio_summary', token: TOK, registry: ['portfolio-specialist'] });
  assert.equal(permit.length, 4);
  assert.ok(permit[permit.length - 1].label.includes('attributable'));
  for (const set of [proto, deny, permit]) {
    assert.equal(new Set(set.map((h) => h.traceparent)).size, set.length);
    for (const h of set) { assert.ok(parseTraceparent(h.traceparent)); assert.ok(h.traceparent.includes(trace.traceId)); }
  }
  assert.equal(formatTraceparent('a'.repeat(32), 'b'.repeat(16)), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
});

test('the committed diagram validates against the studio checker', () => {
  const d = rawDiagram();
  assert.deepEqual(validateDiagram(d), []);
});

test('POST /api/exchange/one + /api/tool return hops and continue a valid incoming trace', async () => {
  await withServer(async (url) => {
    const post = (p, body, headers = {}) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
    const t1 = await (await post('/api/exchange/one', { user: 'demoUser' })).json();
    const t2 = await (await post('/api/exchange/two', { generalistToken: t1.token, specialist: 'portfolio-specialist' })).json();
    let r = await post('/api/tool', { token: t2.token, tool: 'get_portfolio_summary' });
    let j = await r.json();
    assert.ok(parseTraceparent(r.headers.get('traceparent')));
    assert.ok(j.hops.length >= 3);
    assert.match(j.traceId, /^[0-9a-f]{32}$/);
    r = await post('/api/tool', { token: t2.token, tool: 'get_portfolio_summary' }, { traceparent: GOOD });
    j = await r.json();
    assert.equal(j.traceId, '0af7651916cd43dd8448eb211c80319c');
    r = await post('/api/tool', { token: t2.token, tool: 'get_portfolio_summary' }, { traceparent: 'garbage' });
    assert.notEqual((await r.json()).traceId, '0af7651916cd43dd8448eb211c80319c');
  });
});

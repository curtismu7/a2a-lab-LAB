import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAST, VERTICALS, fill, unfilled } from '../src/cast.js';
import { rawStory, buildStory } from '../src/story.js';
import { rawDiagram } from '../src/diagramData.js';
import { SCENARIOS } from '../src/policyData.js';
import { agentCard, actChainDepth, createRegistry, evaluateA2a, exchangeOne, exchangeTwo, A2AInputError, A2A_AUDIENCE } from '../src/a2a.js';
import { scanHosts } from '../src/safety.js';

const all = () => JSON.stringify([rawStory(), rawDiagram()]);

test('every {{token}} in the story and diagram data is defined by every vertical', () => {
  for (const [name, cast] of Object.entries(VERTICALS)) assert.deepEqual(unfilled(all(), cast), [], name);
  assert.equal(Object.keys(VERTICALS).length, 3);
});

test('the check itself catches an undefined token and leaves it visible', () => {
  assert.deepEqual(unfilled('a {{castBrand}} {{nope}}', DEFAULT_CAST), ['nope']);
  assert.equal(fill('{{nope}}', DEFAULT_CAST), '{{nope}}');
  assert.equal(fill('{{__proto__}}', DEFAULT_CAST), '{{__proto__}}');
});

test('each scenario gives its expected decision in every vertical', () => {
  for (const cast of Object.values(VERTICALS)) {
    for (const sc of SCENARIOS) {
      const reg = createRegistry({});
      if (sc.registrySeeded === false) reg.set('portfolio-specialist', false);
      if (sc.generalist == null) { assert.equal(sc.expected, 'DENY', sc.id); continue; }
      const t1 = exchangeOne({ userSub: sc.user, generalistClientId: sc.generalist, scope: sc.scope });
      const t2 = sc.specialist == null ? t1 : exchangeTwo({ generalistToken: t1, specialistClientId: sc.specialist, scope: sc.scope });
      const d = evaluateA2a({ token: t2, registeredSpecialists: reg.all(), requiredScope: 'a2a:get_portfolio_summary' }).decision;
      assert.equal(d, sc.expected, sc.id);
    }
  }
});

test('only .example hosts, no key-looking values', () => {
  assert.deepEqual(scanHosts(JSON.stringify([buildStory(DEFAULT_CAST)])), []);
  assert.deepEqual(scanHosts(all()), []);
});

test('every fact carries a status label', () => {
  for (const f of rawStory().facts) assert.ok(['measured', 'inferred', 'UNVERIFIED'].includes(f.status), f.id);
  assert.equal(rawStory().facts.find((f) => f.id === 'who-acting').status, 'measured');
  assert.ok(!/\bdoors?\b/i.test(all()));
});

test('docs/talk-track.md is exactly what the talk-track data renders (no drift; run `npm run talk-track`)', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const md = readFileSync(path.resolve(import.meta.dirname, '../../docs/talk-track.md'), 'utf8');
  const { renderTalkTrackMarkdown } = await import('../src/story.js');
  assert.equal(md, renderTalkTrackMarkdown(DEFAULT_CAST));
});

test('the diagram is diagram-studio/1 data and every step walks a real edge', () => {
  const d = rawDiagram();
  assert.equal(d.schema, 'diagram-studio/1');
  assert.equal(d.steps.length, 5);
  for (const s of d.steps) for (const i of s.edges) assert.ok(d.edges[i], `${s.title} edge ${i}`);
});

test('agentCard: the mock well-known doc, deterministic shape', () => {
  const card = agentCard();
  assert.equal(card.name, 'Generalist Banking Agent');
  assert.equal(card.url, 'https://a2a.generalist.example/a2a');
  assert.equal(card.protocolVersion, '0.2.9');
  assert.ok(card.skills.length >= 2);
  assert.ok(JSON.stringify(card).length <= 4096);
  const custom = agentCard({ host: 'a2a.northwind.example' });
  assert.equal(custom.url, 'https://a2a.northwind.example/a2a');
});

test('exchangeOne: act={generalist} for the user; required fields enforced; hostile input bounded', () => {
  const t = exchangeOne({ userSub: 'demoUser', generalistClientId: 'generalist-agent' });
  assert.equal(t.sub, 'demoUser');
  assert.equal(t.act.sub, 'generalist-agent');
  assert.equal(t.aud, A2A_AUDIENCE);
  assert.ok(t.exp > t.iat);
  assert.throws(() => exchangeOne({ userSub: '', generalistClientId: 'x' }), A2AInputError);
  assert.throws(() => exchangeOne({ userSub: 'u', generalistClientId: '' }), A2AInputError);
  const dirty = exchangeOne({ userSub: '\u0007bell'.repeat(50), generalistClientId: 'a\nb' });
  assert.ok(!/[\u0000-\u001f]/.test(dirty.sub) && dirty.sub.length <= 64);
  assert.equal(dirty.act.sub, 'a b');
});

test('exchangeTwo: nested act, scope narrowed to at most the parent grant', () => {
  const t1 = exchangeOne({ userSub: 'u', generalistClientId: 'g', scope: 'a2a:read a2a:write' });
  const t2 = exchangeTwo({ generalistToken: t1, specialistClientId: 's', scope: 'a2a:read a2a:admin' });
  assert.deepEqual(t2.scope.split(' ').sort(), ['a2a:read'], 'a2a:admin narrowed away');
  assert.equal(t2.act.sub, 's');
  assert.equal(t2.act.act.sub, 'g');
  assert.equal(t2.sub, 'u', 'same resource owner');
  assert.throws(() => exchangeTwo({ generalistToken: null, specialistClientId: 's' }), A2AInputError);
  assert.throws(() => exchangeTwo({ generalistToken: { sub: 'u' }, specialistClientId: 's' }), A2AInputError, 'no act chain');
  assert.throws(() => exchangeTwo({ generalistToken: t1, specialistClientId: '' }), A2AInputError);
});

test('actChainDepth counts nested nodes', () => {
  assert.equal(actChainDepth(undefined), 0);
  assert.equal(actChainDepth({ sub: 'a' }), 1);
  assert.equal(actChainDepth({ sub: 'a', act: { sub: 'b' } }), 2);
  assert.equal(actChainDepth({ client_id: 'x' }), 1);
  assert.equal(actChainDepth({}), 0);
});

test('evaluateA2a: registry + chain + scope decide; hostile input inert', () => {
  const reg = createRegistry({ seeded: ['portfolio-specialist'] });
  const t1 = exchangeOne({ userSub: 'u', generalistClientId: 'g' });
  const t2 = exchangeTwo({ generalistToken: t1, specialistClientId: 'portfolio-specialist' });
  assert.equal(evaluateA2a({ token: t2, registeredSpecialists: reg.all() }).decision, 'PERMIT');
  // unregistered
  const t3 = exchangeTwo({ generalistToken: t1, specialistClientId: 'rogue' });
  const d = evaluateA2a({ token: t3, registeredSpecialists: reg.all() });
  assert.equal(d.code, 'unregistered_specialist');
  // depth 1
  assert.equal(evaluateA2a({ token: t1, registeredSpecialists: reg.all() }).code, 'chain_not_nested');
  // expired
  const exp = { ...t2, exp: Math.floor(Date.now() / 1000) - 10 };
  assert.equal(evaluateA2a({ token: exp, registeredSpecialists: reg.all() }).code, 'token_expired');
  // upstream audience
  const up = { ...t2, aud: ['mcp-portfolio.internal'] };
  assert.equal(evaluateA2a({ token: up, registeredSpecialists: reg.all(), upstreamAudiences: ['mcp-portfolio.internal'] }).code, 'upstream_audience');
  // junk
  for (const junk of [null, undefined, 'x', 5, []]) assert.equal(evaluateA2a({ token: junk, registeredSpecialists: reg.all() }).code, 'invalid_token');
  // prototype pollution inert
  assert.equal(({}).polluted, undefined);
});

test('createRegistry: seed, flip, bounded names', () => {
  const reg = createRegistry({});
  assert.ok(reg.isRegistered('portfolio-specialist'));
  reg.set('rogue', true);
  assert.ok(reg.isRegistered('rogue'));
  reg.set('rogue', false);
  assert.ok(!reg.isRegistered('rogue'));
  assert.throws(() => reg.set('', true), A2AInputError);
  reg.set('\u0007x'.repeat(100), true);
  assert.ok([...reg.all()].every((n) => n.length <= 64));
});

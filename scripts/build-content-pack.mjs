// Builds content-pack.json for the Learning Hub from the story data, so the pack cannot drift from the lab.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAST } from '../server/src/cast.js';
import { buildStory } from '../server/src/story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export function buildPack() {
  const story = buildStory(DEFAULT_CAST);
  const sid = (n) => `S${String(n).padStart(2, '0')}`;
  const terms = { 'a2a-handoff': ['delegation'], 'a2a-unregistered': ['delegation'], 'a2a-scope-narrowed': ['delegation'], 'a2a-plain-act': ['delegation'], 'a2a-protocol': ['delegation'] };
  return {
    schema: 'demo-content-pack/1',
    id: 'a2a-lab',
    title: 'A2A Lab',
    version,
    demo: { id: 'a2a-lab', name: 'A2A Lab', catalog: 'D121', baseUrl: 'http://localhost:7700', doctor: '/api/health', tags: ['delegation', 'a2a', 'agent', 'authorize', 'oauth', 'policy', 'mock-only'] },
    glossary: [
      { id: 'delegation', term: 'Nested act chain', definition: 'Two RFC 8693 exchanges build act={specialist, act:{generalist}}: the specialist acts via the generalist, acting for the same user. Scope narrows at each hop — least privilege across agent hops, the full chain visible in the token.', aliases: ['token exchange', 'act claim', 'RFC 8693'] },
      { id: 'a2a', term: 'A2A (Agent-to-Agent)', definition: 'Two things are called A2A: the Linux Foundation agent protocol (Agent Card, JSON-RPC, a real 401 without the bearer) and the identity chain. Authorization keys on WHO is acting — an unregistered specialist identity is denied.', aliases: ['agent card', 'agent-to-agent'] },
    ],
    sources: [
      { id: 'a2a-spec', title: 'A2A protocol: agent discovery (Agent Card)', url: 'https://a2a-protocol.org/', kind: 'standard', use: 'The well-known Agent Card the lab serves at /api/a2a/agent-card.', status: 'not-read', checked: '2026-11-07' },
      { id: 'rfc8693', title: 'RFC 8693: OAuth 2.0 Token Exchange', url: 'https://www.rfc-editor.org/rfc/rfc8693', kind: 'standard', use: 'The act claim and the two exchanges that build the nested chain.', status: 'not-read', checked: '2026-11-07' },
    ],
    cards: [
      ...story.scenarios.map((sc, i) => ({ id: `try-${sc.id}`, label: `Scenario ${i + 1}: ${sc.title}`, description: sc.lesson, group: 'try-it', action: { type: 'route', href: `/#scenario-${sc.id}` }, terms: terms[sc.id], story: sid(i + 1) })),
      { id: 'concept-registry', label: 'Flip the Agent Card registry live', description: 'Register or revoke a specialist live; the SAME handoff flips on the next run — authorization keys on WHO is acting.', group: 'concept', action: { type: 'route', href: '/#scenario-a2a-unregistered' } },
      { id: 'ref-doctor', label: 'Doctor and health', description: 'Preflight checks and the demo-health/1 endpoint.', group: 'setup', action: { type: 'route', href: '/api/health' } },
    ],
    stories: story.scenarios.map((sc, i) => ({ id: sid(i + 1), title: sc.title, say: sc.lesson })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
}

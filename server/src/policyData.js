// The story as data: A2A nested-act delegation — a generalist hands a task to a specialist and
// the full chain stays attributable. Mirrors the AI-DEMO2 UC2/UC2.5/UC2.6/UC2.7 contract in mock.
// Text is {{token}} templated (see cast.js). Every host ends in .example. No real credential.

export const BANNER = 'SIMULATED: a mock A2A delegation chain, a mock Agent Card registry and a mock RFC 8693 exchange. Nothing here calls a real identity provider, agent gateway or tenant.';
export const HOSTED_BANNER = 'HOSTED SIMULATION: a mock A2A delegation chain, a mock Agent Card registry and a mock RFC 8693 exchange. Nothing here calls a real identity provider, agent gateway or tenant.';

export const TITLE = "A2A: {{castBrand}}'s generalist agent hands off to a specialist — and proves it";
export const INTRO = 'A generalist agent hands a task to a specialist sub-agent. Two RFC 8693 exchanges build a nested act chain — act={specialist, act:{generalist}} — with scope narrowed at each hop. The gateway routes the call only when the SPECIALIST is registered: authorization keys on WHO is acting, not just who they act for.';

// status: measured = seen live in AI-DEMO2; inferred = our reading; UNVERIFIED = not confirmed.
export const FACTS = [
  { id: 'two-exchanges', status: 'measured', text: 'The handoff is TWO RFC 8693 exchanges: #1 user consents, generalist acts (act={generalist}); #2 generalist token + specialist actor -> act={specialist, act:{generalist}}. Each hop is attributable and scoped.', source: 'AI-DEMO2 a2aDelegationService chained exchange, enforced live 2026-11-06' },
  { id: 'scope-narrowing', status: 'measured', text: 'The specialist holds ONLY the scope the handoff granted — never more than the generalist had. Least privilege across agent hops, with the full chain visible in the token.', source: 'AI-DEMO2 UC2 businessValue' },
  { id: 'who-acting', status: 'measured', text: 'UC2.6 PERMIT_THEN_DENY: same user, same delegation shape — but an unregistered specialist identity is denied. Authorization keys on WHO is acting, not just who they act for.', source: 'AI-DEMO2 UC2.6' },
  { id: 'nested-exempt', status: 'measured', text: 'Nested-act tokens (depth >= 2) skip the exchanger actor allow-list — the PDP validates the chain instead. Without the exemption the allow-list would reject every specialist and kill the A2A demos.', source: 'AI-DEMO2 GatewayTokenPolicy' },
  { id: 'protocol-beat', status: 'measured', text: 'Two things are called A2A: the Linux Foundation agent protocol (Agent Card, JSON-RPC, a real 401 when the bearer is missing) and the identity chain. UC2.7 shows them side by side.', source: 'AI-DEMO2 UC2.7' },
  { id: 'orchestrator', status: 'measured', text: 'UC2.5: the generalist asks an orchestrator to find the right specialist; the nested act chain proves the full handoff end to end.', source: 'AI-DEMO2 UC2.5' },
];

export const RULE = {
  name: 'A2A gateway policy (mock)',
  appliesTo: 'A2A gateway https://a2a.{{castHost}}.example/a2a',
  note: 'Mock shape of the A2A gateway policy. Not exported from, or checked against, a real policy engine.',
  defaults: { audience: 'a2a-gateway', requiredScope: 'a2a:get_portfolio_summary', seededSpecialists: ['portfolio-specialist', 'wire-specialist'] },
};

export const TOOLS = [
  { name: 'get_portfolio_summary', tier: 'specialist', lesson: 'The specialist tool the handoff grants: routed only with a valid nested act chain.' },
];

export const SCENARIOS = [
  {
    id: 'a2a-handoff',
    title: 'UC2: generalist hands off — nested act chain permits',
    user: 'demoUser', generalist: 'generalist-agent', specialist: 'portfolio-specialist',
    scope: 'a2a:get_portfolio_summary',
    expected: 'PERMIT',
    lesson: 'Two exchanges build act={specialist, act:{generalist}} acting for the same user. The chain is valid and the specialist is registered: PERMIT with the full chain in the token.',
  },
  {
    id: 'a2a-unregistered',
    title: 'UC2.6: unregistered specialist — PERMIT_THEN_DENY',
    user: 'demoUser', generalist: 'generalist-agent', specialist: 'rogue-specialist',
    scope: 'a2a:get_portfolio_summary',
    expected: 'DENY',
    lesson: 'Same user, same delegation shape — but "rogue-specialist" is not in the Agent Card registry. Authorization keys on WHO is acting.',
  },
  {
    id: 'a2a-scope-narrowed',
    title: 'SCOPE: the handoff did not grant the scope',
    user: 'demoUser', generalist: 'generalist-agent', specialist: 'portfolio-specialist',
    scope: 'a2a:unrelated_scope',
    expected: 'DENY',
    lesson: 'Exchange #2 narrows scope: the specialist may hold at most what the generalist had. An ungranted scope is narrowed away and the gateway denies.',
  },
  {
    id: 'a2a-plain-act',
    title: 'NOT A HANDOFF: a plain act={agent} token is refused',
    user: 'demoUser', generalist: 'generalist-agent', specialist: null,
    scope: 'a2a:get_portfolio_summary',
    expected: 'DENY',
    lesson: 'A2A calls require the NESTED chain. A depth-1 act={agent} token is the generalist acting alone — no handoff to validate.',
  },
  {
    id: 'a2a-protocol',
    title: 'UC2.7: the Agent Card is served; no bearer is a real 401',
    user: 'demoUser', generalist: 'generalist-agent', specialist: 'portfolio-specialist',
    scope: 'a2a:get_portfolio_summary', protocolProbe: true,
    expected: 'PERMIT',
    lesson: 'The protocol side of A2A: the well-known Agent Card, and a 401 before anything else when the bearer is missing. Identity and protocol, side by side.',
  },
];

export const TALK_TRACK = [
  { id: 'say-first', title: 'Say first', say: 'Everything here is simulated: the exchanges, the registry and the Agent Card are mock, mirroring what we ran live in AI-DEMO2.' },
  { id: 'two-things', title: 'Two things called A2A', say: 'The Linux Foundation agent protocol (Agent Card, JSON-RPC, 401 without the bearer) and the identity chain (nested act). UC2.7 shows them side by side — this lab covers both.' },
  { id: 'chain', title: 'The nested act chain', say: 'Exchange #1: user consents, generalist acts. Exchange #2: specialist acts via the generalist — act={specialist, act:{generalist}}. Depth 2, still acting for the same user.' },
  { id: 'least-privilege', title: 'Least privilege per hop', say: 'The specialist holds only the scope the handoff granted. Scope cannot grow across hops — an ungranted scope is narrowed away.' },
  { id: 'who-acting', title: 'WHO is acting', say: 'UC2.6: same user, same shape, unregistered specialist — DENIED. The registry is read on every decision; revoke a specialist and the next handoff moves.' },
  { id: 'unverified', title: 'What we do not claim', say: 'The mock exchanges, registry and card are demo values; the decision contract follows what we enforced live. No real agent-to-agent network call happens here.' },
  { id: 'close', title: 'Close', say: 'Reset clears your workspace: registry flips, exchanges and runs. Nothing was sent anywhere.' },
];

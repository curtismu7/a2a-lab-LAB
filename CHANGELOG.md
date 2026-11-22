# Changelog

## Unreleased
- Run observability (rule 27): the shared `RunObservability` panel (vendored from AI-DEMO-Standalone `shared/run-observability`, pinned) under the Decision shows what each of the six layers logged for the current run. Mock only: every row is `simulated`, computed from the decisions this lab's mock made (the lab has no tool server, so no resource row); Real is reserved, so the page says it is not offered and `GET /api/run-observability` answers 409. The server writes one timestamped stdout line per decision (actor, outcome, no token). One run per record (a run ends at its gateway verdict). No Docker socket mount.

- Diagram: arrow labels are drawn in a layer above the boxes and placed so none overlaps another label or sits on a box (the walked arrow's label turns bold and coloured and is raised); click a box and it expands in place with its details below its title: its kind, reach (boxes upstream and downstream), and the arrows in and out (each opens that box), on a card with colour that means something (blue where it is, green what it sends to, amber what reaches it). Click again, Close, the empty canvas or Reset collapses it; Copy link and `?box=<id>` open the page with a box expanded. The shared `diagram-kit` (vendored into `web/src/diagram-kit/`, pinned) does the work.

- Verification mark in the header: the shared `VerifyMark` (vendored from AI-DEMO-Standalone `shared/verify-mark`, byte for byte, pinned) shows this lab's Verified / In progress mark from the demo shelf, in the header menu before the Back link. This lab has no Shelf link, so it reads the demo shelf's `GET /api/shelf` directly: through the lab-proxy that call reaches the shelf, which lists every demo with its mark. It shows nothing when the lab is opened on its own port, when the shelf has no mark for it, or when the shelf is unreachable.

## v1.261028 AgentCore governance (2026-10-28)

- New tab "v1.261028 AgentCore": capability tables read from the binary diff, a runtime-bypass check and a gateway-caller-class check (pure engines in `server/src/agentcoreGov.js`, data in `agentcoreData.js`), `GET /api/agentcore`, `POST /api/agentcore/evaluate`, talk-track entry, 6 server tests and 3 web tests. Everything INFERRED; the real rules were not observed.

## v1.261027 scope gates (2026-10-28)

- New tab "v1.261027 scope gates": Cedar scope gate (Active vs candidate), PingFederate resource parameter trap, RequiredClaims scope tiers. Pure engines in `server/src/scopeGate.js`, data in `scopeData.js`, `GET /api/scope-gate`, `POST /api/scope-gate/evaluate` (scenario id plus optional own scope, bounded), a second diagram-studio/1 diagram (`scope-gate`), talk-track entry, 6 server tests and 4 web tests.

## 0.1.0 (unreleased)
- Step 1 (core, server and data), scaffolded from a sibling demo scaffold: pure `evaluateClaims` (nested dotted-path matching, flatten, bounded input), five claim-gate scenarios as `{{token}}` data in three vertical packs, AgentCore gateway posture mock (shape only), claim-gate diagram as diagram-studio/1 data, workspace-scoped evaluations and Reset, doctor, content pack, k8s manifests (not deployed). The web UI is step 2 (a placeholder page for now).
- Ports 7700-7709.
- Step 2: web UI (claim gate, posture, diagram, talk track, presenter mode), W3C traceparent on every mock hop, talk track as data, claim-gate diagram spacing.

# A2A LAB

Tier: Demo.
Repo: https://github.com/curtismu7/a2a-lab-LAB

A generalist agent hands a task to a specialist sub-agent; a mock RFC 8693 token exchange builds a nested act chain and the gateway routes the call only when the SPECIALIST is registered — PERMIT with a valid depth-2 chain, DENY for an unregistered specialist identity (UC2.6 PERMIT_THEN_DENY). This is the standalone mock of the AI-DEMO2 A2A track (UC2 / UC2.5 / UC2.6 / UC2.7 and the `a2aDelegationService` chained exchange / `GatewayTokenPolicy`) — same decision contract, no real policy engine or tenant.

Three ideas:

1. **The nested act chain.** Exchange #1: the user consents, the generalist acts (`act={generalist}`). Exchange #2: the generalist's token plus the specialist actor builds `act={specialist, act:{generalist}}` — depth 2, still acting for the same user, each hop attributable and scoped.
2. **WHO is acting.** Authorization keys on the specialist's identity, read from the registry on EVERY decision: a registered specialist is PERMITted, the same call from an unregistered identity is DENIED — revoke a specialist and the next handoff moves (UC2.6).
3. **Least privilege per hop.** The specialist holds only the scope the handoff granted; scope cannot grow across hops. Nested-act chains (depth >= 2) skip the exchanger actor allow-list because the PDP validates the whole chain instead.

Mock + Real (rule 19): Mock is fully offline (mock gate, mock MFA, mock CIBA). Real toggle mechanics follow rule 19: unconfigured, it is disabled with a how-to tooltip and `POST /api/mode` answers 409. In this build Real is RESERVED — the toggle reports a configured `A2ALAB_REAL_*` env, but no live policy-engine data path is wired yet; Mock is the story.

Scaffold copied from mcp-gateway-lab-LAB and hitl-mfa-lab-LAB (fork rule 4 attribution); every surface here is this lab's own. No cross-repo imports.

## Run it

- `./scripts/run.sh` — host-run on port 7700 (Node >= 26), opens the browser.
- Docker: `HOST_PORT=7700 docker compose up --build -d` (published on 127.0.0.1 only).
- Through the shared lab-proxy: `https://local.ping-devops.com:8443/a2a-lab/` (never a raw loopback URL).
- Tests: `npm ci && npm test` — 64 server + 97 web + 19 packaging tests.

## Run from a clone

Prerequisites: Node 26 or newer. Docker (OrbStack) only if you use the Docker form. Mock needs no tenant, credentials or settings.

```
git clone https://github.com/curtismu7/a2a-lab-LAB.git
cd a2a-lab-LAB
npm ci
npm run build
npm run doctor
npm start
```

Open http://127.0.0.1:7700/ (the server serves the built page). `GET /api/health` answers `demo-health/1`. Or with Docker: `HOST_PORT=7700 docker compose up --build -d` from the same folder.

## Ports, and what to do if the port is taken

```
Ports: a2a-lab-LAB listens on 7700 by default (allowed range 7700-7709).
Docker publishes it on 127.0.0.1:7700 only.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:7700 -sTCP:LISTEN -n -P
2. If it is an old copy of this lab (npm start), stop that process: kill <PID>.
   If it is this lab's container: docker compose down (from this folder).
3. If it is something else, stop it and free 7700. The server refuses ports outside
   7700-7709 on purpose (npm run doctor says so).
4. Then start again: npm start, or docker compose up -d.
```

## Scenarios

1. **UC2: generalist hands off — nested act chain permits** — exchange #1 then #2, the specialist call is routed, chain depth 2 (UC2).
2. **UC2.6: unregistered specialist — PERMIT_THEN_DENY** — same user, same delegation shape, an identity not in the registry is DENIED (UC2.6).
3. **SCOPE: the handoff did not grant the scope** — the specialist asks for more than the handoff granted; the ungranted scope is narrowed away.
4. **NOT A HANDOFF: a plain act={agent} token is refused** — depth 1 without the nested chain fails (`chain_not_nested`).
5. **UC2.7: the Agent Card is served; no bearer is a real 401** — the Linux Foundation protocol beat side by side with the identity chain (UC2.7).

## Surface

- `GET /api/a2a/agent-card` — the generalist agent's card (skills, endpoint).
- `GET /api/registry` / `POST /api/registry/set` — the specialist registry (seeded: `portfolio-specialist`, `wire-specialist`); read on every decision.
- `POST /api/exchange/one` — user token + generalist actor -> `act={generalist}` (RFC 8693 exchange #1).
- `POST /api/exchange/two` — generalist token + specialist actor -> `act={specialist, act:{generalist}}` (exchange #2, the nested chain).
- `POST /api/tool` — the gated specialist call; 200 = permit, 403 = deny (`unregistered_specialist`, `chain_not_nested`), 401 = `missing_bearer` (the decision, reason and W3C-traceparent hops are the answer).
- `GET /api/scenarios` — the story as data. `GET /api/diagram` — the diagram-studio data. `GET /api/health` — `demo-health/1`.
- Workspaces: every visitor carries an `X-Workspace` id; Reset clears only that workspace.

Safety: loopback Host check (+ `LAB_ALLOWED_HOSTS` behind the lab-proxy), same-origin writes, no outbound network, bounded payloads, `nosniff`, read-only container fs, non-root. Every token and decision value is labelled mock. See `docs/safety.md` and `docs/talk-track.md` (generated from the same data the UI reads).

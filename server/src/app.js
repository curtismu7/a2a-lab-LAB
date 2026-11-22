// One Express app. /api = health, the Agent Card (UC2.7 protocol beat), the two RFC 8693
// exchanges, the gated specialist call, the registry board (UC2.6 flips), diagram, info and
// reset. Registry state is per workspace id (X-Workspace) so one visitor's Reset never touches
// another's. Loopback Host check and same-origin writes on everything. Serves web/dist when it
// exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { loadCast, verticalFrom, VERTICALS } from './cast.js';
import { hostedFrom, modeFrom, realAvailableFrom } from './config.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { A2A_AUDIENCE, A2AInputError, LIMITS, agentCard, actChainDepth, createRegistry, evaluateA2a, exchangeOne, exchangeTwo } from './a2a.js';
import { buildHops, newTrace } from './trace.js';
import { addEvent, buildRunRecord, decisionLine, runIdFor, tokenKey } from './runObs.js';
import { mountShelfRoute } from './shelfLink.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');

const GENERALIST = 'generalist-agent';
const UPSTREAM_AUDIENCES = ['mcp-portfolio.internal'];
const REQUIRED_SCOPE = 'a2a:get_portfolio_summary';

export function createApp({
  health = createHealth(), configFile = CONFIG, hosted = false,
  workspaces = createWorkspaces({ makeRegistry: () => createRegistry({}) }),
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use('/health', health.router);
  const castFor = (req) => loadCast(configFile, verticalFrom(req.query.vertical));
  // customer.config.json is read on every request so editing it shows up on reload.
  api.get('/scenarios', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...buildStory(castFor(req), { hosted }), verticals: Object.keys(VERTICALS), hosted }); });
  api.get('/diagram', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  // What this build is, for the banner and for verifying a deploy by content (not by a 200).
  api.get('/info', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ mode: modeFrom(), source: modeFrom(), simulated: true, hosted, realAvailable: realAvailableFrom() }); });
  // Rule 19: the Mock/Real toggle. Exactly { source: "mock"|"real" }; 409 when Real is not configured.
  api.post('/mode', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['mock', 'real'].includes(body.source)) {
      return res.status(400).json({ error: 'bad_source', detail: 'body must be exactly { source: "mock" | "real" }' });
    }
    if (body.source === 'real' && !realAvailableFrom()) {
      return res.status(409).json({ error: 'real_not_configured', detail: 'Real mode needs a live policy engine configuration (A2ALAB_REAL_* env, owner-run). Mock keeps working.' });
    }
    return res.json({ source: body.source });
  });

  // Rule 27: every decision the mock makes leaves one stdout line (actor, outcome, no token) and one event for the run-observability panel.
  const observe = (ws, e) => {
    log(decisionLine(addEvent(workspaces.state(ws).events, { at: new Date().toISOString(), ...e })));
  };

  const withWorkspace = (handler) => (req, res) => {
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    res.set('Cache-Control', 'no-store');
    return handler(ws, req, res);
  };

  // UC2.7 protocol beat: the well-known Agent Card (mock). Public, no bearer - the card is the
  // discovery document; the TOOL call is what requires the bearer.
  api.get('/a2a/agent-card', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(agentCard({ host: `a2a.${castFor(req).castHost}.example` }));
  });

  // The registry board (UC2.6): per-workspace flips move the very next decision.
  api.get('/registry', withWorkspace((ws, _req, res) => {
    const v = workspaces.state(ws);
    const reg = v.registry || createRegistry({});
    res.json({ specialists: reg.all(), generalist: GENERALIST, workspace: ws });
  }));
  api.post('/registry/set', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (typeof body.specialist !== 'string' || !body.specialist.trim()) return res.status(400).json({ error: 'name_required', detail: 'body.specialist must be non-empty text' });
    if (typeof body.registered !== 'boolean') return res.status(400).json({ error: 'bad_request', detail: 'body.registered must be a boolean' });
    const v = workspaces.state(ws);
    const reg = v.registry || createRegistry({});
    const all = reg.set(body.specialist.trim().slice(0, LIMITS.name), body.registered);
    v.registry = reg;
    workspaces.record(ws, { tool: 'registry-set', decision: 'FLIPPED', reason: `${body.specialist.trim()} -> ${body.registered ? 'registered' : 'revoked'}`, token: null });
    observe(ws, { kind: 'registry', layer: 'gateway', outcome: 'info', actor: body.specialist.trim(), code: body.registered ? 'registered' : 'revoked', message: `Agent Card registry: "${body.specialist.trim().slice(0, LIMITS.name)}" was ${body.registered ? 'registered' : 'revoked'}` });
    return res.json({ specialist: body.specialist.trim(), registered: body.registered, specialists: all, workspace: ws });
  }));

  // RFC 8693 exchange #1: user consents; the generalist acts for them.
  api.post('/exchange/one', withWorkspace((ws, req, res) => {
    const body = req.body || {};
    const user = typeof body.user === 'string' && body.user.trim() ? body.user.trim().slice(0, LIMITS.clientId) : 'demoUser';
    if (typeof body.user === 'string' && !body.user.trim()) return res.status(400).json({ error: 'user_required', detail: 'body.user must be non-empty text' });
    const generalist = typeof body.generalist === 'string' && body.generalist.trim() ? body.generalist.trim().slice(0, LIMITS.clientId) : GENERALIST;
    const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim().slice(0, LIMITS.scope) : REQUIRED_SCOPE;
    try {
      const token = exchangeOne({ userSub: user, generalistClientId: generalist, scope, now: () => Date.now() });
      workspaces.record(ws, { tool: 'exchange-1', decision: 'MINTED', reason: `act={${token.act.sub}} for ${token.sub}`, token: null });
      observe(ws, { kind: 'exchange-1', layer: 'agent', outcome: 'allowed', actor: token.act.sub, sub: token.sub, code: null, tokenKey: tokenKey(token), message: `RFC 8693 exchange #1 minted a token for ${token.sub} with act={${token.act.sub}}`, detail: { sub: token.sub, act: token.act, aud: token.aud, scope: token.scope } });
      return res.json({ token, workspace: ws });
    } catch (e) {
      if (e instanceof A2AInputError) {
        observe(ws, { kind: 'exchange-1', layer: 'agent', outcome: 'refused', actor: generalist, sub: user, code: e.code, message: `RFC 8693 exchange #1 refused: ${e.code}` });
        return res.status(400).json({ error: e.code, detail: e.message });
      }
      throw e;
    }
  }));

  // RFC 8693 exchange #2: the specialist acts via the generalist. Scope narrows to at most
  // what the generalist holds; the nested act chain is built here.
  api.post('/exchange/two', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (body.generalistToken == null) return res.status(400).json({ error: 'token_required', detail: 'body.generalistToken (the exchange-#1 token) is required' });
    const specialist = typeof body.specialist === 'string' && body.specialist.trim() ? body.specialist.trim().slice(0, LIMITS.clientId) : 'portfolio-specialist';
    const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim().slice(0, LIMITS.scope) : REQUIRED_SCOPE;
    try {
      const token = exchangeTwo({ generalistToken: body.generalistToken, specialistClientId: specialist, scope, now: () => Date.now() });
      workspaces.record(ws, { tool: 'exchange-2', decision: 'MINTED', reason: `nested act {${token.act.sub} -> ${token.act.act.sub}} for ${token.sub}, scope [ ${token.scope} ]`, token: null });
      observe(ws, { kind: 'exchange-2', layer: 'agent', outcome: 'allowed', actor: token.act.sub, sub: token.sub, code: null, tokenKey: tokenKey(token), parentKey: tokenKey(body.generalistToken), message: `RFC 8693 exchange #2 minted the nested chain act={${token.act.sub} -> ${token.act.act.sub}} for ${token.sub}; scope narrowed to [ ${token.scope} ]`, detail: { sub: token.sub, act: token.act, aud: token.aud, scope: token.scope } });
      return res.json({ token, workspace: ws });
    } catch (e) {
      if (e instanceof A2AInputError) {
        observe(ws, { kind: 'exchange-2', layer: 'agent', outcome: 'refused', actor: specialist, sub: body.generalistToken?.sub, parentKey: tokenKey(body.generalistToken), code: e.code, message: `RFC 8693 exchange #2 refused: ${e.code}` });
        return res.status(400).json({ error: e.code, detail: e.message });
      }
      throw e;
    }
  }));

  // The gated specialist call: the nested-act token in, decision out. Without a bearer at all:
  // a real 401 before anything else (UC2.7). With one: the registry + chain decide (UC2/2.6).
  api.post('/tool', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (body.token == null) {
      // UC2.7: no bearer -> 401 with the WWW-Authenticate shape, the real protocol behavior.
      const trace401 = newTrace(req.headers.traceparent);
      observe(ws, { kind: 'tool', layer: 'gateway', outcome: 'refused', actor: null, code: 'missing_bearer', traceId: trace401.traceId, message: 'HTTP 401 missing_bearer: no bearer token, so the A2A gateway refused before any policy ran', detail: { status: 401, code: 'missing_bearer', traceId: trace401.traceId } });
      return res.status(401)
        .set('WWW-Authenticate', `Bearer realm="${A2A_AUDIENCE}", error="invalid_request", error_description="Missing bearer token"`)
        .json({ decision: 'DENY', stage: 'protocol', code: 'missing_bearer', reason: 'No bearer token: the A2A gateway answers 401 before anything else.', hops: buildHops({ trace: trace401, cast: castFor(req), stage: 'protocol', code: 'missing_bearer', reason: 'no bearer', tool: 'get_portfolio_summary', token: null, registry: [] }) });
    }
    const tool = typeof body.tool === 'string' && body.tool ? body.tool.slice(0, LIMITS.name) : 'get_portfolio_summary';
    const v = workspaces.state(ws);
    const reg = v.registry || createRegistry({});

    const verdict = evaluateA2a({ token: body.token, registeredSpecialists: reg.all(), requiredScope: REQUIRED_SCOPE, now: () => Date.now(), upstreamAudiences: UPSTREAM_AUDIENCES });
    workspaces.record(ws, { tool, decision: verdict.decision, reason: verdict.reason, token: body.token, blocked: verdict.code });
    const trace = newTrace(req.headers.traceparent);
    const permit = verdict.decision === 'PERMIT';
    const specialist = String(body.token.act?.sub ?? '').slice(0, LIMITS.clientId);
    const who = { actor: specialist, sub: body.token.sub, traceId: trace.traceId, tokenKey: tokenKey(body.token) };
    who.runId = runIdFor(workspaces.state(ws).events, { kind: 'tool', ...who }); // the run this call belongs to, for every event it leaves
    // The registry is consulted only when the chain checks before it passed (see evaluateA2a).
    if (!['invalid_token', 'missing_sub', 'token_expired', 'chain_not_nested'].includes(verdict.code)) {
      const found = verdict.code !== 'unregistered_specialist';
      observe(ws, { kind: 'registry', layer: 'gateway', outcome: 'info', ...who, code: found ? 'registered' : 'not_registered', message: `Agent Card registry lookup: "${specialist}" is ${found ? 'registered' : 'not registered'}` });
    }
    observe(ws, { kind: 'tool', layer: 'gateway', outcome: permit ? 'allowed' : 'refused', ...who, code: verdict.code, message: `${verdict.decision}${verdict.code ? ` ${verdict.code}` : ''}: ${verdict.reason}`, detail: { decision: verdict.decision, code: verdict.code, tool, chainDepth: actChainDepth(body.token.act), traceId: trace.traceId } });
    const hops = buildHops({ trace, cast: castFor(req), stage: verdict.decision === 'PERMIT' ? 'policy-permit' : 'policy-deny', code: verdict.code, reason: verdict.reason, tool, token: body.token, registry: reg.all() });
    res.set('traceparent', hops[0].traceparent);
    return res.status(verdict.decision === 'PERMIT' ? 200 : 403).json({
      decision: verdict.decision, stage: 'policy', code: verdict.code, reason: verdict.reason,
      tool, user: body.token.sub, act: body.token.act, scope: body.token.scope,
      chainDepth: actChainDepth(body.token.act), registered: reg.all(),
      workspace: ws, traceId: trace.traceId, hops,
    });
  }));

  // Rule 27: what each layer logged for THIS workspace's current run. Mock: simulated rows from the decisions the mock computed. Real is
  // reserved in this lab (no live data path), so a real record is not offered: 409, never a faked one.
  api.get('/run-observability', withWorkspace(async (ws, _req, res) => {
    try {
      if (modeFrom() === 'real') return res.status(409).json({ error: 'real_not_offered', message: 'Real mode is reserved in this lab: it has no live data path, so there is no real run to read logs for. Switch to Mock to see the simulated record.' });
      const record = await buildRunRecord({ events: workspaces.state(ws).events });
      return res.json(record ? { record } : { record: null, message: 'No run yet in this workspace: run the demo.' });
    } catch (e) {
      console.error(`[a2a-lab] run-observability failed: ${String(e?.code || e?.name || 'Error').slice(0, 40)}: ${String(e?.message).replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
      return res.status(500).json({ error: 'internal_error', message: 'The run observability record could not be built.' });
    }
  }));
  api.get('/runs', withWorkspace((ws, _req, res) => res.json(workspaces.runs(ws))));
  // Reset clears this workspace's registry flips and runs.
  api.post('/reset', withWorkspace((ws, _req, res) => {
    workspaces.resetWorkspace(ws);
    res.json({ reset: 'ok', workspace: ws });
  }));
  // Shelf button: the launcher URL from env SHELF_URL. Registered BEFORE the 404 catch-all and outside any web-build check.
  mountShelfRoute(api);
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);
  // Errors become short JSON. Express's default handler would send an HTML stack trace with absolute file paths.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    return res.status(500).json({ error: 'internal_error' });
  });

  // The protocol-faithful well-known path (UC2.7): also mounted outside /api.
  app.get('/a2a/agent-card', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(agentCard({ host: `a2a.${castFor(req).castHost}.example` }));
  });

  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  return app;
}

export function startHttpServer({ port, host, app = createApp() } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}

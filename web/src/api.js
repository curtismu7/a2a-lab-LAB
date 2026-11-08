import { workspaceFetch } from "./workspace";

export async function getJson(url) {
  const r = await workspaceFetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// POST /api/mode: the rule 19 Mock/Real toggle. 409 when Real is not configured.
export async function setMode(source) {
  const r = await workspaceFetch("/api/mode", { method: "POST", body: JSON.stringify({ source }) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// GET /api/a2a/agent-card: the Agent Card (UC2.7 protocol beat).
export const getAgentCard = () => getJson("/api/a2a/agent-card");

// RFC 8693 exchange #1: the user consents; the generalist acts for them.
export async function exchangeOne(payload) {
  const r = await workspaceFetch("/api/exchange/one", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// RFC 8693 exchange #2: the specialist acts via the generalist (nested act, scope narrowed).
export async function exchangeTwo(payload) {
  const r = await workspaceFetch("/api/exchange/two", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// POST /api/tool: the gated specialist call. 401 (protocol) and 403 (policy) are DATA here.
export async function runTool(payload) {
  const r = await workspaceFetch("/api/tool", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// The live Agent Card registry (UC2.6).
export const getRegistry = () => getJson("/api/registry");
export async function setRegistration(payload) {
  const r = await workspaceFetch("/api/registry/set", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

export const resetWorkspace = () => workspaceFetch("/api/reset", { method: "POST", body: "{}" }).then((r) => r.ok);

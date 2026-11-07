// Rule 14: W3C Trace Context on every (mock) hop. One trace id per decision, a new span id per hop. A valid incoming
// `traceparent` header continues its trace; anything else starts a new one. Nothing is sent anywhere: these are the raw
// request/response panes the UI shows. Values are random, mock, and carry no meaning outside this app.
import { randomBytes } from 'node:crypto';

const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO32 = '0'.repeat(32);
const ZERO16 = '0'.repeat(16);

export function parseTraceparent(v) {
  if (typeof v !== 'string' || v.length !== 55) return null;
  const m = TP.exec(v);
  // all-ones flags are forbidden by the W3C spec
  return m && m[1] !== ZERO32 && m[2] !== ZERO16 && m[3] !== 'ff' ? { traceId: m[1], parentId: m[2], flags: m[3] } : null;
}
export const formatTraceparent = (traceId, spanId, flags = '01') => `00-${traceId}-${spanId}-${flags}`;

export function newTrace(incoming, rand = randomBytes) {
  const p = parseTraceparent(incoming);
  const span = () => rand(8).toString('hex').replace(/^0{16}$/, '0000000000000001');
  return { traceId: p ? p.traceId : rand(16).toString('hex').replace(/^0{32}$/, `${'0'.repeat(31)}1`), parentId: p ? p.parentId : null, span };
}

// The mock hops of one gated A2A call, with the raw request and response text of each.
// Hops differ by stage: protocol (401, no bearer), policy (registry + chain decide).
export function buildHops({ trace, cast, stage, code, reason, tool, token, registry }) {
  const host = `a2a.${cast.castHost}.example`;
  const span = () => trace.span();
  const tp = (id) => formatTraceparent(trace.traceId, id);
  const ids = [span(), span(), span(), span(), span()];
  const tokenDesc = token ? `sub=${token.sub}, act={${token.act?.sub}${token.act?.act ? ` -> ${token.act.act.sub}` : ''}}` : '(no bearer)';
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { skill: tool } });
  const hops = [
    { n: 1, from: 'agent', to: 'gateway', label: 'Specialist calls the A2A gateway', traceparent: tp(ids[0]),
      request: `POST https://${host}/a2a\nAuthorization: Bearer <delegated: ${tokenDesc}>\ntraceparent: ${tp(ids[0])}\ncontent-type: application/json\n\n${body}`,
      response: `traceparent: ${tp(ids[0])}` },
  ];
  if (stage === 'protocol') {
    hops.push(
      { n: 2, from: 'gateway', to: 'agent', label: 'No bearer: a real 401 before anything else', traceparent: tp(ids[1]),
        request: `(no Authorization header)\ntraceparent: ${tp(ids[1])}`,
        response: `HTTP/1.1 401\nWWW-Authenticate: Bearer realm="a2a-gateway", error="invalid_request"\ncode: missing_bearer` },
    );
    return hops;
  }
  hops.push(
    { n: 2, from: 'gateway', to: 'gateway', label: 'Gateway reads the nested act chain', traceparent: tp(ids[1]),
      request: `evaluateA2a(${tokenDesc})\ntraceparent: ${tp(ids[1])}`,
      response: `${stage === 'policy-permit' ? 'PERMIT' : 'DENY'}${code ? `\ncode: ${code}` : ''}\n${reason}` },
    { n: 3, from: 'gateway', to: 'registry', label: 'Agent Card registry: is THIS specialist registered?', traceparent: tp(ids[2]),
      request: `registry.lookup(${token?.act?.sub || '?'})\ntraceparent: ${tp(ids[2])}`,
      response: `registered: [ ${(registry || []).join(', ')} ]` },
  );
  if (stage === 'policy-permit') {
    hops.push(
      { n: 4, from: 'gateway', to: 'tool', label: 'PERMIT: the specialist tool dispatches, chain attributable', traceparent: tp(ids[3]),
        request: `dispatch ${tool}\ntraceparent: ${tp(ids[3])}`,
        response: `HTTP/1.1 200\nchain: sub=${token?.sub} -> act={${token?.act?.sub} -> ${token?.act?.act?.sub}} -> PERMIT` },
    );
  } else {
    hops.push(
      { n: 4, from: 'gateway', to: 'agent', label: 'DENY: the registry decides, not just the shape', traceparent: tp(ids[3]),
        request: `GATE-RESULT (mock)\ntraceparent: ${tp(ids[3])}`,
        response: `HTTP/1.1 403\ncode: ${code}\n${reason}` },
    );
  }
  return hops;
}

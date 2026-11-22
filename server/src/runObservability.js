// runObservability.js — "What each layer logged for this run" (Rule 27): the CORE. It masks, classifies, orders and checks the log lines
// one run left behind. Vendor to server/src/runObservability.js. Dependency-free ESM, Node >= 22.
// This file has NO imports, no network and no file access, so a lab that reads no logs vendors only this file and exempts nothing in its
// safety tests. The readers (Elasticsearch, Docker, a log file) live in runObservabilityReaders.js; a lab that reads logs vendors both.
//
// HONESTY (Rule 25, applied to logs). Every row carries an origin:
//   logged       a real line read, read-only, from the product's own log, with the line's own timestamp, ids and tokens masked
//   simulated    the lab's mock computed it; never presented as read from a log
//   response     a decision the lab already holds as an API response (a PingOne Authorize permit/deny and its policy): real, but NOT read from a
//                log, so it is never tagged or counted as `logged`
//   not-logged   no line was found for this run (the product may not log this event); the panel says so, it never claims a line
// A missing event is never invented. An `info` row is never counted as passed. A line shape nobody has measured is marked `UNVERIFIED` in
// the matcher table below and its rows carry basis 'unverified-shape'.
// SECRETS. Every text field of every row (message, product, host, timestamp text, detail) passes the masker (or is rebuilt from a number)
// before it leaves collectRun, whatever its origin. Matchers are ANCHORED to the shape of the line the product itself wrote: text typed by a
// caller (a request path, a message body) can never make a line count as a decision.

export const LAYERS = ['person', 'agent', 'authorize', 'privilege', 'gateway', 'resource'];
export const LAYER_LABELS = {
  person: 'Person', agent: 'Agent', authorize: 'Authorize', privilege: 'Privilege', gateway: 'Agent gateway', resource: 'Resource server',
};
export const OUTCOMES = ['allowed', 'refused', 'blocked', 'info'];
export const ORIGINS = ['logged', 'simulated', 'response', 'not-logged'];
export const COVERAGE = ['logged', 'simulated', 'response', 'not-logged', 'unreachable'];
export const BASES = ['measured-shape', 'unverified-shape'];

export const LIMITS = { timeoutMs: 8000, maxBytes: 2_000_000, maxHits: 500, maxLines: 2000, maxRows: 500, maxMessage: 300, maxMaskInput: 8000, maxDepth: 8, maxJsonParse: 100_000, minIdTerm: 6 };

export class ReaderError extends Error {
  constructor(code, message) { super(message); this.name = 'ReaderError'; this.code = code; }
}
export class RunObsError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'RunObsError'; this.code = code; this.status = status; }
}

// A timestamp the way the products write it (ISO 8601, optional fraction up to nanoseconds). Anything else is not trusted as "exact".
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

// ---- Masker ----------------------------------------------------------------------------------------------
// Same intent as shared/ping-log-collector/vector.yaml (headers, Bearer/Basic, JWTs, sk- keys, secret-named fields, `code` parameters),
// plus addresses, emails and hostnames, and ids shortened to the first 4 and last 2 characters.
const CRED_WORDS = '(?:token|expired|invalid|missing|required|authentication|authorization|authenticate|credentials?|scheme|realm|failed|error|denied|refused)';
const VALUE = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|[^\\s,;&"\'}\\]]+';
const PREFIX = '(?:[A-Za-z0-9]+[_-])*';
const STRONG = `(?:client_secret|client_assertion|secret_key|private_key|api[_-]?key|password|passwd|passphrase|pwd|secret|assertion|code_verifier|session_id|sessionid|x-amz-security-token|(?:access|refresh|id|subject|actor|auth|bearer|csrf)[_-]token)`;
const SECRET_KEY = /(secret|token|password|passwd|authorization|api[-_]?key|private[-_]?key|credential|cookie|assertion|code_verifier|session[-_]?id)/i;
const SHORT_KEYS = /^(pass|pwd|sid|session|token)$/i;
const TLDS = 'com|org|net|io|dev|app|cloud|local|internal|example|invalid|test|localhost|lan|corp|svc|ai|co|us|uk|de|eu|info|biz|edu|gov|int|me|tech';
const short = (s) => `${s.slice(0, 4)}…${s.slice(-2)}`;
const quoted = (v) => (/^["']/.test(v) ? `${v[0]}***${v[0]}` : '***');

const MASK_RULES = [
  // headers whose whole value is a credential
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-amz-security-token|x-auth-token|x-csrf-token)(["']?\s*[:=]\s*["']?)[^\r\n"']*/gi, (_m, n, sep) => `${n}${sep}***`],
  [/\bCookie\{[^}]*\}/g, 'Cookie{***}'],
  [new RegExp(`\\b(Bearer|DPoP|ApiKey)\\s+(?!${CRED_WORDS}\\b)[A-Za-z0-9._~+/=-]{6,}`, 'gi'), '$1 ***'],
  [new RegExp(`\\bBasic\\s+(?!${CRED_WORDS}\\b)[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])`, 'gi'), 'Basic ***'],
  [/\beyJ[\w-]{10,}(?:\.[\w-]*)*/g, '<jwt>'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, 'xox*-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  // secret-named fields: name: value, name=value, "name":"value"; and the multi-line form (value on the next indented line)
  [new RegExp(`(["']?)(?<![A-Za-z0-9])(${PREFIX}${STRONG})(?![A-Za-z0-9])(["']?\\s*[:=]\\s*)(${VALUE})`, 'gi'), (_m, q, n, sep, v) => `${q}${n}${sep}${quoted(v)}`],
  [new RegExp(`(?<![A-Za-z0-9])(${PREFIX}${STRONG}(?![A-Za-z0-9])[ \\t]*:?[ \\t]*\\r?\\n[ \\t]+)\\S+`, 'gi'), '$1***'],
  // short names are only secrets when written name=value, or as a quoted JSON key with a string value
  [new RegExp(`(["']?)(?<![A-Za-z0-9])(${PREFIX}(?:token|pass|sid|session))(?![A-Za-z0-9])(["']?=\\s*)(${VALUE})`, 'gi'), (_m, q, n, sep, v) => `${q}${n}${sep}${quoted(v)}`],
  [/("(?:token|pass|sid|session)"\s*:\s*)("(?:[^"\\]|\\.)*")/gi, '$1"***"'],
  [new RegExp(`([?&;"']code["']?\\s*[:=]\\s*)(${VALUE})`, 'gi'), (_m, p, v) => `${p}${quoted(v)}`],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [/(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![\w:])/gi, '<ip>'],
  [new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?!\\.[a-z0-9])`, 'gi'), '<host>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => short(m)],
  [/\b[0-9a-f]{16,}\b/gi, (m) => short(m)],
  [/[A-Za-z0-9=]{20,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? short(m) : m)],
];

export function createMasker() {
  const mask = (input) => {
    let s = typeof input === 'string' ? input : String(input ?? '');
    if (s.length > LIMITS.maxMaskInput) s = `${s.slice(0, LIMITS.maxMaskInput)}…`;
    s = s.replace(/\p{Cf}/gu, ''); // zero-width and bidi format characters cannot hide a token from the rules below
    for (const [re, rep] of MASK_RULES) s = s.replace(re, rep);
    return s;
  };
  // Objects and arrays: depth and width bounded; a value under a secret-looking key never survives; strings are masked.
  const maskDeep = (value, key = '', depth = 0) => {
    if (depth > LIMITS.maxDepth) return '<too deep>';
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (key && (SECRET_KEY.test(key) || SHORT_KEYS.test(key))) return '***';
    if (typeof value === 'string') return mask(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => maskDeep(v, key, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [mask(k), maskDeep(v, k, depth + 1)]));
    return undefined;
  };
  return { mask, maskDeep };
}

// ---- Line matchers ---------------------------------------------------------------------------------------
// Table-driven: each entry maps one product's log line to { layer, outcome, message, detail }.
//   status 'measured'   the line shape was seen on a real run (sources: shared/ping-log-collector, observability-LAB docs and README,
//                       AI-DEMO2 privilege/GATEWAY-LOGGING-WITH-ELASTICSEARCH.md, all read-only)
//   status 'UNVERIFIED' nobody has measured this shape; the rows it makes carry basis 'unverified-shape'. DO NOT promote one without a capture.
// ANCHORING. A line is either JSON (it parses as an object) or text. A JSON line is only ever read through its own fields by a `json` matcher;
// a text matcher is skipped for it. A text matcher sees only the FIRST line of the entry, and every pattern starts at the beginning with the
// product's own prefix (the logback prefix, `level=... msg="`, the PingFederate `| tid:` columns) and ends at the end, so words a caller put
// in a request path or a message body cannot make a line count as a decision. A matcher returns null for a line it does not recognise;
// unrecognised lines are dropped (never guessed). `unverified: true` marks a row whose OUTCOME rests on an unmeasured value in a measured line.
const ANSI = /\u001b\[[0-9;]*m/g;
const kv = (text) => Object.fromEntries(text.split('|').map((p) => p.trim()).filter((p) => p.includes('=')).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null));
// PingGateway's logback prefix, measured on its router-error line: "[thread] LEVEL logger @route - ".
const GW_PREFIX = '^\\[[^\\]]+\\]\\s+[A-Z]+\\s+\\S+\\s+@\\S+\\s+-\\s+';
// The Privilege gateway log, logfmt: `time=<ISO> level=<l> msg="<text>"` (the time is dropped by the readers that keep it separately).
const LOGFMT = /^(?:time="?[^"\s]+"?\s+)?level=(\w+)\s+msg="((?:[^"\\]|\\.)*)"\s*$/;
const logfmt = (v) => { const m = LOGFMT.exec(v.first); return m ? { level: m[1], msg: m[2] } : null; };
const AUDIT_LINE = /^(?:\S*audit\.log:\s+)?(?:\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?\s*)?\|\s*tid:/;
const REFUSED_WORDS = /\b(denied|refused|forbidden|unauthori[sz]ed|insufficient|invalid|fail(?:ed|ure)|expired|mismatch|reject(?:ed|ing)?|not allowed)\b/i;
const MCP_HEADER = /^\[[^\]]*\]\s+(INFO|WARN|WARNING|ERROR):\s+(.*)$/;

const pgw = (id, re, build) => ({ id, product: 'privilege-gateway', status: 'measured', kind: 'text', match(v) { const l = logfmt(v); const m = l && re.exec(l.msg); return m ? build(m, l) : null; } });
const jsonDoc = (v) => v.obj;

export const layerMatchers = [
  {
    // MEASURED 2026-11-08 (observability-LAB audit-stdout): fields are positional after "tid:" — tid, tracking id, event, subject, ip, (blank),
    // client id, protocol, host id, component, status, (blank), description, response ms. Statuses seen: inprogress, failure. 'success' is UNVERIFIED.
    id: 'pf-audit', product: 'pingfederate', status: 'measured', kind: 'text',
    match(v) {
      if (!AUDIT_LINE.test(v.first)) return null;
      const f = v.first.split('|').map((p) => p.trim());
      const t = f.findIndex((p) => p.startsWith('tid:'));
      if (t < 0 || f.length < t + 11) return null;
      const [tid, tracking, event, subject, ip, , client, protocol, , component, status, , description] = f.slice(t);
      const st = (status || '').toLowerCase();
      const outcome = st === 'failure' ? 'refused' : st === 'success' ? 'allowed' : 'info';
      // No subject means a client authenticating on its own (no person signed in): that is the agent layer's event.
      return {
        layer: subject ? 'person' : 'agent', outcome, unverified: st === 'success',
        message: `PingFederate ${event || 'audit'} ${st || 'event'}${description ? `: ${description}` : ''}${client ? ` (client ${client})` : ''}`,
        detail: nonEmpty({ tid: tid.slice(4), trackingId: tracking, event, subject, ip, client, protocol, component, status }),
      };
    },
  },
  {
    // MEASURED 2026-11-08 (observability-LAB p1az-decision): "[P1AZ] DECISION: PERMIT | backend=real | sub=<id> | tool=<name> | method=tools/call | vertical=<v> | obligation=hitl".
    // PERMIT is measured; the wording for any other decision is NOT (DENY is mapped to refused, anything else to info; both UNVERIFIED).
    id: 'p1az-decision', product: 'pinggateway', status: 'measured', kind: 'text',
    match(v) {
      const m = new RegExp(`${GW_PREFIX}\\[P1AZ\\] DECISION:\\s*([A-Z_]+)\\b(.*)$`).exec(v.first);
      if (!m) return null;
      const f = kv(m[2]); const permit = m[1] === 'PERMIT'; const hold = permit && f.obligation === 'hitl';
      return {
        layer: 'authorize', outcome: hold ? 'info' : permit ? 'allowed' : m[1] === 'DENY' ? 'refused' : 'info', unverified: !permit,
        message: `PingOne Authorize ${m[1]}${f.tool ? ` for tool ${f.tool}` : ''}${f.method ? ` (${f.method})` : ''}${hold ? ': permitted with a human-approval obligation, so the call is held' : ''}`,
        detail: nonEmpty({ decision: m[1], sub: f.sub, tool: f.tool, method: f.method, vertical: f.vertical, obligation: f.obligation, backend: f.backend }),
      };
    },
  },
  {
    // MEASURED 2026-11-08 (same container): "INDETERMINATE - HITL challenge <id> minted for tool=<name>", behind the same logback prefix.
    id: 'p1az-hitl', product: 'pinggateway', status: 'measured', kind: 'text',
    match(v) {
      const m = new RegExp(`${GW_PREFIX}(?:\\[P1AZ\\]\\s+)?INDETERMINATE - HITL challenge (\\S+) minted for tool=(\\S*)\\s*$`).exec(v.first);
      return m ? { layer: 'authorize', outcome: 'info', message: `A human approval was requested${m[2] ? ` for tool ${m[2]}` : ''} (challenge ${m[1]})`, detail: nonEmpty({ challenge: m[1], tool: m[2] }) } : null;
    },
  },
  {
    // MEASURED 2026-11-08 (observability-LAB access-audit): one JSON object per request: eventName, response.statusCode (a string), http.request.path.
    // The line has no response body, so a 2xx is only `info` (an MCP error can ride in a 200); 401 and 403 are refusals.
    id: 'pinggateway-access', product: 'pinggateway', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (j.eventName !== 'OPENIG-HTTP-ACCESS') return null;
      const code = Number(j.response?.statusCode);
      const refused = code === 401 || code === 403;
      return {
        layer: 'gateway', outcome: refused ? 'refused' : 'info',
        message: `PingGateway answered ${j.response?.statusCode ?? '?'}${j.response?.status ? ` (${j.response.status})` : ''} to ${j.http?.request?.method ?? 'a request'} ${j.http?.request?.path ?? ''}${refused ? '' : '; the access line does not show the MCP result'}`.trim(),
        detail: nonEmpty({ route: j.ig?.routeName, statusCode: j.response?.statusCode, status: j.response?.status, elapsedTime: j.response?.elapsedTime }),
      };
    },
  },
  {
    // MEASURED 2026-11-08 (observability-LAB, topic mcp): client.method (tools/list, tools/call) and client.param (the tool name) on an authenticated call.
    id: 'pinggateway-mcp', product: 'pinggateway', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (j.eventName !== 'PING-GATEWAY-MCP' || !j.client?.method) return null;
      return { layer: 'gateway', outcome: 'info', message: `MCP ${j.client.method}${j.client.param ? ` ${j.client.param}` : ''} passed through PingGateway`, detail: nonEmpty({ method: j.client.method, param: j.client.param, clientId: j.client.id }) };
    },
  },
  // ---- Privilege agent gateway: logfmt lines — MEASURED 2026-11-07/08 (observability-LAB, privilege-logging-test-plan 8a/8c) ----
  pgw('pgw-token-found', /^Access token found for user: (\S+), client: (\S+)$/, (m) => ({ layer: 'agent', outcome: 'info', message: `The gateway saw an access token for user ${m[1]}, agent client ${m[2]}`, detail: { user: m[1], client: m[2] } })),
  pgw('pgw-policy-denied', /^\[mcpgw\] policy denied (\S+) access to (\w+) app (\S+) \(agent=(\w+)\)(?::.*)?$/, (m) => ({ layer: 'gateway', outcome: 'refused', message: `The gateway refused ${m[1]} access to ${m[2]} app ${m[3]} (policy denied)`, detail: { user: m[1], kind: m[2], app: m[3], agent: m[4] } })),
  pgw('pgw-proxying', /^Proxying to: (\S+)$/, (m) => ({ layer: 'gateway', outcome: 'allowed', message: `The gateway forwarded the call to ${m[1]} (it logs no allow line; forwarding is the evidence)`, detail: { backend: m[1] } })),
  pgw('pgw-mcp-call', /^MCP call detected for method (\S+) with target: (\S+)$/, (m) => ({ layer: 'gateway', outcome: 'info', message: `MCP ${m[1]} call to ${m[2]} detected`, detail: { method: m[1], target: m[2] } })),
  // The pair "authorization header missing" + "Invalid Authorization token" is written by ONE request (measured), so each is its own refusal row.
  pgw('pgw-auth-rejected', /^(authorization header missing|Invalid Authorization token)$/, (m) => ({ layer: 'gateway', outcome: 'refused', message: `The gateway refused a request: ${m[1]}`, detail: { reason: m[1] } })),
  pgw('pgw-aiguard-blocked', /^aiguard: blocked mcp response client=(\S+) category=(\S+)$/, (m) => ({ layer: 'privilege', outcome: 'blocked', message: `AI Guard blocked an MCP response (${m[2]}) for client ${m[1]}`, detail: { client: m[1], category: m[2] } })),
  // ---- Privilege gateway JSON documents (log-tailer / SIEM): field names MEASURED 2026-11-08, values are examples ----
  {
    id: 'pgw-json-denied', product: 'privilege-gateway', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (!/^(MCP|A2A) policy denied$/.test(j.msg || '')) return null;
      return { layer: 'privilege', outcome: 'refused', message: `${j.msg}${j.App ? ` for app ${j.App}` : ''}${j.Reason ? `: ${j.Reason}` : ''}`, detail: nonEmpty({ app: j.App, agent: j.Agent, principal: j.Principal, decision: j.Decision, reason: j.Reason }) };
    },
  },
  {
    // The verdict is recorded; whether the call was then blocked is NOT in this document, so the row is `info`, never `blocked`.
    id: 'pgw-json-aiguard', product: 'privilege-gateway', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (j.msg !== 'AIGuard') return null;
      return { layer: 'privilege', outcome: 'info', message: `AI Guard verdict recorded: ${j.Category || 'category not given'}${j.TopScore !== undefined ? ` (score ${j.TopScore})` : ''}; the document does not say whether the call was blocked`, detail: nonEmpty({ category: j.Category, client: j.Client, topScore: j.TopScore, level: j.level }) };
    },
  },
  // ---- Privilege SIEM index ping-siem-events-v2 (privilege_event_kind runtime) ----
  {
    // MEASURED shape (relayed 2026-11-08, never read by observability-LAB itself): Index 'policy-decision-log', Data.Decision allow | deny | hitl.
    id: 'siem-policy-decision', product: 'privilege-siem', status: 'measured', kind: 'json',
    match(v) {
      const j = jsonDoc(v);
      if (j.Index !== 'policy-decision-log') return null;
      const d = String(j.Data?.Decision ?? j.Decision ?? '').toLowerCase();
      const outcome = d === 'allow' ? 'allowed' : d === 'deny' ? 'refused' : 'info';
      return { layer: 'privilege', outcome, message: `Privilege policy decision: ${d || 'not given'}`, detail: nonEmpty({ decision: d, index: j.Index, level: j.Level }) };
    },
  },
  {
    id: 'siem-aiguard', product: 'privilege-siem', status: 'measured', kind: 'json',
    match(v) { const j = jsonDoc(v); return j.Index === 'aiguard-log' ? { layer: 'privilege', outcome: 'info', message: 'AI Guard verdict recorded in the SIEM; the document does not say whether the call was blocked', detail: nonEmpty({ index: j.Index, level: j.Level }) } : null; },
  },
  {
    // UNVERIFIED: the agent-approval-log shape has never been seen.
    id: 'siem-approval', product: 'privilege-siem', status: 'UNVERIFIED', kind: 'json',
    match(v) { const j = jsonDoc(v); return j.Index === 'agent-approval-log' ? { layer: 'privilege', outcome: 'info', message: 'An agent approval event was recorded', detail: nonEmpty({ index: j.Index, level: j.Level }) } : null; },
  },
  // ---- Prompt-Guard sidecar — MEASURED 2026-11-08 ----
  {
    id: 'promptguard-allow', product: 'promptguard', status: 'measured', kind: 'text',
    match(v) { return /^promptguard: \d+ unit\(s\) -> allow$/.test(v.first) ? { layer: 'privilege', outcome: 'allowed', message: 'Prompt-Guard judged the text safe', detail: {} } : null; },
  },
  {
    // The gateway wrote no block line beside a flag (measured), so a flag is information, not a refusal.
    id: 'promptguard-flagged', product: 'promptguard', status: 'measured', kind: 'text',
    match(v) { const m = /^promptguard: \d+ unit\(s\) -> Prompt-Guard flagged (\w+) \(([\d.]+)\)$/.exec(v.first); return m ? { layer: 'privilege', outcome: 'info', message: `Prompt-Guard flagged ${m[1]} (${m[2]}); the log does not say whether the call was blocked`, detail: { category: m[1], score: m[2] } } : null; },
  },
  // ---- Resource server (the banking MCP server): a header line "[<time>] LEVEL: message" (the indented lines under it are joined to the entry) ----
  {
    // UNVERIFIED: the wording of a refusal or a failed validation on the MCP server has never been captured; any rejection-like word makes it refused.
    id: 'mcp-server-refused', product: 'mcp-server', status: 'UNVERIFIED', kind: 'text',
    match(v) { const m = MCP_HEADER.exec(v.first); return m && REFUSED_WORDS.test(m[2]) ? { layer: 'resource', outcome: 'refused', message: `MCP server: ${m[2]}`, detail: { level: m[1] } } : null; },
  },
  {
    // UNVERIFIED: the wording of a served tool call has never been captured.
    id: 'mcp-server-served', product: 'mcp-server', status: 'UNVERIFIED', kind: 'text',
    match(v) { const m = MCP_HEADER.exec(v.first); return m && /\btool\b.*\b(called|executed|served|completed)\b/i.test(m[2]) ? { layer: 'resource', outcome: 'allowed', message: `MCP server: ${m[2]}`, detail: { level: m[1] } } : null; },
  },
  {
    // MEASURED 2026-11-08 (observability-LAB record-header): "[<time>] INFO: token audience validated" — token-validation steps, claim values, never the token.
    id: 'mcp-server-validation', product: 'mcp-server', status: 'measured', kind: 'text',
    match(v) { const m = MCP_HEADER.exec(v.first); return m && /token|audience|introspect|scope/i.test(m[2]) ? { layer: 'resource', outcome: 'info', message: `MCP server: ${m[2]}`, detail: { level: m[1] } } : null; },
  },
];

// What a matcher sees: the text without ANSI colour and format characters, its first line, and the parsed object when the entry is JSON.
function viewOf(line) {
  const text = String(line.message ?? '').replace(ANSI, '').replace(/\p{Cf}/gu, '');
  const t = text.trimStart();
  let obj = null;
  if (t.startsWith('{') && t.length <= LIMITS.maxJsonParse) {
    try { const parsed = JSON.parse(t); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed; } catch { /* not JSON: a text line */ }
  }
  return { text, first: text.split('\n', 1)[0], obj };
}

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// A lab's own matchers (createRunObservability({ matchers })). They run AFTER the built-ins, only on text lines a reader really returned, and
// can never create a row without one or choose its origin. Each declares layer, product and basis, and its pattern is anchored.
//   { id, product, layer, basis: 'measured-shape'|'unverified-shape', pattern: /^...$/, build(match) -> { outcome, message, detail? } | null }
export function validateMatchers(list = []) {
  if (!Array.isArray(list)) throw new RunObsError('bad_matcher', 'matchers must be an array.');
  const seen = new Set(layerMatchers.map((m) => m.id));
  return list.map((m) => {
    const bad = (why) => { throw new RunObsError('bad_matcher', `Lab matcher ${m?.id ?? '?'}: ${why}.`); };
    if (!m || typeof m !== 'object') bad('not an object');
    if (typeof m.id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(m.id) || seen.has(m.id)) bad('needs a unique id of lower-case letters, digits and hyphens');
    seen.add(m.id);
    if (typeof m.product !== 'string' || !NAME_OK.test(m.product)) bad('needs a product');
    if (!LAYERS.includes(m.layer)) bad(`layer must be one of ${LAYERS.join(', ')}`);
    if (!BASES.includes(m.basis)) bad(`basis must be ${BASES.join(' or ')}`);
    if (!(m.pattern instanceof RegExp) || m.pattern.flags.includes('m') || !m.pattern.source.startsWith('^') || !/(?<!\\)\$$/.test(m.pattern.source)) bad('pattern must be a RegExp anchored with ^ at the start and $ at the end, without the m flag');
    if (typeof m.build !== 'function') bad('needs a build function');
    return m;
  });
}

export function classify(line, labMatchers = []) {
  const v = viewOf(line);
  for (const m of layerMatchers) {
    if (m.product !== line.product || (m.kind === 'json') !== (v.obj !== null)) continue;
    const r = m.match(v);
    if (r) return { ...r, matcher: m.id, basis: m.status === 'UNVERIFIED' || r.unverified ? 'unverified-shape' : 'measured-shape' };
  }
  if (v.obj === null) {
    for (const m of labMatchers) {
      if (m.product !== line.product) continue;
      const found = m.pattern.exec(v.first);
      const r = found && m.build(found, line);
      if (r && OUTCOMES.includes(r.outcome) && typeof r.message === 'string') return { layer: m.layer, outcome: r.outcome, message: r.message, detail: r.detail ?? {}, matcher: m.id, basis: m.basis };
    }
  }
  return null;
}

// ---- The collector ---------------------------------------------------------------------------------------
// A layer spec: { layer, products: [product ids to read], simulated: [{ at, product?, outcome, message, detail? }] (mock only),
// responses: [same shape] (real only: decisions the lab holds as an API response, origin 'response'), reason (why products is empty) }.
// `at` is an ISO string or epoch milliseconds, like the window.
const SAAS = 'PingOne sign-in and PingOne Authorize events are in the PingOne audit activity API, not in a container log; this panel does not read it yet (see the README follow-ups). A decision the lab holds as an API response is shown as a response row, never as logged.';
export function defaultLayers() {
  return [
    { layer: 'person', products: ['pingfederate'] },
    { layer: 'agent', products: ['pingfederate', 'privilege-gateway'] },
    { layer: 'authorize', products: ['pinggateway'] },
    { layer: 'privilege', products: ['privilege-siem', 'privilege-gateway', 'promptguard'] },
    { layer: 'gateway', products: ['privilege-gateway', 'pinggateway'] },
    { layer: 'resource', products: ['mcp-server'] },
  ];
}
export const saasLayer = (layer, responses = []) => ({ layer, products: [], reason: SAAS, responses });

const iso = (ms) => new Date(ms).toISOString();
const toMs = (v, name) => { const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN; if (!Number.isFinite(ms)) throw new RunObsError('bad_window', `${name} is not a time.`); return ms; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-token matching of the run's ids: a short or common sub ("user", "demo") must not mark unrelated lines as this run's.
const terms = (c = {}) => [c.sub, c.actClientId, c.traceId, ...(Array.isArray(c.requestIds) ? c.requestIds : [])]
  .filter((t) => typeof t === 'string' && t.length >= LIMITS.minIdTerm).map((t) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(t)}(?![A-Za-z0-9_-])`, 'i'));

export function createRunObservability({ readers = [], masker = createMasker(), clock = () => Date.now(), matchers = [] } = {}) {
  const { mask, maskDeep } = masker;
  const labMatchers = validateMatchers(matchers);
  const cap = (s) => { const t = mask(s); return t.length > LIMITS.maxMessage ? `${t.slice(0, LIMITS.maxMessage)}…` : t; };
  const cache = new WeakMap();
  const classified = (line) => { if (!cache.has(line)) cache.set(line, classify(line, labMatchers)); return cache.get(line); };

  const rowFrom = (e, layer, origin) => {
    const ms = typeof e?.at === 'number' ? e.at : typeof e?.at === 'string' ? Date.parse(e.at) : NaN;
    if (!OUTCOMES.includes(e?.outcome) || !Number.isFinite(ms) || typeof e.message !== 'string' || !e.message) {
      throw new RunObsError(`bad_${origin}_row`, `A ${origin} ${layer} row needs at (ISO or epoch ms), outcome (${OUTCOMES.join('/')}) and a message string.`);
    }
    return { at: ms, atExact: typeof e.at === 'string' && ISO_RE.test(e.at) ? e.at : iso(ms), layer, product: cap(e.product || (origin === 'simulated' ? 'lab mock' : 'API response')), outcome: e.outcome, message: cap(e.message), origin, detail: e.detail === undefined ? undefined : maskDeep(e.detail) };
  };

  // In the order given (readersFromEnv: Elasticsearch first, Docker only when opted in): the first reader that can read this product and does not fail wins.
  // Never silent: every failure reason is kept.
  async function readProduct(product, from, to) {
    const reasons = [];
    for (const reader of readers) {
      if (!reader.canRead(product)) { reasons.push(`${reader.name}: no source configured for ${product}`); continue; }
      try {
        const res = await reader.readLines({ product, from, to, match: (l) => classified(l) !== null });
        if (!Array.isArray(res?.lines)) throw new ReaderError('bad_reader', 'the reader returned no lines array');
        return { ...res, reader: reader.name, fellBack: reasons };
      } catch (e) {
        reasons.push(`${reader.name}: ${e instanceof ReaderError ? e.message : 'unexpected error reading logs'}`);
      }
    }
    return { failed: reasons.length ? reasons : ['no log reader is configured: set RUN_OBS_ES_URL and RUN_OBS_ES_READ_APIKEY (a read-only Elasticsearch key; see the README), or RUN_OBS_DOCKER=1 with RUN_OBS_CONTAINERS for an ad-hoc run'] };
  }

  async function collectRun({ runId, startedAt, endedAt, correlation = {}, layers = defaultLayers(), source = 'real' } = {}) {
    if (source !== 'mock' && source !== 'real') throw new RunObsError('bad_source', 'source must be mock or real.');
    const from = toMs(startedAt, 'startedAt'); const to = endedAt === undefined ? clock() : toMs(endedAt, 'endedAt');
    if (to < from) throw new RunObsError('bad_window', 'endedAt is before startedAt.');
    const specs = layers.map((l) => (typeof l === 'string' ? defaultLayers().find((d) => d.layer === l) : l));
    for (const s of specs) if (!s || !LAYERS.includes(s.layer)) throw new RunObsError('bad_layer', `Unknown layer: ${s?.layer}.`);
    // A layer the lab did not ask for is not-logged and says so: every record names all six layers.
    for (const l of LAYERS) if (!specs.some((x) => x.layer === l)) specs.push({ layer: l, products: [], reason: 'This lab did not ask for this layer.' });
    const want = terms(correlation);
    const rows = []; const coverage = {}; const reasons = {}; const partial = {};
    let truncated = false;

    if (source === 'mock') {
      for (const s of specs) {
        const sim = Array.isArray(s.simulated) ? s.simulated : [];
        if (Array.isArray(s.responses) && s.responses.length) throw new RunObsError('bad_response_row', 'A mock run has no API responses: the mock computed them, so they are simulated rows.');
        for (const e of sim) rows.push(rowFrom(e, s.layer, 'simulated'));
        coverage[s.layer] = sim.length ? 'simulated' : 'not-logged';
        if (!sim.length) reasons[s.layer] = s.reason || 'The lab mock produced no event for this layer.';
      }
    } else {
      const products = [...new Set(specs.flatMap((s) => s.products || []))];
      const read = new Map(await Promise.all(products.map(async (p) => [p, await readProduct(p, from, to)])));
      for (const s of specs) {
        const prods = s.products || [];
        const resp = Array.isArray(s.responses) ? s.responses : [];
        if (Array.isArray(s.simulated) && s.simulated.length) throw new RunObsError('bad_simulated_row', 'A real run cannot hold simulated rows.');
        for (const e of resp) rows.push(rowFrom(e, s.layer, 'response'));
        if (!prods.length) {
          coverage[s.layer] = resp.length ? 'response' : 'not-logged';
          if (!resp.length) reasons[s.layer] = s.reason || 'No log source applies to this layer.';
          continue;
        }
        let got = 0; let readOk = 0; const why = [];
        for (const p of prods) {
          const r = read.get(p);
          if (r.failed) { why.push(`${p}: ${r.failed.join('; ')}`); continue; }
          readOk += 1;
          if (r.fellBack.length) why.push(`${p}: read from ${r.reader} after ${r.fellBack.join('; ')}`);
          for (const n of r.notes || []) why.push(`${p}: ${n}`);
          if (r.truncated) { truncated = true; partial[s.layer] = true; why.push(`${p}: the search was cut at the cap, so absence is not proof`); }
          for (const line of r.lines) {
            const c = classified(line);
            if (!c || c.layer !== s.layer || !Number.isFinite(line.at) || line.at < from || line.at > to) continue;
            const hay = `${line.message} ${line.requestId || ''}`;
            rows.push({
              at: line.at, atExact: ISO_RE.test(line.atExact) ? line.atExact : iso(line.at), layer: s.layer, product: p, outcome: c.outcome, message: cap(c.message), origin: 'logged', basis: c.basis,
              matchedBy: want.some((re) => re.test(hay)) ? 'id' : 'window', matcher: c.matcher, detail: maskDeep(c.detail),
              ...(line.host ? { host: cap(line.host) } : {}),
            });
            got += 1;
          }
        }
        if (got) coverage[s.layer] = 'logged';
        else if (resp.length) coverage[s.layer] = 'response';
        else if (readOk) { coverage[s.layer] = 'not-logged'; reasons[s.layer] = partial[s.layer] ? 'No matching line was found in what was read.' : 'No matching line was found for this run in the window. The product may not log this event.'; }
        else coverage[s.layer] = 'unreachable';
        if (why.length) reasons[s.layer] = (reasons[s.layer] ? `${reasons[s.layer]} ` : '') + cap(why.join(' | '));
      }
    }

    // The cap: placeholders for not-logged layers are counted in it. Rows are dropped OLDEST first from the layer holding the most, so every
    // layer keeps its newest rows; coverage is then rebuilt from the rows that are left, never claiming what no row supports.
    rows.sort((a, b) => a.at - b.at);
    const placeholder = new Set(specs.filter((s) => coverage[s.layer] === 'not-logged').map((s) => s.layer));
    const kind = (l, rs) => (rs.some((r) => r.layer === l && r.origin === 'logged') ? 'logged' : rs.some((r) => r.layer === l && r.origin === 'response') ? 'response' : rs.some((r) => r.layer === l && r.origin === 'simulated') ? 'simulated' : null);
    let kept = rows;
    for (let pass = 0; pass <= LAYERS.length; pass += 1) {
      const budget = Math.max(0, LIMITS.maxRows - placeholder.size);
      const by = new Map();
      for (const r of rows) { if (!by.has(r.layer)) by.set(r.layer, []); by.get(r.layer).push(r); }
      const heads = new Map([...by.keys()].map((l) => [l, 0]));
      let total = rows.length;
      while (total > budget) {
        let pick = null;
        for (const [l, list] of by) { const left = list.length - heads.get(l); if (left > 0 && (pick === null || left > by.get(pick).length - heads.get(pick))) pick = l; }
        heads.set(pick, heads.get(pick) + 1); total -= 1;
      }
      kept = [...by].flatMap(([l, list]) => list.slice(heads.get(l)));
      if (kept.length < rows.length) truncated = true;
      let lost = false;
      for (const s of specs) {
        if (!['logged', 'response', 'simulated'].includes(coverage[s.layer])) continue;
        const now = kind(s.layer, kept);
        if (now === coverage[s.layer]) continue;
        lost = true;
        if (now) coverage[s.layer] = now;
        else { coverage[s.layer] = 'not-logged'; reasons[s.layer] = 'Every row of this layer was dropped at the row cap; narrow the run window to see them.'; placeholder.add(s.layer); }
      }
      if (!lost) break;
    }
    kept.sort((a, b) => a.at - b.at);
    const out = kept.map((r, i) => ({ id: `r${i + 1}`, ...r, at: iso(r.at) }));
    for (const s of specs) {
      if (placeholder.has(s.layer) && coverage[s.layer] === 'not-logged') {
        out.push({ id: `n-${s.layer}`, at: null, layer: s.layer, product: cap((s.products || []).join(', ') || 'none'), outcome: 'info', message: cap(reasons[s.layer]), origin: 'not-logged' });
      }
    }
    const summary = { allowed: 0, refused: 0, blocked: 0, info: 0 };
    for (const r of out) if (r.origin !== 'not-logged') summary[r.outcome] += 1;
    return {
      runId: cap(runId ?? ''), window: { from: iso(from), to: iso(to) }, source, excerpt: true, truncated, rows: out, coverage,
      reasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, cap(v)])), partial, summary,
    };
  }

  return { collectRun };
}

// ---- The contract ----------------------------------------------------------------------------------------
// Returns a list of problems (empty = fine). Every lab test calls it on a mock and a real record; it is the honesty rule, written as code.
const CRED_RE = `(?!${CRED_WORDS}\\b)`;
const LEAKS = [
  [new RegExp(`\\b(?:Bearer|DPoP)\\s+(?![*<])${CRED_RE}[A-Za-z0-9._~+/=-]{6,}`, 'i'), 'an unmasked Bearer credential'],
  [new RegExp(`\\bApiKey\\s+(?![*<])${CRED_RE}[A-Za-z0-9._~+/=-]{6,}`, 'i'), 'an unmasked ApiKey credential'],
  [new RegExp(`\\bBasic\\s+(?![*<])${CRED_RE}[A-Za-z0-9+/]{8,}`, 'i'), 'a Basic credential'],
  [/\beyJ[\w-]{10,}/, 'a JWT'],
  [/\bsk-(?!\*)[A-Za-z0-9_-]{8,}/, 'an sk- key'],
  [/\bxox[abprs]-(?!\*)[A-Za-z0-9-]{8,}/, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a cloud or git token'],
  [new RegExp(`(?<![A-Za-z0-9])${PREFIX}${STRONG}(?![A-Za-z0-9])["']?\\s*[:=]\\s*["']?(?!\\*\\*\\*|<redacted>|["'])[^\\s"',}]{3,}`, 'i'), 'a secret-named field with a value'],
  [new RegExp(`(?<![A-Za-z0-9])${PREFIX}(?:token|pass|sid|session)(?![A-Za-z0-9])=["']?(?!\\*\\*\\*|["'])[^\\s"',}]{3,}`, 'i'), 'a token, pass, sid or session value'],
  [/\b(?:authorization|cookie|set-cookie|x-api-key|x-amz-security-token)\s*:\s*(?!\*\*\*)[^\s*]{4,}/i, 'an unmasked credential header'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'an IPv4 address'],
  [/(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![\w:])/i, 'an IPv6 address'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, 'an email address'],
  [new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?!\\.[a-z0-9])`, 'i'), 'a hostname'],
];
function* strings(v, depth = 0) {
  if (depth > 10) return;
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x, depth + 1);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { yield k; yield* strings(x, depth + 1); }
}

export function assertRunObservability(r) {
  const bad = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (r.source !== 'mock' && r.source !== 'real') bad.push(`source must be mock or real, got ${r.source}`);
  if (r.excerpt !== true) bad.push('a record must say it is an excerpt (excerpt: true)');
  if (!r.window || !Number.isFinite(Date.parse(r.window.from)) || !Number.isFinite(Date.parse(r.window.to))) bad.push('window needs from and to');
  if (!Array.isArray(r.rows)) { bad.push('rows must be an array'); return bad; }
  const cov = r.coverage && typeof r.coverage === 'object' ? r.coverage : {};
  if (!r.coverage) bad.push('coverage is missing');
  else for (const l of LAYERS) if (!(l in cov)) bad.push(`coverage names no state for layer ${l}`);
  if (!r.summary || typeof r.summary !== 'object') bad.push('summary is missing');
  const count = { allowed: 0, refused: 0, blocked: 0, info: 0 };
  const has = Object.fromEntries(LAYERS.map((l) => [l, { logged: false, simulated: false, response: false, 'not-logged': false }]));
  for (const [i, row] of r.rows.entries()) {
    const at = `row ${row?.id ?? i}`;
    if (!row || typeof row !== 'object') { bad.push(`${at} is not an object`); continue; }
    if (!LAYERS.includes(row.layer)) bad.push(`${at}: layer ${row.layer}`);
    if (!OUTCOMES.includes(row.outcome)) bad.push(`${at}: outcome ${row.outcome}`);
    if (!ORIGINS.includes(row.origin)) bad.push(`${at}: origin ${row.origin}`);
    if (!row.message) bad.push(`${at}: no message`);
    if (has[row.layer] && ORIGINS.includes(row.origin)) has[row.layer][row.origin] = true;
    if (row.origin === 'logged') {
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a logged row needs the timestamp of its log line`);
      if (!BASES.includes(row.basis)) bad.push(`${at}: a logged row needs basis ${BASES.join(' or ')}`);
      if (r.source === 'mock') bad.push(`${at}: a mock record cannot hold a logged row; nothing was read from a log`);
    }
    if (row.origin === 'simulated') {
      if (r.source === 'real') bad.push(`${at}: a real record cannot hold a simulated row`);
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a simulated row needs a time`);
      if (row.basis || row.matchedBy) bad.push(`${at}: a simulated row is presented as read from a log (basis or matchedBy set)`);
    }
    if (row.origin === 'response') {
      if (r.source === 'mock') bad.push(`${at}: a mock record cannot hold a response row; the mock computed it, so it is simulated`);
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a response row needs the time the lab received it`);
      if (row.basis || row.matchedBy || row.matcher) bad.push(`${at}: a response row is presented as read from a log (basis, matchedBy or matcher set)`);
    }
    if (row.origin === 'not-logged' && row.at) bad.push(`${at}: a not-logged row has no log line, so it has no timestamp`);
    if (row.passed === true && row.outcome === 'info') bad.push(`${at}: an info row is counted as passed`);
    if (row.origin !== 'not-logged' && count[row.outcome] !== undefined) count[row.outcome] += 1;
  }
  for (const [layer, state] of Object.entries(cov)) {
    if (!LAYERS.includes(layer)) { bad.push(`coverage names an unknown layer ${layer}`); continue; }
    if (!COVERAGE.includes(state)) { bad.push(`coverage ${layer}: ${state}`); continue; }
    const h = has[layer];
    // The tag must be exactly what the rows support: logged wins over response, which wins over simulated.
    const supported = h.logged ? 'logged' : h.response ? 'response' : h.simulated ? 'simulated' : null;
    if (state === 'logged' || state === 'response' || state === 'simulated') {
      if (!h[state]) bad.push(`coverage ${layer} says ${state} but no ${state} row exists`);
      else if (supported !== state) bad.push(`coverage ${layer} says ${state} but the rows support ${supported}`);
    } else if (supported) bad.push(`coverage ${layer} says ${state} but a ${supported} row exists for it`);
    if (state === 'not-logged' && !h['not-logged']) bad.push(`coverage ${layer} says not-logged but there is no not-logged row saying so`);
    if (state === 'logged' && r.source === 'mock') bad.push(`coverage ${layer}: a mock record cannot say logged`);
    if (state === 'response' && r.source === 'mock') bad.push(`coverage ${layer}: a mock record cannot say response`);
    if (state === 'simulated' && r.source === 'real') bad.push(`coverage ${layer}: a real record cannot say simulated`);
    if ((state === 'unreachable' || state === 'not-logged') && !(r.reasons && r.reasons[layer])) bad.push(`coverage ${layer}: ${state} needs a reason`);
    if (r.partial?.[layer] && state === 'not-logged' && !/not proof/.test(r.reasons?.[layer] ?? '')) bad.push(`coverage ${layer}: a partial search must say absence is not proof`);
  }
  if (r.summary) {
    for (const k of Object.keys(count)) if (r.summary[k] !== count[k]) bad.push(`summary.${k} is ${r.summary[k]} but the rows say ${count[k]} (an info row must never be counted as allowed)`);
  }
  for (const s of strings(r)) for (const [re, what] of LEAKS) if (re.test(s)) { bad.push(`the record holds ${what}`); break; }
  return [...new Set(bad)];
}

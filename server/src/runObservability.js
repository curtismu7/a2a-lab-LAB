// runObservability.js — "What each layer logged for this run" (Rule 27): collects, masks and orders the log lines one run left behind.
// Vendor to server/src/runObservability.js. Dependency-free ESM, Node >= 22. Read RunObservability.jsx for the record it feeds.
//
// HONESTY (Rule 25, applied to logs). Every row carries an origin:
//   logged       a real line read, read-only, from the product's own log, with the line's own timestamp, ids and tokens masked
//   simulated    the lab's mock computed it; never presented as read from a log
//   response     a decision the lab already holds as an API response (a PingOne Authorize permit/deny and its policy): real, but NOT read from a
//                log, so it is never tagged or counted as `logged`
//   not-logged   no line was found for this run (the product may not log this event); the panel says so, it never claims a line
// A missing event is never invented. An `info` row is never counted as passed. A line shape nobody has measured is marked
// `UNVERIFIED` in the matcher table below and its rows carry basis 'unverified-shape'.
// SECRETS. Everything that leaves this module passes the masker (a second time for readers that already scrub). The Docker reader only
// ever sends GET /containers/{name}/logs; the Elasticsearch reader only ever sends ONE read-only POST /<index>/_search to a loopback URL.
import http from 'node:http';
import fs from 'node:fs/promises';

export const LAYERS = ['person', 'agent', 'authorize', 'privilege', 'gateway', 'resource'];
export const LAYER_LABELS = {
  person: 'Person', agent: 'Agent', authorize: 'Authorize', privilege: 'Privilege', gateway: 'Agent gateway', resource: 'Resource server',
};
export const OUTCOMES = ['allowed', 'refused', 'blocked', 'info'];
export const ORIGINS = ['logged', 'simulated', 'response', 'not-logged'];
export const COVERAGE = ['logged', 'simulated', 'response', 'not-logged', 'unreachable'];
export const BASES = ['measured-shape', 'unverified-shape'];

export const LIMITS = { timeoutMs: 8000, maxBytes: 2_000_000, maxHits: 500, maxLines: 2000, maxRows: 500, maxMessage: 300, maxMaskInput: 8000, maxDepth: 8 };

export class ReaderError extends Error {
  constructor(code, message) { super(message); this.name = 'ReaderError'; this.code = code; }
}
export class RunObsError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'RunObsError'; this.code = code; this.status = status; }
}

// ---- Masker ----------------------------------------------------------------------------------------------
// Same intent as shared/ping-log-collector/vector.yaml (headers, Bearer/Basic, JWTs, sk- keys, secret-named fields, `code` parameters),
// plus addresses, emails and hostnames, and ids shortened to the first 4 and last 2 characters.
const SECRET_NAMES = '(?:client_secret|password|passwd|client_assertion|refresh_token|access_token|id_token|subject_token|actor_token|assertion|code_verifier|api[_-]?key|secret|private[_-]?key)';
const SECRET_KEY = /(secret|token|password|passwd|authorization|api[-_]?key|private[-_]?key|credential|cookie|assertion|code_verifier)/i;
const TLDS = 'com|org|net|io|dev|app|cloud|local|internal|example|invalid|test|localhost|lan|corp|svc|ai|co|us|uk|de|eu|info|biz|edu|gov|int|me|tech';
const short = (s) => `${s.slice(0, 4)}…${s.slice(-2)}`;
const quoted = (v) => (/^["']/.test(v) ? `${v[0]}***${v[0]}` : '***');

const MASK_RULES = [
  // headers whose whole value is a credential
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(["']?\s*[:=]\s*["']?)[^\r\n"']*/gi, (_m, n, sep) => `${n}${sep}***`],
  [/\bCookie\{[^}]*\}/g, 'Cookie{***}'],
  [/\b(Bearer|ApiKey|DPoP)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 ***'],
  [/\bBasic\s+(?![a-z]+\b)[A-Za-z0-9+/]{8,}={0,2}/g, 'Basic ***'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]*)?/g, '<jwt>'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  // secret-named fields: name: value, name=value, "name":"value"; and the multi-line form (value on the next indented line)
  [new RegExp(`(["']?\\b${SECRET_NAMES}\\b["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"'}\\]]+)`, 'gi'), (_m, p, v) => `${p}${quoted(v)}`],
  [new RegExp(`(\\b${SECRET_NAMES}\\b[ \\t]*:?[ \\t]*\\r?\\n[ \\t]+)\\S+`, 'gi'), '$1***'],
  [/([?&;"']code["']?\s*[:=]\s*)("[^"]*"|[^\s&"',}]+)/gi, (_m, p, v) => `${p}${quoted(v)}`],
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
    for (const [re, rep] of MASK_RULES) s = s.replace(re, rep);
    return s;
  };
  // Objects and arrays: depth and width bounded; a value under a secret-looking key never survives; strings are masked.
  const maskDeep = (value, key = '', depth = 0) => {
    if (depth > LIMITS.maxDepth) return '<too deep>';
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (key && SECRET_KEY.test(key)) return '***';
    if (typeof value === 'string') return mask(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => maskDeep(v, key, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [mask(k), maskDeep(v, k, depth + 1)]));
    return undefined;
  };
  return { mask, maskDeep };
}

// ---- Readers ---------------------------------------------------------------------------------------------
// A line: { at (epoch ms), atExact (the source's own timestamp text), product, message, host?, level?, requestId? }.
// readLines({ product, from, to, match }) -> { lines, truncated }. `match(line)` (optional) keeps only the lines the caller cares about,
// before the cap is applied. A reader throws ReaderError when it cannot read; it never returns an empty answer for a failure.
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DOCKER_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/s;

// Docker's log stream is multiplexed (8-byte header per frame) unless the container has a TTY.
function demux(buf) {
  if (!(buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0)) return buf.toString('utf8');
  const parts = [];
  for (let i = 0; i + 8 <= buf.length;) {
    const size = buf.readUInt32BE(i + 4);
    if (i + 8 + size > buf.length) { parts.push(buf.subarray(i + 8)); break; }
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

// Lines that start with a space or tab continue the entry above (an indented detail block, a PingFederate [CONTINUED] dump).
function joinContinuations(rows) {
  const out = [];
  for (const r of rows) {
    if (out.length && r.continuation) out[out.length - 1].message += `\n${r.message}`;
    else if (!r.continuation) out.push({ ...r });
  }
  return out;
}

function finish(rows, { product, from, to, match, host }) {
  const lines = [];
  let truncated = false;
  for (const r of joinContinuations(rows)) {
    if (!Number.isFinite(r.at) || r.at < from || r.at > to) continue;
    const line = { at: r.at, atExact: r.atExact, product, message: r.message, ...(host ? { host } : {}) };
    if (match && !match(line)) continue;
    if (lines.length >= LIMITS.maxLines) { truncated = true; break; }
    lines.push(line);
  }
  return { lines, truncated };
}

export class DockerLogReader {
  // containers: { product: containerName }; files: { product: absolute path of a log file mounted read-only }
  constructor({ socketPath = '/var/run/docker.sock', containers = {}, files = {}, timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.maxBytes } = {}) {
    this.name = 'docker';
    this.socketPath = socketPath; this.containers = containers; this.files = files; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
  }

  canRead(product) { return Boolean(this.containers[product] || this.files[product]); }

  // The ONLY Docker request this class can make: GET /containers/{name}/logs. No POST, no exec, no other path.
  #get(name, from, to) {
    if (!NAME_OK.test(name)) throw new ReaderError('docker_bad_name', 'The configured container name is not a plain name.');
    const path = `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=1&since=${Math.floor(from / 1000)}&until=${Math.ceil(to / 1000) + 1}`;
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path, method: 'GET', headers: { host: 'docker' }, timeout: this.timeoutMs }, (res) => {
        const chunks = []; let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > this.maxBytes) { req.destroy(new ReaderError('docker_too_large', 'Docker returned more log than this panel will read; narrow the window.')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode === 404) return reject(new ReaderError('docker_no_container', `Docker has no container named ${name}.`));
          if (res.statusCode !== 200) return reject(new ReaderError('docker_error', `Docker answered HTTP ${res.statusCode}.`));
          resolve(body);
        });
        res.on('error', (e) => reject(e));
      });
      req.on('timeout', () => req.destroy(new ReaderError('docker_timeout', 'Docker did not answer in time.')));
      req.on('error', (e) => reject(e instanceof ReaderError ? e : new ReaderError('docker_unreachable', `Docker socket not reachable (${String(e.code || e.message).slice(0, 40)}).`)));
      req.end();
    });
  }

  async readLines({ product, from, to, match }) {
    const file = this.files[product];
    if (file) {
      try { return await this.#readFile(file, { product, from, to, match }); } catch (e) { if (!this.containers[product]) throw e; }
    }
    const name = this.containers[product];
    if (!name) throw new ReaderError('docker_not_configured', `No container is configured for ${product}.`);
    const text = demux(await this.#get(name, from, to));
    const rows = [];
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      const m = DOCKER_TS.exec(raw);
      if (!m) { if (/^[ \t]/.test(raw)) rows.push({ continuation: true, message: raw.trim() }); continue; }
      const body = m[2].replace(/\r$/, '');
      rows.push({ at: Date.parse(m[1]), atExact: m[1], message: body, continuation: /^[ \t]/.test(body) && rows.length > 0, ...(/^[ \t]/.test(body) ? { message: body.trim() } : {}) });
    }
    return finish(rows, { product, from, to, match, host: name });
  }

  // A log file mounted read-only (the Privilege gateway writes cyonproxy.log to a file, not stdout). Lines start with time=<RFC 3339>.
  // The exact time format is UNVERIFIED: a line whose time does not parse is skipped, never given a guessed time.
  async #readFile(path, ctx) {
    let handle;
    try {
      handle = await fs.open(path, 'r');
      const { size } = await handle.stat();
      const length = Math.min(size, this.maxBytes);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      const rows = [];
      for (const raw of buf.toString('utf8').split('\n')) {
        const m = /^time="?([^"\s]+)"?\s+(.*)$/.exec(raw);
        if (m) rows.push({ at: Date.parse(m[1]), atExact: m[1], message: m[2] });
      }
      return finish(rows, ctx);
    } catch (e) {
      if (e instanceof ReaderError) throw e;
      throw new ReaderError('file_unreadable', `The log file for ${ctx.product} is not readable (${String(e.code || e.message).slice(0, 40)}).`);
    } finally { await handle?.close(); }
  }
}

const SECRET_FIELD = /(secret|token|password|authorization|api[-_]?key|private[-_]?key|credential)/i;
function scrubDoc(value, key = '', depth = 0) {
  if (depth > LIMITS.maxDepth) return '<too deep>';
  if (key && SECRET_FIELD.test(key) && typeof value !== 'number' && typeof value !== 'boolean') return '<redacted>';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubDoc(v, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [k, scrubDoc(v, k, depth + 1)]));
  return value;
}

const SIEM_INDEX = 'ping-siem-events-v2';
const LOGS_INDEXES = 'ping-logs-*,demo-logs-*';
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

export class ElasticsearchReader {
  // url: a loopback origin (an Elasticsearch port-forward); apiKey: a READ-ONLY key. Neither is ever returned or logged.
  constructor({ url, apiKey, timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.maxBytes } = {}) {
    this.name = 'elasticsearch';
    this.url = url; this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
  }

  canRead() { return true; }

  async readLines({ product, from, to, match }) {
    if (!this.url || !this.apiKey) throw new ReaderError('es_not_configured', 'Elasticsearch is not configured (RUN_OBS_ES_URL and RUN_OBS_ES_READ_APIKEY).');
    let u;
    try { u = new URL(this.url); } catch { throw new ReaderError('es_bad_url', 'RUN_OBS_ES_URL is not a URL.'); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || !LOOPBACK.test(u.hostname)) {
      throw new ReaderError('es_not_loopback', 'RUN_OBS_ES_URL must be a plain loopback http(s) URL (a port-forward on 127.0.0.1).');
    }
    const siem = product === 'privilege-siem';
    const index = siem ? SIEM_INDEX : LOGS_INDEXES;
    const filter = [{ range: { '@timestamp': { gte: new Date(from).toISOString(), lte: new Date(to).toISOString() } } }];
    if (!siem) filter.push({ bool: { should: [{ term: { ping_product: product } }, { term: { demo_service: product } }], minimum_should_match: 1 } });
    const body = JSON.stringify({ size: LIMITS.maxHits, track_total_hits: false, sort: [{ '@timestamp': { order: 'asc', unmapped_type: 'date' } }], query: { bool: { filter } } });
    let res;
    try {
      res = await fetch(`${u.origin}/${index}/_search`, {
        method: 'POST', redirect: 'error', body, signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `ApiKey ${this.apiKey}` },
      });
    } catch (e) {
      throw new ReaderError('es_unreachable', `Could not reach Elasticsearch at ${u.host}: ${String(e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || (/redirect/i.test(`${e.message} ${e.cause?.message}`) ?'refused a redirect' : 'network error')).slice(0, 60)}.`);
    }
    if (Number(res.headers.get('content-length') || 0) > this.maxBytes) throw new ReaderError('es_too_large', 'Elasticsearch answered with more data than this panel will read; narrow the window.');
    const chunks = []; let bytes = 0;
    for await (const c of res.body ?? []) {
      bytes += c.length;
      if (bytes > this.maxBytes) throw new ReaderError('es_too_large', 'Elasticsearch answered with more data than this panel will read; narrow the window.');
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (res.status === 401 || res.status === 403) throw new ReaderError('es_unauthorized', `Elasticsearch refused the read credential (HTTP ${res.status}).`);
    if (!res.ok) throw new ReaderError('es_error', `Elasticsearch answered HTTP ${res.status}.`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new ReaderError('es_bad_response', 'Elasticsearch did not answer with JSON.'); }
    if (!Array.isArray(parsed?.hits?.hits)) throw new ReaderError('es_bad_response', 'Elasticsearch answered with something other than search hits.');
    const rows = [];
    for (const h of parsed.hits.hits) {
      const src = h && typeof h._source === 'object' && h._source ? h._source : null;
      const stamp = src?.['@timestamp'];
      if (!src || typeof stamp !== 'string') continue;
      const message = typeof src.message === 'string' ? src.message : JSON.stringify(scrubDoc(src));
      rows.push({ at: Date.parse(stamp), atExact: stamp, message, level: typeof src.level === 'string' ? src.level : undefined, requestId: typeof src.request_id === 'string' ? src.request_id : undefined, host: typeof src.host === 'string' ? src.host : undefined });
    }
    const out = finish(rows, { product, from, to, match });
    for (const l of out.lines) { const r = rows.find((x) => x.at === l.at && x.message === l.message); if (r?.level) l.level = r.level; if (r?.requestId) l.requestId = r.requestId; if (r?.host) l.host = r.host; }
    out.truncated ||= parsed.hits.hits.length >= LIMITS.maxHits;
    return out;
  }
}

// product=container,product=container  ->  { product: container }
const pairs = (text) => Object.fromEntries(String(text || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2 && p[0].trim() && p[1].trim()).map(([k, v]) => [k.trim(), v.trim()]));

// The readers, in selection order, from the environment (owner decision 2026-11-22): Elasticsearch is the DEFAULT reader (the collector in
// shared/ping-log-collector is the only thing that holds the Docker socket and ships to it; a lab reads Elasticsearch with a read key).
// The Docker reader is opt-in: it needs RUN_OBS_DOCKER=1 AND RUN_OBS_CONTAINERS / RUN_OBS_LOG_FILES, because it means mounting the Docker
// socket into the lab (even read-only it exposes the whole Docker API), which breaks the loopback-only, non-root, read-only-fs rules.
// Use it for an ad-hoc run or a video capture only.
export function readersFromEnv(env = process.env) {
  const out = [];
  if (env.RUN_OBS_ES_URL && env.RUN_OBS_ES_READ_APIKEY) out.push(new ElasticsearchReader({ url: env.RUN_OBS_ES_URL, apiKey: env.RUN_OBS_ES_READ_APIKEY }));
  const containers = pairs(env.RUN_OBS_CONTAINERS); const files = pairs(env.RUN_OBS_LOG_FILES);
  if (env.RUN_OBS_DOCKER === '1' && (Object.keys(containers).length || Object.keys(files).length)) {
    out.push(new DockerLogReader({ socketPath: env.RUN_OBS_DOCKER_SOCKET || '/var/run/docker.sock', containers, files }));
  }
  return out;
}

// ---- Line matchers ---------------------------------------------------------------------------------------
// Table-driven: each entry maps one product's log line to { layer, outcome, message, detail }.
//   status 'measured'   the line shape was seen on a real run (sources: shared/ping-log-collector, observability-LAB docs and README,
//                       AI-DEMO2 privilege/GATEWAY-LOGGING-WITH-ELASTICSEARCH.md, all read-only)
//   status 'UNVERIFIED' nobody has measured this shape; the rows it makes carry basis 'unverified-shape'. DO NOT promote one without a capture.
// A matcher returns null for a line it does not recognise; unrecognised lines are dropped (never guessed). A matcher may return
// `unverified: true` for a row whose OUTCOME rests on an unmeasured value inside an otherwise measured line.
const ANSI = /\u001b\[[0-9;]*m/g;
const jsonOf = (text) => { const i = text.indexOf('{'); if (i < 0) return null; try { const v = JSON.parse(text.slice(i).replace(ANSI, '')); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const kv = (text) => Object.fromEntries(text.split('|').map((p) => p.trim()).filter((p) => p.includes('=')).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null));

export const layerMatchers = [
  {
    // MEASURED 2026-11-08 (observability-LAB audit-stdout): fields are positional after "tid:" — tid, tracking id, event, subject, ip, (blank),
    // client id, protocol, host id, component, status, (blank), description, response ms. Statuses seen: inprogress, failure. 'success' is UNVERIFIED.
    id: 'pf-audit', product: 'pingfederate', status: 'measured',
    match(l) {
      if (!/audit\.log/.test(l.message) && !/\|\s*tid:/.test(l.message)) return null;
      const f = l.message.split('|').map((p) => p.trim());
      const t = f.findIndex((p) => p.startsWith('tid:'));
      if (t < 0 || f.length < t + 11) return null;
      const [tid, tracking, event, subject, ip, , client, protocol, , component, status, , description] = f.slice(t);
      const st = status.toLowerCase();
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
    // PERMIT is measured; the wording for a denial is NOT: a non-PERMIT decision is UNVERIFIED.
    id: 'p1az-decision', product: 'pinggateway', status: 'measured',
    match(l) {
      const m = /\[P1AZ\] DECISION:\s*([A-Z_]+)(.*)$/m.exec(l.message);
      if (!m) return null;
      const f = kv(m[2]); const permit = m[1] === 'PERMIT';
      const hold = permit && f.obligation === 'hitl';
      return {
        layer: 'authorize', outcome: hold ? 'info' : permit ? 'allowed' : 'refused', unverified: !permit,
        message: `PingOne Authorize ${m[1]}${f.tool ? ` for tool ${f.tool}` : ''}${f.method ? ` (${f.method})` : ''}${hold ? ': permitted with a human-approval obligation, so the call is held' : ''}`,
        detail: nonEmpty({ decision: m[1], sub: f.sub, tool: f.tool, method: f.method, vertical: f.vertical, obligation: f.obligation, backend: f.backend }),
      };
    },
  },
  {
    // MEASURED 2026-11-08 (same container): "INDETERMINATE - HITL challenge <id> minted for tool=<name>".
    id: 'p1az-hitl', product: 'pinggateway', status: 'measured',
    match(l) {
      const m = /INDETERMINATE - HITL challenge (\S+) minted for tool=(\S*)/.exec(l.message);
      return m ? { layer: 'authorize', outcome: 'info', message: `A human approval was requested${m[2] ? ` for tool ${m[2]}` : ''} (challenge ${m[1]})`, detail: nonEmpty({ challenge: m[1], tool: m[2] }) } : null;
    },
  },
  {
    // MEASURED 2026-11-08 (observability-LAB access-audit): one JSON object per request: eventName, response.statusCode (a string), http.request.path.
    id: 'pinggateway-access', product: 'pinggateway', status: 'measured',
    match(l) {
      const j = jsonOf(l.message);
      if (!j || j.eventName !== 'OPENIG-HTTP-ACCESS') return null;
      const code = Number(j.response?.statusCode);
      const outcome = code === 401 || code === 403 ? 'refused' : code >= 200 && code < 400 ? 'allowed' : 'info';
      return {
        layer: 'gateway', outcome,
        message: `PingGateway answered ${j.response?.statusCode ?? '?'}${j.response?.status ? ` (${j.response.status})` : ''} to ${j.http?.request?.method ?? 'a request'} ${j.http?.request?.path ?? ''}`.trim(),
        detail: nonEmpty({ route: j.ig?.routeName, statusCode: j.response?.statusCode, status: j.response?.status, elapsedTime: j.response?.elapsedTime }),
      };
    },
  },
  {
    // MEASURED 2026-11-08 (observability-LAB, topic mcp): client.method (tools/list, tools/call) and client.param (the tool name) on an authenticated call.
    id: 'pinggateway-mcp', product: 'pinggateway', status: 'measured',
    match(l) {
      const j = jsonOf(l.message);
      if (!j || j.eventName !== 'PING-GATEWAY-MCP' || !j.client?.method) return null;
      return { layer: 'gateway', outcome: 'info', message: `MCP ${j.client.method}${j.client.param ? ` ${j.client.param}` : ''} passed through PingGateway`, detail: nonEmpty({ method: j.client.method, param: j.client.param, clientId: j.client.id }) };
    },
  },
  // ---- Privilege agent gateway: text lines (level=info msg="...") — MEASURED 2026-11-07/08 (observability-LAB, privilege-logging-test-plan 8a/8c) ----
  {
    id: 'pgw-token-found', product: 'privilege-gateway', status: 'measured',
    match(l) { const m = /Access token found for user: (\S+), client: (\S+?)"?$/m.exec(l.message); return m ? { layer: 'agent', outcome: 'info', message: `The gateway saw an access token for user ${m[1]}, agent client ${m[2]}`, detail: { user: m[1], client: m[2] } } : null; },
  },
  {
    id: 'pgw-policy-denied', product: 'privilege-gateway', status: 'measured',
    match(l) {
      const m = /\[mcpgw\] policy denied (\S+) access to (\w+) app (\S+) \(agent=(\w+)\)/.exec(l.message);
      return m ? { layer: 'gateway', outcome: 'refused', message: `The gateway refused ${m[1]} access to ${m[2]} app ${m[3]} (policy denied)`, detail: { user: m[1], kind: m[2], app: m[3], agent: m[4] } } : null;
    },
  },
  {
    id: 'pgw-proxying', product: 'privilege-gateway', status: 'measured',
    match(l) { const m = /Proxying to: (\S+?)"?$/m.exec(l.message); return m ? { layer: 'gateway', outcome: 'allowed', message: `The gateway forwarded the call to ${m[1]} (it logs no allow line; forwarding is the evidence)`, detail: { backend: m[1] } } : null; },
  },
  {
    id: 'pgw-mcp-call', product: 'privilege-gateway', status: 'measured',
    match(l) { const m = /MCP call detected for method (\S+) with target: (\S+?)"?$/m.exec(l.message); return m ? { layer: 'gateway', outcome: 'info', message: `MCP ${m[1]} call to ${m[2]} detected`, detail: { method: m[1], target: m[2] } } : null; },
  },
  {
    // The pair "authorization header missing" + "Invalid Authorization token" is written by ONE request (measured), so each is its own refusal row.
    id: 'pgw-auth-rejected', product: 'privilege-gateway', status: 'measured',
    match(l) {
      const m = /msg="(authorization header missing|Invalid Authorization token)"/.exec(l.message);
      return m ? { layer: 'gateway', outcome: 'refused', message: `The gateway refused a request: ${m[1]}`, detail: { reason: m[1] } } : null;
    },
  },
  {
    id: 'pgw-aiguard-blocked', product: 'privilege-gateway', status: 'measured',
    match(l) { const m = /aiguard: blocked mcp response client=(\S+) category=(\S+?)"?$/m.exec(l.message); return m ? { layer: 'privilege', outcome: 'blocked', message: `AI Guard blocked an MCP response (${m[2]}) for client ${m[1]}`, detail: { client: m[1], category: m[2] } } : null; },
  },
  // ---- Privilege gateway JSON documents (log-tailer / SIEM): field names MEASURED 2026-11-08, values are examples ----
  {
    id: 'pgw-json-denied', product: 'privilege-gateway', status: 'measured',
    match(l) {
      const j = jsonOf(l.message);
      if (!j || !/^(MCP|A2A) policy denied$/.test(j.msg || '')) return null;
      return { layer: 'privilege', outcome: 'refused', message: `${j.msg}${j.App ? ` for app ${j.App}` : ''}${j.Reason ? `: ${j.Reason}` : ''}`, detail: nonEmpty({ app: j.App, agent: j.Agent, principal: j.Principal, decision: j.Decision, reason: j.Reason }) };
    },
  },
  {
    // The verdict is recorded; whether the call was then blocked is NOT in this document, so the row is `info`, never `blocked`.
    id: 'pgw-json-aiguard', product: 'privilege-gateway', status: 'measured',
    match(l) {
      const j = jsonOf(l.message);
      if (!j || j.msg !== 'AIGuard') return null;
      return { layer: 'privilege', outcome: 'info', message: `AI Guard verdict recorded: ${j.Category || 'category not given'}${j.TopScore !== undefined ? ` (score ${j.TopScore})` : ''}; the document does not say whether the call was blocked`, detail: nonEmpty({ category: j.Category, client: j.Client, topScore: j.TopScore, level: j.level }) };
    },
  },
  // ---- Privilege SIEM index ping-siem-events-v2 (privilege_event_kind runtime) ----
  {
    // MEASURED shape (relayed 2026-11-08, never read by observability-LAB itself): Index 'policy-decision-log', Data.Decision allow | deny | hitl.
    id: 'siem-policy-decision', product: 'privilege-siem', status: 'measured',
    match(l) {
      const j = jsonOf(l.message);
      if (!j || j.Index !== 'policy-decision-log') return null;
      const d = String(j.Data?.Decision ?? j.Decision ?? '').toLowerCase();
      const outcome = d === 'allow' ? 'allowed' : d === 'deny' ? 'refused' : 'info';
      return { layer: 'privilege', outcome, message: `Privilege policy decision: ${d || 'not given'}`, detail: nonEmpty({ decision: d, index: j.Index, level: j.Level }) };
    },
  },
  {
    id: 'siem-aiguard', product: 'privilege-siem', status: 'measured',
    match(l) { const j = jsonOf(l.message); return j && j.Index === 'aiguard-log' ? { layer: 'privilege', outcome: 'info', message: 'AI Guard verdict recorded in the SIEM; the document does not say whether the call was blocked', detail: nonEmpty({ index: j.Index, level: j.Level }) } : null; },
  },
  {
    // UNVERIFIED: the agent-approval-log shape has never been seen.
    id: 'siem-approval', product: 'privilege-siem', status: 'UNVERIFIED',
    match(l) { const j = jsonOf(l.message); return j && j.Index === 'agent-approval-log' ? { layer: 'privilege', outcome: 'info', message: 'An agent approval event was recorded', detail: nonEmpty({ index: j.Index, level: j.Level }) } : null; },
  },
  // ---- Prompt-Guard sidecar — MEASURED 2026-11-08 ----
  {
    id: 'promptguard-allow', product: 'promptguard', status: 'measured',
    match(l) { return /promptguard: \d+ unit\(s\) -> allow/.test(l.message) ? { layer: 'privilege', outcome: 'allowed', message: 'Prompt-Guard judged the text safe', detail: {} } : null; },
  },
  {
    // The gateway wrote no block line beside a flag (measured), so a flag is information, not a refusal.
    id: 'promptguard-flagged', product: 'promptguard', status: 'measured',
    match(l) { const m = /Prompt-Guard flagged (\w+) \(([\d.]+)\)/.exec(l.message); return m ? { layer: 'privilege', outcome: 'info', message: `Prompt-Guard flagged ${m[1]} (${m[2]}); the log does not say whether the call was blocked`, detail: { category: m[1], score: m[2] } } : null; },
  },
  // ---- Resource server (the banking MCP server) ----
  {
    // MEASURED 2026-11-08 (observability-LAB record-header): "[<time>] INFO: token audience validated" — token-validation steps, claim values, never the token.
    id: 'mcp-server-validation', product: 'mcp-server', status: 'measured',
    match(l) { const m = /^\[[^\]]*\]\s+(INFO|WARN|WARNING|ERROR):\s+(.*)$/m.exec(l.message); return m && /token|audience|introspect|scope/i.test(m[2]) && !/(denied|refused|forbidden|unauthori[sz]ed|insufficient)/i.test(m[2]) ? { layer: 'resource', outcome: 'info', message: `MCP server: ${m[2].split('\n')[0]}`, detail: { level: m[1] } } : null; },
  },
  {
    // UNVERIFIED: the wording of a refused tool call on the MCP server has never been captured.
    id: 'mcp-server-refused', product: 'mcp-server', status: 'UNVERIFIED',
    match(l) { const m = /^\[[^\]]*\]\s+(?:INFO|WARN|WARNING|ERROR):\s+(.*(?:denied|refused|forbidden|unauthori[sz]ed|insufficient).*)$/im.exec(l.message); return m ? { layer: 'resource', outcome: 'refused', message: `MCP server: ${m[1].split('\n')[0]}`, detail: {} } : null; },
  },
  {
    // UNVERIFIED: the wording of a served tool call on the MCP server has never been captured.
    id: 'mcp-server-served', product: 'mcp-server', status: 'UNVERIFIED',
    match(l) { const m = /^\[[^\]]*\]\s+(?:INFO|WARN|WARNING|ERROR):\s+(.*tool.*(?:called|executed|served|completed).*)$/im.exec(l.message); return m ? { layer: 'resource', outcome: 'allowed', message: `MCP server: ${m[1].split('\n')[0]}`, detail: {} } : null; },
  },
];

export function classify(line) {
  for (const m of layerMatchers) {
    if (m.product !== line.product) continue;
    const r = m.match(line);
    if (r) return { ...r, matcher: m.id, basis: m.status === 'UNVERIFIED' || r.unverified ? 'unverified-shape' : 'measured-shape' };
  }
  return null;
}

// ---- The collector ---------------------------------------------------------------------------------------
// A layer spec: { layer, products: [product ids to read], simulated: [{ at, product?, outcome, message, detail? }] (mock only),
// responses: [same shape] (real only: decisions the lab holds as an API response, origin 'response'), reason (why products is empty) }.
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
const toMs = (v, name) => { const ms = typeof v === 'number' ? v : Date.parse(v); if (!Number.isFinite(ms)) throw new RunObsError('bad_window', `${name} is not a time.`); return ms; };
const terms = (c = {}) => [c.sub, c.actClientId, c.traceId, ...(Array.isArray(c.requestIds) ? c.requestIds : [])].filter((t) => typeof t === 'string' && t.length >= 4).map((t) => t.toLowerCase());

const rowFrom = (e, layer, origin, cap, maskDeep) => {
  if (!OUTCOMES.includes(e?.outcome) || !Number.isFinite(Date.parse(e.at)) || !e.message) throw new RunObsError(`bad_${origin}_row`, `A ${origin} ${layer} row needs at, outcome (${OUTCOMES.join('/')}) and message.`);
  return { at: Date.parse(e.at), atExact: String(e.at), layer, product: cap(e.product || (origin === 'simulated' ? 'lab mock' : 'API response')), outcome: e.outcome, message: cap(e.message), origin, detail: e.detail === undefined ? undefined : maskDeep(e.detail) };
};

export function createRunObservability({ readers = [], masker = createMasker(), clock = () => Date.now() } = {}) {
  const { mask, maskDeep } = masker;
  const cap = (s) => { const t = mask(s); return t.length > LIMITS.maxMessage ? `${t.slice(0, LIMITS.maxMessage)}…` : t; };

  // In the order given (readersFromEnv: Elasticsearch first, Docker only when opted in): the first reader that can read this product and does not fail wins. Never silent: all reasons are kept.
  async function readProduct(product, from, to) {
    const reasons = [];
    for (const reader of readers) {
      if (!reader.canRead(product)) { reasons.push(`${reader.name}: no source configured for ${product}`); continue; }
      try { return { ...(await reader.readLines({ product, from, to, match: (l) => classify(l) !== null })), reader: reader.name, fellBack: reasons }; } catch (e) {
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
    const want = terms(correlation);
    const rows = []; const coverage = {}; const reasons = {};
    let truncated = false;

    if (source === 'mock') {
      for (const s of specs) {
        const sim = Array.isArray(s.simulated) ? s.simulated : [];
        if (Array.isArray(s.responses) && s.responses.length) throw new RunObsError('bad_response_row', 'A mock run has no API responses: the mock computed them, so they are simulated rows.');
        for (const e of sim) rows.push(rowFrom(e, s.layer, 'simulated', cap, maskDeep));
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
        for (const e of resp) rows.push(rowFrom(e, s.layer, 'response', cap, maskDeep));
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
          if (r.truncated) { truncated = true; why.push(`${p}: the answer was cut at the line cap`); }
          for (const line of r.lines) {
            const c = classify(line);
            if (!c || c.layer !== s.layer) continue;
            const hay = `${line.message} ${line.requestId || ''}`.toLowerCase();
            rows.push({
              at: line.at, atExact: line.atExact, layer: s.layer, product: p, outcome: c.outcome, message: cap(c.message), origin: 'logged', basis: c.basis,
              matchedBy: want.length && want.some((t) => hay.includes(t)) ? 'id' : 'window', matcher: c.matcher, detail: maskDeep(c.detail),
              ...(line.host ? { host: cap(line.host) } : {}),
            });
            got += 1;
          }
        }
        if (got) coverage[s.layer] = 'logged';
        else if (resp.length) coverage[s.layer] = 'response';
        else if (readOk) { coverage[s.layer] = 'not-logged'; reasons[s.layer] = 'No matching line was found for this run in the window. The product may not log this event.'; }
        else coverage[s.layer] = 'unreachable';
        if (why.length) reasons[s.layer] = (reasons[s.layer] ? `${reasons[s.layer]} ` : '') + cap(why.join(' | '));
      }
    }

    rows.sort((a, b) => a.at - b.at);
    const out = rows.slice(0, LIMITS.maxRows).map((r, i) => ({ id: `r${i + 1}`, ...r, at: iso(r.at) }));
    if (rows.length > LIMITS.maxRows) truncated = true;
    for (const s of specs) {
      if (coverage[s.layer] === 'not-logged') {
        out.push({ id: `n-${s.layer}`, at: null, layer: s.layer, product: (s.products || []).join(', ') || 'none', outcome: 'info', message: cap(reasons[s.layer]), origin: 'not-logged' });
      }
    }
    const summary = { allowed: 0, refused: 0, blocked: 0, info: 0 };
    for (const r of out) if (r.origin !== 'not-logged') summary[r.outcome] += 1;
    return {
      runId: cap(runId ?? ''), window: { from: iso(from), to: iso(to) }, source, excerpt: true, truncated, rows: out, coverage,
      reasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, cap(v)])), summary,
    };
  }

  return { collectRun };
}

// ---- The contract ----------------------------------------------------------------------------------------
// Returns a list of problems (empty = fine). Every lab test calls it on a mock and a real record; it is the honesty rule, written as code.
const LEAKS = [
  [/\bBearer\s+(?![*<])[A-Za-z0-9._~+/=-]{8,}/i, 'an unmasked Bearer credential'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}/, 'a JWT'],
  [/\bsk-(?!\*)[A-Za-z0-9_-]{8,}/, 'an sk- key'],
  [/\bBasic\s+(?![a-z]+\b)[A-Za-z0-9+/]{8,}/, 'a Basic credential'],
  [new RegExp(`\\b${SECRET_NAMES}\\b["']?\\s*[:=]\\s*["']?(?!\\*\\*\\*|<redacted>|["'])[^\\s"',}]{3,}`, 'i'), 'a secret-named field with a value'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'an IPv4 address'],
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
  const count = { allowed: 0, refused: 0, blocked: 0, info: 0 };
  const logged = {}; const simulated = {}; const responded = {};
  for (const [i, row] of r.rows.entries()) {
    const at = `row ${row?.id ?? i}`;
    if (!row || typeof row !== 'object') { bad.push(`${at} is not an object`); continue; }
    if (!LAYERS.includes(row.layer)) bad.push(`${at}: layer ${row.layer}`);
    if (!OUTCOMES.includes(row.outcome)) bad.push(`${at}: outcome ${row.outcome}`);
    if (!ORIGINS.includes(row.origin)) bad.push(`${at}: origin ${row.origin}`);
    if (!row.message) bad.push(`${at}: no message`);
    if (row.origin === 'logged') {
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a logged row needs the timestamp of its log line`);
      if (!BASES.includes(row.basis)) bad.push(`${at}: a logged row needs basis ${BASES.join(' or ')}`);
      if (r.source === 'mock') bad.push(`${at}: a mock record cannot hold a logged row; nothing was read from a log`);
      logged[row.layer] = true;
    }
    if (row.origin === 'simulated') {
      if (r.source === 'real') bad.push(`${at}: a real record cannot hold a simulated row`);
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a simulated row needs a time`);
      if (row.basis || row.matchedBy) bad.push(`${at}: a simulated row is presented as read from a log (basis or matchedBy set)`);
      simulated[row.layer] = true;
    }
    if (row.origin === 'response') {
      if (r.source === 'mock') bad.push(`${at}: a mock record cannot hold a response row; the mock computed it, so it is simulated`);
      if (!row.at || !Number.isFinite(Date.parse(row.at))) bad.push(`${at}: a response row needs the time the lab received it`);
      if (row.basis || row.matchedBy || row.matcher) bad.push(`${at}: a response row is presented as read from a log (basis, matchedBy or matcher set)`);
      responded[row.layer] = true;
    }
    if (row.origin === 'not-logged' && row.at) bad.push(`${at}: a not-logged row has no log line, so it has no timestamp`);
    if (row.passed === true && row.outcome === 'info') bad.push(`${at}: an info row is counted as passed`);
    if (row.origin !== 'not-logged' && count[row.outcome] !== undefined) count[row.outcome] += 1;
  }
  for (const [layer, state] of Object.entries(cov)) {
    if (!LAYERS.includes(layer)) bad.push(`coverage names an unknown layer ${layer}`);
    if (!COVERAGE.includes(state)) bad.push(`coverage ${layer}: ${state}`);
    if (state === 'logged' && !logged[layer]) bad.push(`coverage ${layer} says logged but no logged row exists`);
    if (state === 'simulated' && !simulated[layer]) bad.push(`coverage ${layer} says simulated but no simulated row exists`);
    if (state === 'logged' && r.source === 'mock') bad.push(`coverage ${layer}: a mock record cannot say logged`);
    if (state === 'simulated' && r.source === 'real') bad.push(`coverage ${layer}: a real record cannot say simulated`);
    if (state === 'response' && !responded[layer]) bad.push(`coverage ${layer} says response but no response row exists`);
    if (state === 'response' && r.source === 'mock') bad.push(`coverage ${layer}: a mock record cannot say response`);
    if ((state === 'unreachable' || state === 'not-logged') && !(r.reasons && r.reasons[layer])) bad.push(`coverage ${layer}: ${state} needs a reason`);
  }
  if (r.summary) {
    for (const k of Object.keys(count)) if (r.summary[k] !== count[k]) bad.push(`summary.${k} is ${r.summary[k]} but the rows say ${count[k]} (an info row must never be counted as allowed)`);
  }
  for (const s of strings(r)) for (const [re, what] of LEAKS) if (re.test(s)) { bad.push(`the record holds ${what}`); break; }
  return [...new Set(bad)];
}

// checkPin.mjs — the ONE pin check for a lab that vendors shared/run-observability. Vendor to scripts/run-observability-checkPin.mjs (byte-for-byte), then
// call it from the lab's pin test:
//     import { checkPin } from '../scripts/run-observability-checkPin.mjs';
//     assert.deepEqual(checkPin(labRoot), []);
// or run it: node scripts/run-observability-checkPin.mjs <labRoot>   (exit 1 and the problems on stderr).
// The pin file (web/src/run-observability/run-observability.sha256) lists each vendored file as "<sha256>  <path relative to the lab root>":
//   web/src/run-observability/{RunObservability.jsx,run-observability.css,run-observability.test.jsx,fixtures.js}
//   server/src/runObservability.js            (the core: required)
//   server/src/runObservabilityReaders.js     (optional: only labs that read logs)
// It verifies every pinned file that exists in the lab, fails on a mismatch, fails when the core is missing, and fails when a known vendored file
// exists in the lab but is not in the pin file. Dependency-free (node:fs, node:path, node:crypto only).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PIN_FILE = 'web/src/run-observability/run-observability.sha256';
export const CORE = 'server/src/runObservability.js';
export const VENDORED = [
  'web/src/run-observability/RunObservability.jsx', 'web/src/run-observability/run-observability.css',
  'web/src/run-observability/run-observability.test.jsx', 'web/src/run-observability/fixtures.js',
  CORE, 'server/src/runObservabilityReaders.js',
];

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function checkPin(labRoot, { pinFile = PIN_FILE } = {}) {
  const problems = [];
  const root = path.resolve(labRoot);
  let text;
  try { text = fs.readFileSync(path.join(root, pinFile), 'utf8'); } catch { return [`${pinFile}: the pin file is missing`]; }
  const pinned = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [hash, rel, ...rest] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{64}$/.test(hash || '') || !rel || rest.length || path.isAbsolute(rel) || rel.split('/').includes('..')) { problems.push(`${pinFile}: cannot read the line "${line.slice(0, 80)}"`); continue; }
    pinned.set(rel, hash);
  }
  if (!pinned.has(CORE)) problems.push(`${CORE} is not in the pin file`);
  if (!fs.existsSync(path.join(root, CORE))) problems.push(`${CORE}: the core file is missing from the lab`);
  for (const [rel, hash] of pinned) {
    const file = path.join(root, rel);
    if (!file.startsWith(`${root}${path.sep}`)) { problems.push(`${rel}: outside the lab`); continue; }
    if (!fs.existsSync(file)) continue; // a lab without a log reader does not vendor the readers file
    if (sha(file) !== hash) problems.push(`${rel}: modified (re-vendor it byte-for-byte from shared/run-observability)`);
  }
  for (const rel of VENDORED) if (!pinned.has(rel) && fs.existsSync(path.join(root, rel))) problems.push(`${rel}: exists in the lab but is not in the pin file`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && process.argv[2]) {
  const problems = checkPin(process.argv[2]);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('run-observability pin ok');
}

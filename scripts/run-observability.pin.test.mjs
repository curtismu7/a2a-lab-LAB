// Rule 27: the vendored shared/run-observability files match web/src/run-observability/run-observability.sha256 byte for byte.
// They come from curtismu7/AI-DEMO-Standalone shared/run-observability: change them there, re-pin, re-vendor; never edit them here.
// This lab reads no logs, so it vendors the core only (no server/src/runObservabilityReaders.js); checkPin skips that pin line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPin } from './run-observability-checkPin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every vendored run-observability file matches its pin, and the core is present', () => {
  assert.deepEqual(checkPin(root), []);
});

test('this lab reads no logs: no readers file, so nothing here needs fetch, node:http or node:fs for observability', () => {
  assert.ok(!fs.existsSync(path.join(root, 'server/src/runObservabilityReaders.js')));
  assert.ok(!/^\s*import\s/m.test(fs.readFileSync(path.join(root, 'server/src/runObservability.js'), 'utf8')), 'the core has no imports');
});

test('compose never mounts the Docker socket and passes no run-observability settings (nothing reads them: Real is reserved)', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.ok(!/docker\.sock/.test(compose), 'no Docker socket mount');
  assert.ok(!/RUN_OBS_/.test(compose), 'no reader settings in the container');
  assert.ok(!/RUN_OBS_/.test(fs.readFileSync(path.join(root, '.env.example'), 'utf8')));
});

// Rule 27: the vendored shared/run-observability files match web/src/run-observability/run-observability.sha256 byte for byte.
// They come from curtismu7/AI-DEMO-Standalone shared/run-observability: change them there, re-pin, re-vendor; never edit them here.
// The pin lists the server file as plain `runObservability.js`; it is vendored at server/src/runObservability.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(root, 'web/src/run-observability');
const WHERE = { 'runObservability.js': path.join(root, 'server/src/runObservability.js') };
const EXPECTED = ['RunObservability.jsx', 'fixtures.js', 'run-observability.css', 'run-observability.test.jsx', 'runObservability.js'];

const pins = () => fs.readFileSync(path.join(WEB, 'run-observability.sha256'), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#')).map((l) => { const [hash, name] = l.trim().split(/\s+/); return { hash, name }; });

test('the pin lists every vendored run-observability file', () => {
  assert.deepEqual(pins().map((p) => p.name).sort(), EXPECTED);
});

test('every vendored run-observability file matches its pin', () => {
  for (const { hash, name } of pins()) {
    const file = WHERE[name] || path.join(WEB, name);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, `${name} was edited: change it in the canonical, re-pin, re-vendor`);
  }
});

test('compose never mounts the Docker socket and passes no run-observability settings (nothing reads them: Real is reserved)', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.ok(!/docker\.sock/.test(compose), 'no Docker socket mount');
  assert.ok(!/RUN_OBS_/.test(compose), 'no reader settings in the container');
  assert.ok(!/RUN_OBS_/.test(fs.readFileSync(path.join(root, '.env.example'), 'utf8')));
});

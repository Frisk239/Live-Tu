import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { probeStorageReadiness } from '../lib/storage-readiness';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-storage-ready-'));

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('readiness requires both data and uploads directories to be writable', () => {
  const dataDir = path.join(root, 'data');
  const uploadsDir = path.join(root, 'uploads');
  const ready = probeStorageReadiness(dataDir, uploadsDir, 1);
  assert.equal(ready.ready, true);
  assert.equal(ready.data.ready, true);
  assert.equal(ready.uploads.ready, true);

  const invalidUploads = path.join(root, 'uploads-is-a-file');
  fs.writeFileSync(invalidUploads, 'not a directory');
  const failed = probeStorageReadiness(dataDir, invalidUploads, 1);
  assert.equal(failed.ready, false);
  assert.equal(failed.data.ready, true);
  assert.equal(failed.uploads.ready, false);
  assert.match(failed.uploads.error || '', /directory|EEXIST|ENOTDIR/i);
});

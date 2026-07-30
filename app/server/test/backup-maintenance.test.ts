import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import express from 'express';
import { backupMaintenanceGuard } from '../lib/backup-maintenance';

const execFileAsync = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-backup-lock-'));
const dataDir = path.join(root, 'data');
const uploadsDir = path.join(root, 'uploads');
const backupDir = path.join(root, 'backup');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('write guard rejects maintenance mode while allowing reads', async () => {
  const app = express();
  app.use(backupMaintenanceGuard({ dataDir }));
  app.get('/resource', (_req, res) => res.json({ success: true }));
  app.post('/resource', (_req, res) => res.json({ success: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const lockPath = path.join(dataDir, '.backup.lock');
  fs.writeFileSync(lockPath, 'test lock', { flag: 'wx' });
  try {
    assert.equal((await fetch(`${baseUrl}/resource`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/resource`, { method: 'POST' })).status, 503);
  } finally {
    fs.unlinkSync(lockPath);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test('backup holds maintenance lock and waits for active mutation leases', async () => {
  const databasePath = path.join(dataDir, 'pipeline.db');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY, value TEXT)');
  database.exec("INSERT INTO evidence (value) VALUES ('before-backup')");
  database.close();
  fs.writeFileSync(path.join(uploadsDir, 'evidence.txt'), 'upload evidence');

  const leasesDir = path.join(dataDir, '.mutation-leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  const leasePath = path.join(leasesDir, 'active-request.lease');
  fs.writeFileSync(leasePath, 'active');

  let finished = false;
  const backup = execFileAsync(process.execPath, ['scripts/backup.mjs', backupDir], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      UPLOADS_DIR: uploadsDir,
      BACKUP_DRAIN_TIMEOUT_MS: '5000',
    },
  }).finally(() => {
    finished = true;
  });

  const lockPath = path.join(dataDir, '.backup.lock');
  for (let attempt = 0; attempt < 50 && !fs.existsSync(lockPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(lockPath), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(finished, false);

  fs.unlinkSync(leasePath);
  await backup;
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(path.join(backupDir, 'pipeline.db')), true);
  assert.equal(fs.existsSync(path.join(backupDir, 'uploads', 'evidence.txt')), true);
});

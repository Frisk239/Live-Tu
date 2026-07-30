import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-permissions-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
delete process.env.METRICS_TOKEN;

const databaseModule = await import('../lib/db.ts');
databaseModule.initDatabase();
const { db } = databaseModule;
const {
  authRouter,
  getUserPermissions,
  requireAuth,
  requirePermission,
} = await import('../lib/auth.ts');
const { bgmRouter } = await import('../routes/bgm.ts');
const { modelsRouter } = await import('../routes/models.ts');
const { productsRouter } = await import('../routes/products.ts');
const { metricsRouter } = await import('../lib/observability.ts');

function passwordHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

const password = 'permission-test-password';
db.prepare(
  `INSERT INTO users (id, username, password_hash, role)
   VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
).run(
  'operator-id',
  'haini',
  passwordHash(password),
  'operator',
  'admin-id',
  'admin',
  passwordHash(password),
  'admin'
);

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/bgm', requireAuth, bgmRouter);
app.use('/models', requireAuth, modelsRouter);
app.use('/knowledge', requireAuth, productsRouter);
app.use('/metrics', metricsRouter);
app.get(
  '/permission-probe',
  requireAuth,
  requirePermission('module.knowledge.read'),
  (_req, res) => res.json({ success: true })
);

const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function login(username: string) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(body));
  const cookie = response.headers.getSetCookie()[0]?.split(';', 1)[0];
  assert.ok(cookie);
  return { body, cookie };
}

test('database permissions grant operator only ordinary workflow modules', () => {
  assert.deepEqual(getUserPermissions('operator-id'), [
    'module.materials.read',
    'module.materials.write',
    'module.pipeline.read',
    'module.pipeline.write',
    'module.presets.read',
    'module.tasks.read',
    'module.tasks.write',
  ]);
  assert.equal(getUserPermissions('admin-id').length, 17);
});

test('login and me expose database-derived permissions', async () => {
  const { body, cookie } = await login('haini');
  assert.equal(body.user.role, 'operator');
  assert.deepEqual(body.user.permissions, getUserPermissions('operator-id'));

  const me = await fetch(`${baseUrl}/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json() as any).user.permissions, body.user.permissions);
});

test('operator receives 403 for protected administration modules', async () => {
  const { cookie } = await login('haini');
  const responses = await Promise.all([
    fetch(`${baseUrl}/bgm`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/models/config`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/knowledge`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/auth/users`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/auth/audit-logs`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/metrics`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/permission-probe`, { headers: { Cookie: cookie } }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [403, 403, 403, 403, 403, 403, 403]);
});

test('admin database permissions allow all protected administration modules', async () => {
  const { body, cookie } = await login('admin');
  assert.equal(body.user.permissions.length, 17);
  const responses = await Promise.all([
    fetch(`${baseUrl}/bgm`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/models/config`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/knowledge`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/auth/users`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/auth/audit-logs`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/metrics`, { headers: { Cookie: cookie } }),
    fetch(`${baseUrl}/permission-probe`, { headers: { Cookie: cookie } }),
  ]);
  assert.ok(responses.every((response) => response.status !== 403));
});

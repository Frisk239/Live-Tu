import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-seedance-owner-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.SEEDANCE_BASE_URL = 'https://93.184.216.34';
process.env.SEEDANCE_ACCOUNT = 'test-account';
process.env.SEEDANCE_PASSWORD = 'test-password';

const databaseModule = await import('../lib/db.ts');
databaseModule.initDatabase();
const { db } = databaseModule;
const { seedanceRouter } = await import('../routes/seedance.ts');

db.prepare(
  `INSERT INTO users (id, username, password_hash, role)
   VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
).run(
  'owner-a',
  'owner-a',
  'unused',
  'operator',
  'owner-b',
  'owner-b',
  'unused',
  'operator'
);

const originalFetch = globalThis.fetch;
const localFetch = originalFetch;
let providerCalls = 0;
globalThis.fetch = async (input, init) => {
  providerCalls += 1;
  const url = String(input);
  if (url.endsWith('/api/v1/auth/token')) {
    return new Response(JSON.stringify({
      data: { accessToken: 'test-token', expiresIn: 7200 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (init?.method === 'POST') {
    return new Response(JSON.stringify({
      data: { id: 'created-provider-task', status: 'processing' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  const id = url.split('/').at(-1);
  return new Response(JSON.stringify({
    data: { id, status: 'processing' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.headers['x-test-internal'] === '1') {
    req.internalWorker = true;
    return next();
  }
  const userId = String(req.headers['x-test-user'] || 'owner-b');
  req.authUser = {
    id: userId,
    username: userId,
    role: 'operator',
    permissions: [],
  };
  next();
});
app.use('/seedance', seedanceRouter);

const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}/seedance`;

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('created task is readable by its owner but not another tenant', async () => {
  const create = await localFetch(`${baseUrl}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-a' },
    body: JSON.stringify({ prompt: 'owner A paid task' }),
  });
  assert.equal(create.status, 200);
  const taskId = (await create.json() as any).data.id;
  assert.equal(taskId, 'created-provider-task');

  const ownerPoll = await localFetch(`${baseUrl}/generations/${taskId}`, {
    headers: { 'x-test-user': 'owner-a' },
  });
  assert.equal(ownerPoll.status, 200);

  const callsBeforeForeignPoll = providerCalls;
  const foreignPoll = await localFetch(`${baseUrl}/generations/${taskId}`, {
    headers: { 'x-test-user': 'owner-b' },
  });
  assert.equal(foreignPoll.status, 404);
  assert.equal(providerCalls, callsBeforeForeignPoll);
});

test('durable internal worker can poll a mapped provider task without a session user', async () => {
  const response = await localFetch(`${baseUrl}/generations/created-provider-task`, {
    headers: { 'x-test-internal': '1' },
  });
  assert.equal(response.status, 200);
});

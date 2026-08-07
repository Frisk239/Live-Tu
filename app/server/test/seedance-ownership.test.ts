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

// P5 二轮收口：/generations 只接受受信提交（shotId + 受信资产 ID）。
// 为测试所有权隔离，预置 owner-a 的可信镜头与产品资产。
db.prepare(
  `INSERT INTO products (id, name, positioning, price, revision)
   VALUES ('owner-product', 'BUV', 'test', '49', 1)`
).run();
db.prepare(
  `INSERT INTO product_assets (id, product_id, role, url, owner_id, safety_status, safety_evidence, safety_version, sha256)
   VALUES ('owner-asset-1', 'owner-product', 'hero', 'https://assets.example.com/owner-a-pack.png', 'owner-a', 'pass', '{"face":false,"overlay":false,"watermark":false}', 'v2', ?)`
).run('c'.repeat(64));
db.prepare(
  `INSERT INTO conditioned_first_frames
     (id, owner_id, conditioned_first_frame_url, product_asset_urls_json, provider, model, prompt_version, prompt,
      safety_status, safety_evidence, safety_version, sha256)
   VALUES ('owner-cff-1', 'owner-a', 'https://assets.example.com/owner-a-derived.png', '[]', 'test', 'test', 'v2', 'x',
           'pass', '{"face":false,"overlay":false,"watermark":false}', 'v2', ?)`
).run('c'.repeat(64));
db.prepare(
  `INSERT INTO shot_generation_tasks (id, session_id, owner_id, shot_index, status, video_prompt, first_frame_url)
   VALUES ('owner-shot-1', 'owner-session-1', 'owner-a', 1, 'pending', 'prompt', 'https://assets.example.com/owner-a-derived.png')`
).run();

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
  // P5 二轮收口：/generations 不再接受任意 body，走受信提交（shotId + sessionId，
  // 素材来源由服务端按 owner+URL 核验——owner-a 的镜头/资产已在上面预置）
  const create = await localFetch(`${baseUrl}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-a' },
    body: JSON.stringify({ shotId: 'owner-shot-1', sessionId: 'owner-session-1' }),
  });
  assert.equal(create.status, 200);
  const taskId = (await create.json() as any).data.taskId;
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

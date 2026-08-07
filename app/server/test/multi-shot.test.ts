import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('persists multi-shot tasks before provider work and isolates sessions by owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-tu-multishot-test-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.UPLOADS_DIR = path.join(root, 'uploads');
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_MOCK_FALLBACK = 'true';
  delete process.env.YUNWU_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SEEDANCE_BASE_URL;
  delete process.env.SEEDANCE_ACCOUNT;
  delete process.env.SEEDANCE_PASSWORD;

  const databaseModule = await import('../lib/db.ts');
  databaseModule.initDatabase();
  const { db } = databaseModule;
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
  ).run(
    'owner-one',
    'owner-one',
    'unused',
    'operator',
    'owner-two',
    'owner-two',
    'unused',
    'operator',
    'admin-one',
    'admin-one',
    'unused',
    'admin'
  );

  const { pipelineRouter } = await import('../routes/pipeline.ts');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = String(req.headers['x-test-user'] || 'owner-one');
    req.authUser = {
      id: userId,
      username: userId,
      role: userId === 'admin-one' ? 'admin' : 'operator',
      permissions: [],
    };
    next();
  });
  app.use('/pipeline', pipelineRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/pipeline`;

  try {
    const createResponse = await fetch(`${baseUrl}/step2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-one' },
      body: JSON.stringify({
        productInfo: { name: 'Test Product' },
        shotList: [
          {
            shotIndex: 1,
            shotType: 'close-up',
            cameraMovement: 'push-in',
            description: 'product detail',
          },
        ],
      }),
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 200, JSON.stringify(created));
    const sessionId = created.data.multiShotResult.sessionId as string;
    db.prepare(
      `INSERT INTO pipeline_runs (
         id, owner_id, status, current_step, input_json, idempotency_key
       ) VALUES (?, ?, 'running', 2, '{}', ?)`
    ).run('run-multi-test', 'owner-one', 'multi-shot-cost-ledger-test');

    const persisted = db.prepare(
      'SELECT owner_id, status FROM shot_generation_tasks WHERE session_id = ?'
    ).get(sessionId) as { owner_id: string; status: string };
    assert.equal(persisted.owner_id, 'owner-one');
    // S1.3：step2 只持久化 pending，Seedance 提交走独立端点 submit-shot
    assert.equal(persisted.status, 'pending');

    const ownerResponse = await fetch(`${baseUrl}/shot-tasks/${sessionId}`, {
      headers: { 'x-test-user': 'owner-one' },
    });
    assert.equal(ownerResponse.status, 200);

    const otherOwnerResponse = await fetch(`${baseUrl}/shot-tasks/${sessionId}`, {
      headers: { 'x-test-user': 'owner-two' },
    });
    assert.equal(otherOwnerResponse.status, 404);

    const adminResponse = await fetch(`${baseUrl}/shot-tasks/${sessionId}`, {
      headers: { 'x-test-user': 'admin-one' },
    });
    assert.equal(adminResponse.status, 200);

    // submit-shot：未配置 Seedance 时应返回 503（可读错误），且不会崩溃
    const submitShot = await fetch(`${baseUrl}/step2/submit-shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-one' },
      body: JSON.stringify({ sessionId, shotIndex: 1, _runId: 'run-multi-test', _retryCount: 1 }),
    });
    const submitBody = await submitShot.json();
    assert.equal(submitShot.status, 503, JSON.stringify(submitBody));
    const { queryCostLedger } = await import('../lib/telemetry.ts');
    const failedSubmissionCosts = queryCostLedger({
      ownerId: 'owner-one',
      runId: 'run-multi-test',
      scope: 'shot',
    });
    assert.equal(failedSubmissionCosts.length, 1, '正式 submit-shot 失败必须写入 shot 成本账本');
    assert.equal(failedSubmissionCosts[0].failureReason, 'provider_error');
    assert.equal(failedSubmissionCosts[0].retries, 1);

    // 参数缺失应 400
    const missingParams = await fetch(`${baseUrl}/step2/submit-shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-one' },
      body: JSON.stringify({ sessionId }),
    });
    assert.equal(missingParams.status, 400);

    // 越权提交（其他 owner 的镜头）应 404
    const forbiddenSubmit = await fetch(`${baseUrl}/step2/submit-shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-two' },
      body: JSON.stringify({ sessionId, shotIndex: 1 }),
    });
    assert.equal(forbiddenSubmit.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

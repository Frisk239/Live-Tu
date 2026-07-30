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

    const persisted = db.prepare(
      'SELECT owner_id, status FROM shot_generation_tasks WHERE session_id = ?'
    ).get(sessionId) as { owner_id: string; status: string };
    assert.equal(persisted.owner_id, 'owner-one');
    assert.equal(persisted.status, 'completed');

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
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

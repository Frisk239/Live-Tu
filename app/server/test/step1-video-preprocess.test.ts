import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

test('S1.5 step1 视频关键帧全空时显式失败（422 可读错误，不静默劣质拆解）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-tu-step1-video-'));
  const uploadsDir = path.join(root, 'uploads');
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.NODE_ENV = 'test';

  // 伪造一个损坏的「视频」文件：真实 ffmpeg 无法从中提帧 → 关键帧全空
  const brokenDir = path.join(uploadsDir, 'materials');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(path.join(brokenDir, 'broken.mp4'), 'this is not a real video file');

  const { initDatabase } = await import('../lib/db');
  const { db } = await import('../lib/db');
  initDatabase();
  // 登记媒体归属：/uploads 路径需要 materials 记录 + owner 才能通过访问检查
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, 'operator')`
  ).run('test-owner', 'test-owner', 'unused');
  db.prepare(
    `INSERT INTO materials (id, name, file_path, url, media_type, owner_id)
     VALUES (?, ?, ?, ?, 'video', ?)`
  ).run('broken-video', 'broken.mp4', 'uploads/materials/broken.mp4', '/uploads/materials/broken.mp4', 'test-owner');

  const { pipelineRouter } = await import('../routes/pipeline');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUser = { id: 'test-owner', username: 'test-owner', role: 'operator', permissions: [] };
    next();
  });
  app.use('/api/pipeline', pipelineRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/api/pipeline`;

  try {
    const res = await fetch(`${baseUrl}/step1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          mediaUrl: '/uploads/materials/broken.mp4',
          productId: 'prod_buv_cleanser',
        },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.match(body.error || '', /关键帧提取失败/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

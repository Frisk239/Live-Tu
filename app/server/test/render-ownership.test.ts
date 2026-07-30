import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-render-ownership-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.ALLOW_MOCK_FALLBACK = 'false';

const databaseModule = await import('../lib/db.ts');
databaseModule.initDatabase();
const { db } = databaseModule;
const { renderRouter } = await import('../routes/render.ts');
const { pipelineRouter } = await import('../routes/pipeline.ts');

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

const privateUrl = '/uploads/materials/owner-a-private.mp4';
const privatePath = path.join(process.env.UPLOADS_DIR, 'materials', 'owner-a-private.mp4');
fs.mkdirSync(path.dirname(privatePath), { recursive: true });
fs.writeFileSync(privatePath, Buffer.alloc(128, 1));
db.prepare(
  `INSERT INTO materials
     (id, name, file_path, url, media_type, size, size_bytes, owner_id)
   VALUES (?, ?, ?, ?, 'video', '128 B', 128, ?)`
).run('private-video', 'private video', 'uploads/materials/owner-a-private.mp4', privateUrl, 'owner-a');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const userId = String(req.headers['x-test-user'] || 'owner-b');
  req.authUser = { id: userId, username: userId, role: 'operator', permissions: [] };
  next();
});
app.use('/render', renderRouter);
app.use('/pipeline', pipelineRouter);

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

test('render endpoint refuses another tenant local upload', async () => {
  const response = await fetch(`${baseUrl}/render/ffmpeg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-b' },
    body: JSON.stringify({ videoSourceUrl: privateUrl }),
  });
  assert.equal(response.status, 403);
});

test('pipeline step5 refuses another tenant local upload', async () => {
  const response = await fetch(`${baseUrl}/pipeline/step5`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-b' },
    body: JSON.stringify({
      videoSourceUrl: privateUrl,
      productInfo: { name: 'Tenant B product' },
    }),
  });
  assert.equal(response.status, 403);
});

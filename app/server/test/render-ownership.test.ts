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
const { registerOwnedMedia } = await import('../lib/media-ownership.ts');

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

test('concat accepts an owned generated render instead of requiring a materials row', async () => {
  const sessionId = `owned-render-concat-${Date.now()}`;
  const shotId = `owned-render-shot-${Date.now()}`;
  const generatedUrl = '/uploads/renders/owner-a-generated-only.mp4';
  const generatedPath = path.join(process.env.UPLOADS_DIR!, 'renders', 'owner-a-generated-only.mp4');
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  // The file is deliberately not a playable MP4: after ownership passes, the
  // renderer should fail with 500 rather than rejecting it as another user's
  // media. This isolates the authorization branch without a FFmpeg fixture.
  fs.writeFileSync(generatedPath, Buffer.alloc(128, 1));
  registerOwnedMedia(generatedUrl, 'owner-a', 'seedance-cache');

  db.prepare(
    `INSERT INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_url, qa_status, current_version)
     VALUES (?, ?, 'owner-a', 1, 'completed', ?, 'pass', 1)`
  ).run(shotId, sessionId, generatedUrl);
  db.prepare(
    `INSERT INTO shot_qa_reports
       (id, shot_id, run_id, version, owner_id, report_json, tech_status, semantic_status, overall_verdict, manual_passed, checked_at)
     VALUES (?, ?, ?, 1, 'owner-a', '{}', 'verified', 'pass', 'pass', 0, ?)`
  ).run(`qa-${shotId}`, shotId, sessionId, Date.now());

  const response = await fetch(`${baseUrl}/pipeline/concat-shots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-a' },
    body: JSON.stringify({ sessionId, videoUrls: [generatedUrl] }),
  });

  assert.equal(response.status, 500, 'ownership passes; invalid fixture then fails in FFmpeg, not at 403');
});

test('quality concat rejects a malformed full-video plan before any render work', async () => {
  const response = await fetch(`${baseUrl}/pipeline/concat-shots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'owner-a' },
    body: JSON.stringify({
      sessionId: `malformed-plan-${Date.now()}`,
      fullVideoPlan: { version: 'v1', shots: [] },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'full_video_plan_invalid');
});

test('shot-task polling never performs hidden QA, retries, or concat rendering', async () => {
  const sessionId = `read-only-poll-${Date.now()}`;
  const shotId = `read-only-shot-${Date.now()}`;
  db.prepare(
    `INSERT INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_url, qa_status, concat_status, current_version)
     VALUES (?, ?, 'owner-a', 1, 'completed', '/uploads/renders/not-rendered.mp4', 'passed', 'pending', 1)`
  ).run(shotId, sessionId);

  const response = await fetch(`${baseUrl}/pipeline/shot-tasks/${sessionId}`, {
    headers: { 'x-test-user': 'owner-a' },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.concatStatus, 'pending');
  assert.equal(body.data.concatenatedVideoUrl, undefined);

  const row = db.prepare(
    'SELECT status, qa_status, concat_status, concatenated_video_url FROM shot_generation_tasks WHERE id = ?'
  ).get(shotId) as any;
  assert.equal(row.status, 'completed');
  assert.equal(row.qa_status, 'passed');
  assert.equal(row.concat_status, 'pending');
  assert.equal(row.concatenated_video_url, null);
});

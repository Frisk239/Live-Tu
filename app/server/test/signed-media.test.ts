import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-signed-media-'));
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.MEDIA_URL_SIGNING_SECRET = 'test-media-signing-secret-at-least-32-characters';
const mediaPath = path.join(process.env.UPLOADS_DIR, 'materials', 'fixture.txt');
fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
fs.writeFileSync(mediaPath, 'signed-media-ok');

const { createSignedMediaUrl, signedMediaRouter } = await import('../lib/signed-media');
const { resolvePublicMediaUrl } = await import('../routes/seedance');
const app = express();
app.use('/provider-media', signedMediaRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('test server did not bind');
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('serves only a correctly signed upload path', async () => {
  const signedUrl = createSignedMediaUrl('/uploads/materials/fixture.txt', baseUrl);
  const response = await fetch(signedUrl);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'signed-media-ok');

  const tampered = new URL(signedUrl);
  tampered.searchParams.set('path', '/uploads/materials/other.txt');
  assert.equal((await fetch(tampered)).status, 403);
});

test('S1.4 caches identical signed URLs within TTL and re-signs on ttl change', () => {
  const first = createSignedMediaUrl('/uploads/materials/fixture.txt', 'https://buv.example.com:3004');
  const second = createSignedMediaUrl('/uploads/materials/fixture.txt', 'https://buv.example.com:3004');
  assert.equal(first, second, 'TTL 内同素材应返回相同签名 URL（缓存命中）');

  const otherTtl = createSignedMediaUrl(
    '/uploads/materials/fixture.txt',
    'https://buv.example.com:3004',
    7200
  );
  const otherTtlAgain = createSignedMediaUrl(
    '/uploads/materials/fixture.txt',
    'https://buv.example.com:3004',
    7200
  );
  assert.equal(otherTtl, otherTtlAgain);
  assert.notEqual(otherTtl, first, '不同 TTL 应产生不同签名（缓存键含 TTL）');
});

test('refuses private base and converts public upload URLs into provider-safe signed URLs', () => {
  // Private base (e.g. localhost dev) must be refused — Seedance cannot download it
  const refused = resolvePublicMediaUrl('/uploads/materials/fixture.txt', baseUrl);
  assert.equal(refused.url, null);
  assert.match(refused.warning || '', /内网|公网|PUBLIC_BASE_URL/);

  // Public base produces a provider-safe signed URL
  const resolved = resolvePublicMediaUrl(
    '/uploads/materials/fixture.txt',
    'https://buv.example.com:3004'
  );
  assert.ok(resolved.url);
  const url = new URL(resolved.url!);
  assert.equal(url.pathname, '/provider-media');
  assert.equal(url.searchParams.get('path'), '/uploads/materials/fixture.txt');
  assert.ok(url.searchParams.get('signature'));
});

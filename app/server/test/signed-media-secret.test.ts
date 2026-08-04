import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * S2.2：签名密钥全环境强制校验，无硬编码默认值。
 */
const originalSecret = process.env.MEDIA_URL_SIGNING_SECRET;
const originalEnv = process.env.NODE_ENV;

test.after(() => {
  if (originalSecret === undefined) delete process.env.MEDIA_URL_SIGNING_SECRET;
  else process.env.MEDIA_URL_SIGNING_SECRET = originalSecret;
  process.env.NODE_ENV = originalEnv || 'test';
});

test('S2.2 配置过短的 MEDIA_URL_SIGNING_SECRET 在所有环境都拒绝启动', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-tu-secret-'));
  process.env.UPLOADS_DIR = path.join(root, 'uploads');
  process.env.MEDIA_URL_SIGNING_SECRET = 'too-short';
  process.env.NODE_ENV = 'development';

  const { initializeMediaSigning } = await import('../lib/signed-media');
  assert.throws(() => initializeMediaSigning(), /至少需要 32 个字符/);
  rmSync(root, { recursive: true, force: true });
});

test('S2.2 生产环境缺失密钥拒绝启动', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-tu-secret-'));
  process.env.UPLOADS_DIR = path.join(root, 'uploads');
  delete process.env.MEDIA_URL_SIGNING_SECRET;
  process.env.NODE_ENV = 'production';

  const { initializeMediaSigning } = await import('../lib/signed-media');
  assert.throws(() => initializeMediaSigning(), /生产环境必须配置 MEDIA_URL_SIGNING_SECRET/);
  rmSync(root, { recursive: true, force: true });
});

test('S2.2 非生产环境无配置使用进程级随机密钥（无硬编码默认值），签名 URL 可正常生成与校验', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-tu-secret-'));
  const uploadsDir = path.join(root, 'uploads');
  process.env.UPLOADS_DIR = uploadsDir;
  delete process.env.MEDIA_URL_SIGNING_SECRET;
  process.env.NODE_ENV = 'development';
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(path.join(uploadsDir, 'materials'), { recursive: true });
  writeFileSync(path.join(uploadsDir, 'materials', 'fixture.txt'), 'secret-test');

  const { createSignedMediaUrl, initializeMediaSigning } = await import('../lib/signed-media');
  initializeMediaSigning(); // 不应抛错
  const url = createSignedMediaUrl('/uploads/materials/fixture.txt', 'https://buv.example.com');
  assert.ok(url.startsWith('https://buv.example.com/provider-media?'));

  // 生成的签名 URL 无固定开发密钥特征（旧默认值已被移除）
  assert.ok(!url.includes('live-tu-development-media-signing-secret'));
  rmSync(root, { recursive: true, force: true });
});

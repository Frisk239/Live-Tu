import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-render-storage-'));
process.env.UPLOADS_DIR = path.join(tempRoot, 'mounted-uploads');
const fixturePath = path.join(process.env.UPLOADS_DIR, 'renders', 'fixture.mp4');
fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
fs.writeFileSync(fixturePath, Buffer.alloc(64, 1));

const { cacheRemoteMedia, createSafeRenderFilename, resolveMediaPath, runFfmpegRender } = await import(
  '../routes/render'
);

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('maps /uploads URLs into the configured persistent upload directory', () => {
  assert.equal(resolveMediaPath('/uploads/renders/fixture.mp4'), fixturePath);
  assert.equal(resolveMediaPath('uploads/renders/fixture.mp4'), fixturePath);
});

test('blocks upload path traversal', () => {
  assert.equal(resolveMediaPath('/uploads/../../private.txt'), '');
});

test('generates unique shell-safe render filenames', () => {
  const first = createSafeRenderFilename('../../same"; touch owned;.mp4');
  const second = createSafeRenderFilename('../../same"; touch owned;.mp4');
  assert.match(first, /^[a-zA-Z0-9_.-]+\.mp4$/);
  assert.ok(!first.includes('..'));
  assert.ok(!first.includes('"'));
  assert.notEqual(first, second);
});

test('rejects private remote video sources before invoking FFmpeg', async () => {
  const result = await runFfmpegRender({
    videoSourceUrl: 'https://127.0.0.1/private.mp4',
  });
  assert.equal(result.success, false);
  assert.match(result.error || '', /视频源准备失败|内网/);
});

test('deduplicates remote media downloads within an ownership scope', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(Buffer.alloc(64, 7), {
      status: 200,
      headers: {
        'content-type': 'video/mp4',
        'content-length': '64',
      },
    });
  };
  try {
    const url = 'https://93.184.216.34/provider-output.mp4';
    const [first, concurrent] = await Promise.all([
      cacheRemoteMedia(url, 'video', 'owner-a'),
      cacheRemoteMedia(url, 'video', 'owner-a'),
    ]);
    const reused = await cacheRemoteMedia(url, 'video', 'owner-a');
    assert.equal(first, concurrent);
    assert.equal(first, reused);
    assert.equal(fs.statSync(first).size, 64);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streams only bounded image MIME responses for generated-image caching', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(Buffer.alloc(64, 7), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': '64',
      },
    });
  try {
    const cached = await cacheRemoteMedia(
      'https://93.184.216.34/generated-image.png',
      'image',
      'owner-image'
    );
    assert.match(cached, /\.png$/);
    assert.equal(fs.statSync(cached).size, 64);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects generated-image downloads with unsafe MIME or excessive size', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response('<html>not an image</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    await assert.rejects(
      () => cacheRemoteMedia(
        'https://93.184.216.34/not-image',
        'image',
        'owner-image'
      ),
      /类型|图片|image/i
    );

    globalThis.fetch = async () =>
      new Response(Buffer.alloc(64), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(21 * 1024 * 1024),
        },
      });
    await assert.rejects(
      () => cacheRemoteMedia(
        'https://93.184.216.34/too-large.jpg',
        'image',
        'owner-image'
      ),
      /大小|limit/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

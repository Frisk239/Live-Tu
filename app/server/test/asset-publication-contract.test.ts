import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssetPublicationAdapter } from '../adapters/asset-publication-adapter';
import { AssetPublicationError } from '../ports/asset-publication';
import { loadAssetPublicationConfig } from '../config/env-config';

/** 建一个临时本地资产文件（测试用，不依赖真实网络） */
function makeLocalAsset(): { localPath: string; dir: string; bytes: number } {
  const dir = mkdtempSync(path.join(tmpdir(), 'p5-asset-publication-'));
  const localPath = path.join(dir, 'kf.jpg');
  const buffer = Buffer.from('fake-jpeg-bytes-0123456789');
  writeFileSync(localPath, buffer);
  return { localPath, dir, bytes: buffer.length };
}

/** 记录最后一次 fetch 调用（mock fetch 用） */
let captured: { url: string; init: RequestInit | undefined } | null = null;

function stubFetch(responseFactory: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  (globalThis as any).__p5OriginalFetch = (globalThis as any).__p5OriginalFetch ?? globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    captured = { url: String(url), init };
    return responseFactory(String(url), init);
  };
}

function restoreFetch(): void {
  const original = (globalThis as any).__p5OriginalFetch;
  if (original) (globalThis as any).fetch = original;
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function textResponse(body: string, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => body,
    json: async () => null,
  } as unknown as Response;
}

test('契约：发布记录包含 URL/contentType/hash/过期/来源/run-session 归属', async () => {
  const { localPath, dir, bytes } = makeLocalAsset();
  try {
    const adapter = new AssetPublicationAdapter({
      PUBLIC_BASE_URL: 'https://demo.example.com',
      UPLOADS_DIR: path.dirname(localPath),
    });
    const record = await adapter.publish({ localPath, runId: 'run-1', sessionId: 'sess-1' });
    assert.ok(record.publicUrl.startsWith('https://demo.example.com/provider-media?'), record.publicUrl);
    assert.match(record.publicUrl, /path=%2Fuploads%2Fkf\.jpg/);
    assert.equal(record.contentType, 'image/jpeg');
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
    assert.equal(record.bytes, bytes);
    assert.equal(record.source, 'public-base');
    assert.equal(record.runId, 'run-1');
    assert.equal(record.sessionId, 'sess-1');
    assert.ok(Number.isFinite(record.publishedAt));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('契约：litterbox 仅显式开启时使用，且带 72h 过期；未开启时绝不自动回退', async () => {
  const { localPath, dir } = makeLocalAsset();
  try {
    // 未配置任何正式路径、未开启 demo 通道 → 统一失败，绝不碰第三方图床
    const off = new AssetPublicationAdapter({
      PUBLIC_BASE_URL: '',
      DEMO_PUBLIC_UPLOAD_URL: '',
      DEMO_ASSET_PUBLISHER: 'off',
      UPLOADS_DIR: path.dirname(localPath),
    });
    await assert.rejects(
      off.publish({ localPath }),
      (error: unknown) =>
        error instanceof AssetPublicationError &&
        error.code === 'asset_publication_unavailable' &&
        error.attempted.length === 0
    );

    // 显式 litterbox → 走该通道（mock fetch 验证请求契约）
    stubFetch((url) => {
      assert.equal(url, 'https://litterbox.catbox.moe/resources/internals/api.php');
      return textResponse('https://litterbox.catbox.moe/abc123.jpg');
    });
    try {
      const lit = new AssetPublicationAdapter({
        PUBLIC_BASE_URL: '',
        DEMO_PUBLIC_UPLOAD_URL: '',
        DEMO_ASSET_PUBLISHER: 'litterbox',
        UPLOADS_DIR: path.dirname(localPath),
      });
      const record = await lit.publish({ localPath, runId: 'run-2' });
      assert.equal(record.source, 'litterbox');
      assert.equal(record.publicUrl, 'https://litterbox.catbox.moe/abc123.jpg');
      assert.ok(record.expiresAtMs !== null && record.expiresAtMs > Date.now() + 71 * 3600 * 1000);
      assert.equal(record.runId, 'run-2');
    } finally {
      restoreFetch();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('契约：imgur 仅显式开启时使用；auto 弃用不再隐含第三方回退', async () => {
  const { localPath, dir } = makeLocalAsset();
  try {
    // auto（弃用）→ 无正式路径时失败，不自动回退 imgur/litterbox
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return jsonResponse({ data: { link: 'https://i.imgur.com/x.jpg' } });
    });
    try {
      const auto = new AssetPublicationAdapter({
        PUBLIC_BASE_URL: '',
        DEMO_PUBLIC_UPLOAD_URL: '',
        DEMO_ASSET_PUBLISHER: 'auto',
        UPLOADS_DIR: path.dirname(localPath),
      });
      await assert.rejects(auto.publish({ localPath }), AssetPublicationError);
      assert.equal(fetchCalled, false, 'auto 不得发起任何第三方图床请求');

      // 显式 imgur → 走 imgur 通道
      const imgur = new AssetPublicationAdapter({
        PUBLIC_BASE_URL: '',
        DEMO_PUBLIC_UPLOAD_URL: '',
        DEMO_ASSET_PUBLISHER: 'imgur',
        UPLOADS_DIR: path.dirname(localPath),
      });
      const record = await imgur.publish({ localPath });
      assert.equal(record.source, 'imgur');
      assert.equal(record.publicUrl, 'https://i.imgur.com/x.jpg');
      assert.ok(captured?.url === 'https://api.imgur.com/3/image');
    } finally {
      restoreFetch();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('契约：自建中继（用户自有宿主）为正式路径，失败信息可诊断', async () => {
  const { localPath, dir } = makeLocalAsset();
  try {
    stubFetch(() => jsonResponse({ ok: false, url: null }, false));
    try {
      const relay = new AssetPublicationAdapter({
        PUBLIC_BASE_URL: '',
        DEMO_PUBLIC_UPLOAD_URL: 'https://relay.example.com/upload',
        DEMO_PUBLIC_UPLOAD_TOKEN: 'tok',
        UPLOADS_DIR: path.dirname(localPath),
      });
      await assert.rejects(
        relay.publish({ localPath }),
        (error: unknown) =>
          error instanceof AssetPublicationError &&
          error.attempted.includes('relay') &&
          /已尝试/.test(error.message)
      );
      // 中继成功 → remote-host 语义（source=relay）
      captured = null;
      restoreFetch();
      stubFetch((url) => {
        assert.equal(url, 'https://relay.example.com/upload');
        return jsonResponse({ ok: true, url: 'https://relay.example.com/live-tu-assets/derived/kf.jpg' });
      });
      const ok = await new AssetPublicationAdapter({
        PUBLIC_BASE_URL: '',
        DEMO_PUBLIC_UPLOAD_URL: 'https://relay.example.com/upload',
        DEMO_PUBLIC_UPLOAD_TOKEN: 'tok',
        UPLOADS_DIR: path.dirname(localPath),
      }).publish({ localPath });
      assert.equal(ok.source, 'relay');
      assert.equal(ok.publicUrl, 'https://relay.example.com/live-tu-assets/derived/kf.jpg');
    } finally {
      restoreFetch();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('契约：本地资产不存在 → 统一可诊断失败（不发起任何请求）', async () => {
  let fetchCalled = false;
  stubFetch(() => {
    fetchCalled = true;
    return textResponse('');
  });
  try {
    const adapter = new AssetPublicationAdapter({ PUBLIC_BASE_URL: 'https://demo.example.com' });
    await assert.rejects(
      adapter.publish({ localPath: path.join(tmpdir(), 'definitely-missing-file.jpg') }),
      (error: unknown) => error instanceof AssetPublicationError && /本地资产不存在/.test(error.message)
    );
    assert.equal(fetchCalled, false);
  } finally {
    restoreFetch();
  }
});

test('配置：typed config 集中读取；旧变量保留兼容并带弃用说明', () => {
  const cfg = loadAssetPublicationConfig({
    PUBLIC_BASE_URL: 'https://app.example.com',
    APP_PUBLIC_URL: 'https://legacy.example.com',
    DEMO_PUBLIC_UPLOAD_URL: 'https://relay.example.com/upload',
    DEMO_PUBLIC_UPLOAD_TOKEN: 'tok',
    DEMO_ASSET_PUBLISHER: 'litterbox',
    UPLOADS_DIR: '/tmp/uploads',
  });
  assert.equal(cfg.publicBaseUrl, 'https://app.example.com');
  assert.equal(cfg.relayUrl, 'https://relay.example.com/upload');
  assert.equal(cfg.relayToken, 'tok');
  assert.equal(cfg.demoPublisher, 'litterbox');
  assert.equal(cfg.uploadsDir, '/tmp/uploads');

  // auto → off（弃用语义，不静默回退第三方）
  const auto = loadAssetPublicationConfig({ DEMO_ASSET_PUBLISHER: 'auto' });
  assert.equal(auto.demoPublisher, 'off');
  assert.equal(auto.demoPublisherRaw, 'auto');
});

/**
 * viral-control-image 测试：
 * - 人物保留版 prompt 契约（保留人物/场景/运镜，替换源产品，移除文字层）；
 * - 策略出口：viral_recreation_v2 模式下参考帧须经字幕预检（未预检 → 拒绝）；
 *   source_keyframe 声明仍被拒绝（不简单改名绕过旧路径）；
 * - FAKE_VIRAL_CONTROL_IMAGE=true 确定性派生（不调用图像 provider）；
 * - 缺产品图/缺锚点帧 → 显式错误。
 * 全部零真实付费。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildViralControlImagePrompt,
  createViralControlImage,
} from '../lib/viral-control-image';
import {
  runUploadedReferenceFrameDeclaration,
  sourceKeyframeDeclaration,
  productShotDeclaration,
} from '../adapters/reference-policy-guard';
import {
  evaluateReferenceInputs,
} from '../domain/reference-policy/reference-input-policy';

test('人物保留版 prompt 契约：保留人物/场景/运镜，替换源产品，移除文字层', () => {
  const prompt = buildViralControlImagePrompt({
    productName: 'BUV 小绿泥洁面',
    shotStructure: '中景，博主手持绿色产品管展示',
  });
  assert.ok(/[Pp]reserve the person/.test(prompt), '必须显式保留人物');
  assert.ok(/their action/.test(prompt), '必须保留动作');
  assert.ok(/the set, the lighting, and the camera composition/.test(prompt), '必须保留场景/光线/构图');
  assert.ok(/[Rr]eplace the source-video product/.test(prompt), '必须替换源产品');
  assert.ok(/[Rr]emove all burned-in subtitles/.test(prompt), '必须移除烧录字幕');
  assert.ok(/[Dd]o not reproduce any source-video subtitle text/.test(prompt), '不得复刻源字幕文字');
  assert.ok(prompt.includes('BUV 小绿泥洁面'), '产品名进入 prompt');
  assert.ok(prompt.includes('9:16'), '竖屏构图');
});

test('策略出口：run_uploaded_reference_frame 通过预检后放行（viral_recreation_v2）', () => {
  const decision = evaluateReferenceInputs(
    [
      runUploadedReferenceFrameDeclaration({ url: 'https://cdn.example.com/subclip.mp4', subtitlePreflightPassed: true }),
      productShotDeclaration('https://cdn.example.com/product.png', 0),
    ],
    { mode: 'viral_recreation_v2', strict: false }
  );
  assert.equal(decision.rejected.length, 0);
  assert.equal(decision.providerPayloadUrls.length, 2);
});

test('策略出口：未预检的参考帧（subtitlePreflightPassed=false）→ 拒绝', () => {
  const decision = evaluateReferenceInputs(
    [runUploadedReferenceFrameDeclaration({ url: 'https://cdn.example.com/subclip.mp4', subtitlePreflightPassed: false })],
    { mode: 'viral_recreation_v2', strict: false }
  );
  assert.equal(decision.providerPayloadUrls.length, 0);
  assert.equal(decision.rejected.length, 1);
  assert.equal(decision.rejected[0].code, 'source_overlay');
});

test('策略出口：source_keyframe 在 viral_recreation_v2 下仍被拒绝（不简单改名绕过）', () => {
  const decision = evaluateReferenceInputs(
    [sourceKeyframeDeclaration('https://cdn.example.com/original-frame.jpg')],
    { mode: 'viral_recreation_v2', strict: false }
  );
  assert.equal(decision.providerPayloadUrls.length, 0);
  assert.equal(decision.rejected[0].code, 'source_keyframe_to_provider');
});

test('策略出口：semantic_recreation 下 run_uploaded_reference_frame 显式拒绝（模式隔离）', () => {
  const decision = evaluateReferenceInputs(
    [runUploadedReferenceFrameDeclaration({ url: 'https://cdn.example.com/subclip.mp4', subtitlePreflightPassed: true })],
    { mode: 'semantic_recreation', strict: false }
  );
  // viral_recreation_v2 专用 kind（允许保留公司模特）与 semantic_recreation 无人物纪律冲突，
  // 必须显式拒绝——绝不以默认模式泄漏到 provider
  assert.equal(decision.providerPayloadUrls.length, 0);
  assert.equal(decision.rejected.length, 1);
  assert.equal(decision.rejected[0].code, 'mode_mismatch');
});

test('createViralControlImage：缺产品图 → 显式错误（拒绝纯文本生图）', async () => {
  await assert.rejects(
    () =>
      createViralControlImage({
        referenceVideoUrl: 'https://cdn.example.com/subclip.mp4',
        referenceFrameUrl: 'https://cdn.example.com/frame.jpg',
        productAssetUrls: [],
        productName: 'BUV',
        shotStructure: '中景',
        subtitlePreflightPassed: true,
      }),
    /productAssetUrls/
  );
});

test('createViralControlImage：字幕未预检 → 拒绝（绝不提交带字幕素材）', async () => {
  await assert.rejects(
    () =>
      createViralControlImage({
        referenceVideoUrl: 'https://cdn.example.com/subclip.mp4',
        referenceFrameUrl: 'https://cdn.example.com/frame.jpg',
        productAssetUrls: ['https://cdn.example.com/product.png'],
        productName: 'BUV',
        shotStructure: '中景',
        subtitlePreflightPassed: false,
      }),
    (err: any) => err?.code === 'subtitle_preflight_failed'
  );
});

test('createViralControlImage：缺锚点帧 → 显式错误', async () => {
  await assert.rejects(
    () =>
      createViralControlImage({
        referenceVideoUrl: 'https://cdn.example.com/subclip.mp4',
        productAssetUrls: ['https://cdn.example.com/product.png'],
        productName: 'BUV',
        shotStructure: '中景',
        subtitlePreflightPassed: true,
      }),
    /referenceFrameUrl/
  );
});

test('FAKE_VIRAL_CONTROL_IMAGE：确定性派生（本地产品图字节，不调用图像 provider）', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-vci-'));
  process.env.DATA_DIR = tmp;
  process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
  fs.mkdirSync(path.join(process.env.UPLOADS_DIR, 'renders'), { recursive: true });
  fs.mkdirSync(path.join(process.env.UPLOADS_DIR, 'product-assets'), { recursive: true });
  // 建一张 1x1 png 产品图
  const pngPath = path.join(process.env.UPLOADS_DIR, 'product-assets', 'pa-test.png');
  fs.writeFileSync(pngPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));
  const productUrl = '/uploads/product-assets/pa-test.png';

  process.env.FAKE_VIRAL_CONTROL_IMAGE = 'true';
  process.env.FAKE_FIRST_FRAME_DERIVE = 'false';
  try {
    // 需要 DB 初始化（persistViralArtifact 写入表；失败仅警告不阻断）
    try {
      const { initDatabase } = await import('../lib/db');
      initDatabase();
    } catch {
      // DB 已初始化或不可用：provenance 写入失败仅警告，不阻断 probe
    }
    const result = await createViralControlImage({
      referenceVideoUrl: 'https://cdn.example.com/subclip.mp4',
      referenceFrameUrl: 'https://cdn.example.com/frame.jpg',
      productAssetUrls: [productUrl],
      productName: 'BUV 小绿泥洁面',
      shotStructure: '中景，博主手持产品展示',
      subtitlePreflightPassed: true,
      persist: { runId: 'test-run', ownerId: 'test-admin', referenceVideoUrl: 'https://cdn.example.com/subclip.mp4' },
    });
    assert.ok(result.imageUrl.endsWith('.png'));
    assert.equal(result.provider, 'fake-viral-control-image');
    assert.ok(result.prompt.includes('BUV 小绿泥洁面'));
    assert.ok(fs.existsSync(result.localPath));
  } finally {
    delete process.env.FAKE_VIRAL_CONTROL_IMAGE;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

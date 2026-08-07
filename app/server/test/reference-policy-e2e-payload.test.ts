/**
 * P5 端到端 payload 测试：ReferenceInputPolicy 在三个真实出口强制执行。
 *
 * 出口 1：条件化首帧生成（/images/edits payload，resolveConditioningReferenceImages
 *         + createProductConditionedFirstFrame 的请求前守卫）；
 * 出口 2：Seedance 请求构建（buildSubmissionReferenceMaterials + buildSeedanceGenerationBody）；
 * 出口 3：重试修复（fix/retry 共用 ensureShotFirstFrame 派生漏斗）。
 *
 * 全部为确定性测试：守卫在请求构建前抛 ReferencePolicyViolationError，
 * 不发起任何真实 provider 调用（deriveFn spy 断言「未被调用」）。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReferencePolicyViolationError } from '../domain/reference-policy/reference-input-policy';
import {
  sourceKeyframeDeclaration,
  productShotDeclaration,
  virtualTalentDeclaration,
  ownedAnchorDeclaration,
} from '../adapters/reference-policy-guard';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-ref-policy-e2e-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
// 注意：db 及触达 db 链的模块必须动态 import——静态 import 会在 env 设置前
// 求值 db.ts，把 DATA_DIR 固化为仓库 ./data（单文件运行时读到历史数据）。
const { initDatabase, db } = await import('../lib/db');
const { resolveConditioningReferenceImages } = await import('../lib/product-conditioned-frame');
const { buildSubmissionReferenceMaterials } = await import('../lib/video-submission-port');
const { buildSeedanceGenerationBody } = await import('../routes/seedance');
const { ensureShotFirstFrame, shotFirstFrameContextFromDraft } = await import('../lib/shot-first-frame');
initDatabase();

const RAW_KEYFRAME = 'https://raw.example/source-keyframe-face.jpg';
const PRODUCT_IMG = 'https://assets.example.com/buv-pack.png';
const PRODUCT_IMG_2 = 'https://assets.example.com/buv-back.png';
const OWNED_ANCHOR = 'https://assets.example.com/owned-scene-anchor.jpg';
const BRAND_AVATAR = 'https://assets.example.com/brand-talent.png';

before(() => {
  // P5 可信来源：产品资产须在本表（owner 匹配）才能被声明为 product_shot
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES ('owner-1', 'owner-1', 'unused', 'operator')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO products (id, name, positioning, price, revision)
     VALUES ('e2e-product', 'BUV E2E', 'test', '49', 1)`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO product_assets (id, product_id, role, url, owner_id, safety_status, safety_evidence, safety_version, sha256)
     VALUES ('e2e-product-1', 'e2e-product', 'hero', ?, 'owner-1', 'pass', '{"face":false,"overlay":false,"watermark":false}', 'v2', ?)`
  ).run(PRODUCT_IMG, 'c'.repeat(64));
});

after(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

const okPreflight = async () => ({ ok: true, issues: [], score: 1, evidence: 'e2e-fake', checkedAt: Date.now() });

function fakeDeriveReturning(input: any) {
  return async (i: any) => ({
    imageUrl: 'https://assets.example.com/derived.png',
    localPath: '/uploads/renders/derived.png',
    provider: 'fake',
    model: 'gpt-image-1',
    provenance: { ...i, conditionedFirstFrameUrl: 'https://assets.example.com/derived.png' },
    confidence: null,
    capability: { supported: true, mechanism: 'edits_multipart', modelId: null, modelCode: 'gpt-image-1', evidence: 'e2e', probedAt: null },
  });
}

// ==================== 出口 1：条件化首帧生成 ====================

test('出口1：原视频关键帧默认（semantic_recreation）不得进入 /images/edits payload', () => {
  assert.throws(
    () =>
      resolveConditioningReferenceImages({
        referenceKeyframeUrl: RAW_KEYFRAME,
        productAssetUrls: [PRODUCT_IMG],
      }),
    (error: unknown) =>
      error instanceof ReferencePolicyViolationError &&
      error.code === 'source_keyframe_to_provider'
  );
  // 显式声明含人脸 → face_in_provider_input（无论声明什么 kind，人脸不得进入）
  assert.throws(
    () =>
      resolveConditioningReferenceImages({
        referenceKeyframeUrl: RAW_KEYFRAME,
        productAssetUrls: [PRODUCT_IMG],
        referencePolicy: {
          mode: 'semantic_recreation',
          images: [
            { id: 'kf', url: RAW_KEYFRAME, kind: 'owned_scene_anchor', containsFace: true },
            productShotDeclaration(PRODUCT_IMG),
          ],
        },
      }),
    (error: unknown) => error instanceof ReferencePolicyViolationError && error.code === 'face_in_provider_input'
  );
});

test('出口1：产品锚点 + 产品图 → payload 只含策略放行资产', () => {
  const payload = resolveConditioningReferenceImages({
    referenceKeyframeUrl: OWNED_ANCHOR,
    productAssetUrls: [PRODUCT_IMG, PRODUCT_IMG_2],
    referencePolicy: {
      mode: 'semantic_recreation',
      images: [ownedAnchorDeclaration(OWNED_ANCHOR), productShotDeclaration(PRODUCT_IMG), productShotDeclaration(PRODUCT_IMG_2, 1)],
    },
  });
  assert.deepEqual(payload, [OWNED_ANCHOR, PRODUCT_IMG, PRODUCT_IMG_2]);
  assert.ok(!payload.includes(RAW_KEYFRAME));
});

test('出口1：virtual_talent 品牌自有虚拟人物（有脸、身份无关）可进入 payload', () => {
  const payload = resolveConditioningReferenceImages({
    referenceKeyframeUrl: BRAND_AVATAR,
    productAssetUrls: [PRODUCT_IMG],
    referencePolicy: {
      mode: 'virtual_talent',
      images: [
        virtualTalentDeclaration({ url: BRAND_AVATAR, identityRef: 'brand-talent-9', sourceIdentityRef: 'source-host-01' }),
        productShotDeclaration(PRODUCT_IMG),
      ],
    },
  });
  assert.deepEqual(payload, [BRAND_AVATAR, PRODUCT_IMG]);
});

test('出口1：virtual_talent 与原视频同一身份的虚拟资产被拒绝（有脸≠禁止，同身份才禁）', () => {
  assert.throws(
    () =>
      resolveConditioningReferenceImages({
        referenceKeyframeUrl: BRAND_AVATAR,
        productAssetUrls: [PRODUCT_IMG],
        referencePolicy: {
          mode: 'virtual_talent',
          images: [
            virtualTalentDeclaration({ url: BRAND_AVATAR, identityRef: 'person-x', sourceIdentityRef: 'person-x' }),
            productShotDeclaration(PRODUCT_IMG),
          ],
        },
      }),
    (error: unknown) => error instanceof ReferencePolicyViolationError && error.code === 'virtual_talent_identity_link'
  );
});

// ==================== 出口 2：Seedance 请求构建 ====================

test('出口2：Seedance reference materials 拒绝原视频关键帧（默认 semantic_recreation）', () => {
  assert.throws(
    () =>
      buildSubmissionReferenceMaterials({
        referenceImageUrls: [RAW_KEYFRAME],
      }),
    (error: unknown) => error instanceof ReferencePolicyViolationError && error.code === 'source_keyframe_to_provider'
  );
});

test('出口2：整条 Seedance body 只含策略放行资产（首帧 + 显式放行的参考素材）', () => {
  const materials = buildSubmissionReferenceMaterials({
    referenceImageUrls: [OWNED_ANCHOR],
    referencePolicy: {
      mode: 'semantic_recreation',
      images: [ownedAnchorDeclaration(OWNED_ANCHOR)],
    },
  });
  assert.equal(materials.length, 1);
  const prepared = buildSeedanceGenerationBody({
    prompt: 'demo prompt',
    model: 'doubao-seedance-2-0-fast',
    duration: 5,
    resolution: '720p',
    aspectRatio: '9:16',
    imageUrl: 'https://assets.example.com/derived-first-frame.png',
    materials: [
      { url: 'https://assets.example.com/derived-first-frame.png', kind: 'image', role: 'first_frame', label: 'derived_first_frame' },
      ...materials,
    ],
  });
  const urls = prepared.body.materials?.map((m: any) => m.url) ?? [];
  assert.ok(urls.includes('https://assets.example.com/derived-first-frame.png'));
  assert.ok(urls.includes(OWNED_ANCHOR));
  assert.ok(!urls.includes(RAW_KEYFRAME), '原视频关键帧绝不能出现在 Seedance body');
});

test('出口2：空参考列表直接通过（首帧-only 提交不受影响）', () => {
  assert.deepEqual(buildSubmissionReferenceMaterials({ referenceImageUrls: [] }), []);
});

// ==================== 出口 3：重试修复（fix/retry 共用派生漏斗） ====================

test('出口3：fix/retry 漏斗拒绝原视频关键帧上下文，deriveFn 不被调用（0 次派生）', async () => {
  let deriveCalls = 0;
  await assert.rejects(
    () =>
      ensureShotFirstFrame({
        ownerId: 'owner-1',
        shotId: 'shot-1',
        shotIndex: 1,
        referenceKeyframeUrl: RAW_KEYFRAME,
        productAssetUrls: [PRODUCT_IMG],
        productName: 'BUV',
        shotStructure: 'close-up',
        deriveFn: (async () => {
          deriveCalls += 1;
          return fakeDeriveReturning({})({});
        }) as any,
        preflightFn: okPreflight,
      }),
    (error: unknown) => error instanceof ReferencePolicyViolationError && error.code === 'source_keyframe_to_provider'
  );
  assert.equal(deriveCalls, 0, '策略违规时不得发起任何派生（provider）调用');
});

test('出口3：fix/retry 漏斗通过可信 product_shot 锚点，deriveFn 收到产品锚点', async () => {
  let deriveInput: any = null;
  const outcome = await ensureShotFirstFrame({
    ownerId: 'owner-1',
    shotId: 'shot-2',
    shotIndex: 2,
    // 锚点 = product_assets 表中的可信产品资产（owner-1 匹配）→ 声明为 product_shot
    referenceKeyframeUrl: PRODUCT_IMG,
    productAssetUrls: [PRODUCT_IMG],
    productName: 'BUV',
    shotStructure: 'demo',
    deriveFn: (async (input: any) => {
      deriveInput = input;
      return fakeDeriveReturning(input)(input);
    }) as any,
    preflightFn: okPreflight,
  });
  assert.ok(outcome.firstFrameUrl);
  assert.equal(deriveInput.referenceKeyframeUrl, PRODUCT_IMG);
  assert.equal(deriveInput.referencePolicy?.mode, 'semantic_recreation', '派生实现收到同样的策略声明');
});

test('出口3：legacy safe_keyframe 草稿（fix/retry 对象）因锚点无可信来源被拒绝', async () => {
  const ctx = shotFirstFrameContextFromDraft({
    ownerId: 'owner-1',
    runId: 'run-1',
    shot: { id: 'shot-3', session_id: 'sess-1', shot_index: 1, reference_keyframe_url: RAW_KEYFRAME },
    draft: {
      productName: 'BUV',
      productAssetUrls: [PRODUCT_IMG],
      referenceKeyframes: [RAW_KEYFRAME],
      shots: [
        {
          shotIndex: 1,
          referencePolicy: 'safe_keyframe',
          referenceKeyframeUrl: null,
          continuityAnchorUrl: null,
        },
      ],
    },
  });
  assert.equal(ctx.referenceKeyframeUrl, RAW_KEYFRAME);
  // 草稿自报的 referencePolicy 不是合规标签：原帧 URL 无可信来源 → 策略拒绝
  await assert.rejects(
    () =>
      ensureShotFirstFrame({
        ...ctx,
        deriveFn: (async () => fakeDeriveReturning({})({})) as any,
        preflightFn: okPreflight,
      }),
    (error: unknown) =>
      error instanceof ReferencePolicyViolationError && error.code === 'source_keyframe_to_provider'
  );
});

test('出口3：裸 URL 不能复用为已派生首帧（无 provenance 记录 → 拒绝）', async () => {
  await assert.rejects(
    () =>
      ensureShotFirstFrame({
        ownerId: 'owner-1',
        shotId: 'shot-4a',
        shotIndex: 4,
        referenceKeyframeUrl: RAW_KEYFRAME,
        productAssetUrls: [PRODUCT_IMG],
        productName: 'BUV',
        shotStructure: 'close-up',
        existingFirstFrameUrl: 'https://assets.example.com/already-derived.png',
        preflightFn: okPreflight,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as any).code === 'first_frame_reuse_not_verifiable'
  );
});

test('出口3：conditioned_first_frames 有记录（owner 匹配）的派生首帧可复用', async () => {
  const derivedUrl = 'https://assets.example.com/verified-derived.png';
  db.prepare(
    `INSERT OR IGNORE INTO conditioned_first_frames
       (id, owner_id, conditioned_first_frame_url, product_asset_urls_json, provider, model, prompt_version, prompt,
        safety_status, safety_evidence, safety_version, sha256)
      VALUES ('cff-e2e-1', 'owner-1', ?, '[]', 'fake', 'gpt-image-1', 'v2', 'x',
              'pass', '{"face":false,"overlay":false,"watermark":false}', 'v2', ?)`
  ).run(derivedUrl, 'c'.repeat(64));
  const outcome = await ensureShotFirstFrame({
    ownerId: 'owner-1',
    shotId: 'shot-4b',
    shotIndex: 4,
    referenceKeyframeUrl: PRODUCT_IMG,
    productAssetUrls: [PRODUCT_IMG],
    productName: 'BUV',
    shotStructure: 'close-up',
    existingFirstFrameUrl: derivedUrl,
    preflightFn: okPreflight,
  });
  assert.equal(outcome.derived, false);
  assert.equal(outcome.firstFrameUrl, derivedUrl);
});

/**
 * S3 输入模型 + 首帧保障测试（临时 DB + 确定性 seam，零真实 provider 调用）：
 * - 输入合同：step2 接受 referenceVideoUrl + productAssetUrls，用户无需提供 firstFrame；
 * - 派生合同：首帧必须由 referenceKeyframeUrl + productAssetUrls 派生（缺一显式失败）；
 * - 能力门禁：provider 不支持多图条件生成 → product_conditioning_provider_unavailable；
 * - 预检失败 → Seedance 0 次调用（镜头标记失败 + 可读原因）；
 * - 同镜头并发提交 → 只有一次 provider 调用（原子 claim）；
 * - 两镜受限并发 → 每镜恰好一次提交，不重复。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { WorkflowController } from '../lib/workflow-controller';
import type { FakeVideoPort } from '../lib/video-submission-port';
import type { MaterialCheck, ShotPlanShot } from '../../shared/workbench-contract';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-shot-first-frame-test-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.ALLOW_MOCK_FALLBACK = 'true';
delete process.env.YUNWU_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.SEEDANCE_BASE_URL;
delete process.env.SEEDANCE_ACCOUNT;
delete process.env.SEEDANCE_PASSWORD;
process.env.FAKE_VIDEO_PROVIDER = 'true';
process.env.IMAGE_CONDITIONING_PROBE = 'off';

const { initDatabase, db } = await import('../lib/db.ts');
initDatabase();
const { registerSafetyPassedFirstFrame, registerSafetyPassedProductAsset } = await import('./_helpers.ts');
const {
  ShotFirstFrameError,
  ensureShotFirstFrame,
  shotFirstFrameContextFromDraft,
  buildConditioningShotStructure,
} = await import('../lib/shot-first-frame.ts');
const { createProductConditionedFirstFrame, buildConditionedFramePrompt } = await import('../lib/product-conditioned-frame.ts');
const { ImageConditioningUnavailableError } = await import('../lib/image-conditioning-capability.ts');

const { WorkflowController } = await import('../lib/workflow-controller.ts');
const { FakeVideoPort } = await import('../lib/video-submission-port.ts');
const { pipelineRouter } = await import('../routes/pipeline.ts');
const express = (await import('express')).default;

before(() => {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, ?)`
  ).run('ff-owner', 'ff-owner', 'unused', 'operator');
  db.prepare(
    `INSERT INTO products (id, name, positioning, price, revision)
     VALUES ('ff-product', 'BUV 测试洁面', '油皮专研', '49', 1)
     ON CONFLICT(id) DO NOTHING`
  ).run();
  db.prepare(
    `INSERT INTO product_assets (id, product_id, role, url, owner_id)
     VALUES ('ff-asset-1', 'ff-product', 'hero', 'https://public.example.com/product.png', 'ff-owner')
     ON CONFLICT(id) DO NOTHING`
  ).run();
  // P5 可信来源：派生测试用到的「锚点/第二产品图」也须在资产表（owner 匹配），
  // 否则会被 ReferenceInputPolicy 当作来源不明的 source_keyframe 拒绝。
  db.prepare(
    `INSERT INTO product_assets (id, product_id, role, url, owner_id)
     VALUES ('ff-asset-2', 'ff-product', 'anchor', 'https://public.example.com/kf-2.jpg', 'ff-owner'),
            ('ff-asset-3', 'ff-product', 'hero', 'https://public.example.com/product-back.png', 'ff-owner')
     ON CONFLICT(id) DO NOTHING`
  ).run();
  for (const url of [
    'https://public.example.com/product.png',
    'https://public.example.com/kf-2.jpg',
    'https://public.example.com/product-back.png',
  ]) {
    registerSafetyPassedProductAsset('ff-owner', url);
  }
});

after(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

const okProbe = async (url: string, kind: MaterialCheck['kind']): Promise<MaterialCheck> => ({
  kind,
  url,
  ok: true,
  status: 'verified',
  detail: '存在',
});

function makeShot(shotIndex: number, overrides: Partial<ShotPlanShot> = {}): ShotPlanShot {
  return {
    shotIndex,
    startTime: (shotIndex - 1) * 5,
    endTime: shotIndex * 5,
    shotSize: 'close_up',
    cameraPosition: 'front',
    cameraMovement: 'push_in',
    lighting: 'soft',
    dialogue: [],
    soundEffects: [],
    mustKeep: ['包装'],
    mustReplace: ['竞品 logo'],
    generationMode: 'image_to_video',
    capabilityConstraints: {
      maxDurationSec: 5,
      minDurationSec: 3,
      supportedAspectRatios: ['9:16'],
      supportedResolutions: ['720p'],
      requiredReferenceInputs: 1,
    },
    status: 'pending',
    blockers: [],
    warnings: [],
    evidence: [],
    candidates: [],
    selectedCandidateId: null,
    promptOverride: null,
    modelId: 'Seedance 2.0 Fast',
    ...overrides,
  };
}

let seq = 0;

function setupSession(opts: {
  shotCount: number;
  referenceKeyframes?: string[];
  productAssetUrls?: string[];
}): { sessionId: string; shotIds: string[] } {
  seq += 1;
  const sessionId = `ff-sess-${Date.now()}-${seq}`;
  const shotIds: string[] = [];
  for (let i = 1; i <= opts.shotCount; i++) {
    const shotId = `ff-shot-${sessionId}-${i}`;
    db.prepare(
      `INSERT INTO shot_generation_tasks
         (id, session_id, owner_id, shot_index, status, video_prompt,
          reference_keyframe_url, reference_video_url)
       VALUES (?, ?, 'ff-owner', ?, 'pending', ?, ?, 'http://64.83.1.104/live-tu-assets/viral/viral-reference-01.mp4')`
    ).run(
      shotId,
      sessionId,
      i,
      `prompt shot ${i}`,
      opts.referenceKeyframes?.[i - 1] ?? `https://public.example.com/kf-${i}.jpg`
    );
    shotIds.push(shotId);
  }
  db.prepare(
    `INSERT INTO workbench_state (id, owner_id, session_id, autonomy_mode, paid_auth_enabled, confirms_json, draft_json, save_state, updated_at)
     VALUES (?, 'ff-owner', ?, 'managed', 1, '{}', ?, 'saved', CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET draft_json = excluded.draft_json`
  ).run(
    `wb:session:${sessionId}`,
    sessionId,
    JSON.stringify({
      // P5：镜头声明 semantic_replacement + 产品图连续性锚点（ReferenceInputPolicy
      // 在首帧派生出口强制执行；原视频关键帧不得作为条件化参考输入）
      shots: Array.from({ length: opts.shotCount }, (_, i) => ({
        ...makeShot(i + 1),
        referencePolicy: 'semantic_replacement',
        referenceKeyframeUrl: null,
        continuityAnchorUrl: opts.productAssetUrls?.[0] ?? 'https://public.example.com/product.png',
      })),
      productId: 'ff-product',
      productName: 'BUV 测试洁面',
      referenceVideoUrl: 'http://64.83.1.104/live-tu-assets/viral/viral-reference-01.mp4',
      referenceKeyframes: opts.referenceKeyframes ?? ['https://public.example.com/kf-1.jpg'],
      productAssetUrls: opts.productAssetUrls ?? ['https://public.example.com/product.png'],
    })
  );
  return { sessionId, shotIds };
}

/** 预检恒通过的 fake 首帧 seam */
function okFirstFrameSeam() {
  return async (ctx: any) => {
    const url = ctx.existingFirstFrameUrl || `https://public.example.com/derived-${ctx.shotId}.png`;
    registerSafetyPassedFirstFrame(ctx.ownerId, url);
    return {
      firstFrameUrl: url,
      derived: !ctx.existingFirstFrameUrl,
      attempts: 1,
      preflight: { ok: true, issues: [], score: 1, evidence: 'fake-seam', checkedAt: Date.now() },
    };
  };
}

test('S3 合同：用户不需要提供 firstFrame——step2 仅需 referenceVideoUrl + productAssetUrls', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUser = { id: 'ff-owner', username: 'ff-owner', role: 'operator', permissions: [] };
    next();
  });
  app.use('/pipeline', pipelineRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/pipeline/step2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'ff-product',
        productInfo: { name: 'BUV 测试洁面' },
        referenceVideoUrl: 'http://64.83.1.104/live-tu-assets/viral/viral-reference-01.mp4',
        referenceKeyframes: ['https://public.example.com/kf-1.jpg'],
        productAssetUrls: ['https://public.example.com/product.png'],
        shotList: [
          { shotIndex: 1, shotType: 'close-up', cameraMovement: 'push-in', description: 'product detail' },
        ],
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json).slice(0, 300));
    const sessionId = json.data.multiShotResult.sessionId as string;
    // 镜头任务持久化了参考视频/参考关键帧，但 first_frame_url 为空（派生在提交时发生）
    const row = db
      .prepare('SELECT reference_video_url, reference_keyframe_url, first_frame_url FROM shot_generation_tasks WHERE session_id = ?')
      .get(sessionId) as any;
    assert.equal(row.reference_video_url, 'http://64.83.1.104/live-tu-assets/viral/viral-reference-01.mp4');
    assert.equal(row.reference_keyframe_url, 'https://public.example.com/kf-1.jpg');
    assert.equal(row.first_frame_url, null, '首帧必须是派生产物，用户不提供首帧');
    // 响应明确标记 firstFrameSource=derived
    assert.equal(json.data.firstFrameSource, 'derived');
  } finally {
    server.close();
  }
});

test('S3 派生合同：首帧必须由 referenceKeyframeUrl + productAssetUrls 派生（缺任一显式失败）', async () => {
  // 1) 无参考关键帧 → 显式失败（禁止用产品图冒充首帧）
  await assert.rejects(
    () =>
      ensureShotFirstFrame({
        ownerId: 'ff-owner',
        shotId: 'shot-x',
        shotIndex: 1,
        referenceKeyframeUrl: null,
        productAssetUrls: ['https://public.example.com/product.png'],
        productName: 'BUV',
        shotStructure: 'close-up',
      }),
    (err: any) => err instanceof ShotFirstFrameError && err.code === 'first_frame_derivation_context_missing'
  );
  // 2) 无产品图 → 显式失败（禁止纯文本生图）
  await assert.rejects(
    () =>
      ensureShotFirstFrame({
        ownerId: 'ff-owner',
        shotId: 'shot-x',
        shotIndex: 1,
        referenceKeyframeUrl: 'https://public.example.com/kf-1.jpg',
        productAssetUrls: [],
        productName: 'BUV',
        shotStructure: 'close-up',
      }),
    (err: any) => err instanceof ShotFirstFrameError && err.code === 'first_frame_derivation_context_missing'
  );
  // 3) 派生调用必须同时收到 参考关键帧 + 产品图（spy 断言，不是只传产品图）
  let deriveInput: any = null;
  await ensureShotFirstFrame({
    ownerId: 'ff-owner',
    shotId: 'shot-y',
    shotIndex: 2,
    // P5：锚点必须可被服务端核验为自有资产（product_assets 表 owner 匹配），
    // 否则按来源不明的 source_keyframe 拒绝——这里 kf-2.jpg 已在资产表注册。
    referenceKeyframeUrl: 'https://public.example.com/kf-2.jpg',
    productAssetUrls: ['https://public.example.com/product.png', 'https://public.example.com/product-back.png'],
    productName: 'BUV',
    shotStructure: 'wide shot, hand holding product',
    deriveFn: (async (input: any) => {
      deriveInput = input;
      return {
        imageUrl: 'https://public.example.com/derived.png',
        localPath: '/uploads/renders/derived.png',
        provider: 'fake',
        model: 'gpt-image-1',
        provenance: { ...input, conditionedFirstFrameUrl: 'https://public.example.com/derived.png' },
        confidence: null,
        capability: { supported: true, mechanism: 'edits_multipart', modelId: null, modelCode: 'gpt-image-1', evidence: 'fake', probedAt: null },
      };
    }) as any,
    preflightFn: async () => ({ ok: true, issues: [], score: 1, evidence: 'fake', checkedAt: Date.now() }),
  });
  assert.ok(deriveInput, '必须调用派生实现');
  assert.equal(deriveInput.referenceKeyframeUrl, 'https://public.example.com/kf-2.jpg');
  assert.deepEqual(deriveInput.productAssetUrls, [
    'https://public.example.com/product.png',
    'https://public.example.com/product-back.png',
  ]);
  // A product-only safe anchor must not be misrepresented as a source-composition
  // image. The scene comes from the executable semantic structure instead.
  const prompt = buildConditionedFramePrompt({
    productName: 'BUV',
    shotStructure: 'close-up, product enters from left and leaves a visible foam result',
    referenceAnchorKind: 'product_shot',
  });
  assert.match(prompt, /product identity image/i);
  assert.match(prompt, /new scene from the shot structure/i);
  assert.match(prompt, /foam result/i);
});

test('semantic replacement draft uses the continuity anchor instead of a raw keyframe fallback', () => {
  const ctx = shotFirstFrameContextFromDraft({
    ownerId: 'ff-owner',
    runId: 'ff-run',
    shot: {
      id: 'ff-shot-semantic',
      session_id: 'ff-session',
      shot_index: 3,
      reference_keyframe_url: 'https://raw.example/face.jpg',
    },
    draft: {
      productName: 'BUV',
      productAssetUrls: ['https://relay.example/product.png'],
      referenceKeyframes: ['https://raw.example/face.jpg'],
      shots: [
        {
          shotIndex: 3,
          referencePolicy: 'semantic_replacement',
          referenceKeyframeUrl: null,
          continuityAnchorUrl: 'https://relay.example/safe-anchor.jpg',
          visualIntent: 'product-led demo',
        },
      ],
    },
  });
  assert.equal(ctx.referenceKeyframeUrl, 'https://relay.example/safe-anchor.jpg');
  assert.notEqual(ctx.referenceKeyframeUrl, 'https://raw.example/face.jpg');
  assert.equal(ctx.referencePolicy, 'semantic_replacement');
});

test('full-video continuity uses the preceding verified conditioned frame as the next shot anchor', () => {
  const { sessionId, shotIds } = setupSession({ shotCount: 2 });
  const predecessorUrl = `https://public.example.com/derived-${shotIds[0]}.png`;
  db.prepare(
    `UPDATE shot_generation_tasks
        SET first_frame_url = ?, derived_first_frame_url = ?, first_frame_preflight_status = 'passed'
      WHERE id = ?`
  ).run(predecessorUrl, predecessorUrl, shotIds[0]);
  registerSafetyPassedFirstFrame('ff-owner', predecessorUrl);

  const ctx = shotFirstFrameContextFromDraft({
    ownerId: 'ff-owner',
    runId: 'ff-run',
    shot: {
      id: shotIds[1],
      session_id: sessionId,
      shot_index: 2,
      reference_keyframe_url: 'https://raw.example/face.jpg',
    },
    draft: {
      productName: 'BUV',
      productAssetUrls: ['https://public.example.com/product.png'],
      referenceKeyframes: ['https://raw.example/face.jpg'],
      fullVideoPlan: {
        shots: Array.from({ length: 6 }, (_, index) => ({ shotIndex: index + 1 })),
        visualContinuity: {
          seams: Array.from({ length: 5 }, (_, index) => ({
            fromShotIndex: index + 1,
            toShotIndex: index + 2,
          })),
        },
      },
      shots: [
        {
          shotIndex: 2,
          referencePolicy: 'semantic_replacement',
          referenceKeyframeUrl: null,
          continuityAnchorUrl: 'https://public.example.com/product.png',
          visualIntent: 'product-led demo',
        },
      ],
    },
  });

  assert.equal(ctx.referenceKeyframeUrl, predecessorUrl);
  assert.equal(ctx.continuityAnchorUrl, predecessorUrl);
  assert.notEqual(ctx.referenceKeyframeUrl, 'https://raw.example/face.jpg');
});

test('quality full-video submission serializes first-frame preparation so every receiving shot inherits its predecessor', async () => {
  const { sessionId, shotIds } = setupSession({ shotCount: 6 });
  const state = db.prepare('SELECT draft_json FROM workbench_state WHERE session_id = ?').get(sessionId) as { draft_json: string };
  const draft = JSON.parse(state.draft_json);
  draft.fullVideoPlan = {
    shots: Array.from({ length: 6 }, (_, index) => ({ shotIndex: index + 1 })),
    visualContinuity: {
      seams: Array.from({ length: 5 }, (_, index) => ({
        fromShotIndex: index + 1,
        toShotIndex: index + 2,
      })),
    },
  };
  db.prepare('UPDATE workbench_state SET draft_json = ? WHERE session_id = ?').run(JSON.stringify(draft), sessionId);

  let active = 0;
  let maxActive = 0;
  const contexts: Array<{ shotIndex: number; referenceKeyframeUrl: string | null | undefined }> = [];
  const fake = new FakeVideoPort();
  const ctrl: WorkflowController = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: async (ctx) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      contexts.push({ shotIndex: ctx.shotIndex, referenceKeyframeUrl: ctx.referenceKeyframeUrl });
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const url = `https://public.example.com/derived-${ctx.shotId}.png`;
      registerSafetyPassedFirstFrame(ctx.ownerId, url);
      return {
        firstFrameUrl: url,
        derived: true,
        attempts: 1,
        preflight: { ok: true, issues: [], score: 1, evidence: 'continuity-seam', checkedAt: Date.now() },
      };
    },
  });

  await ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' });

  assert.equal(maxActive, 1, '质量计划的首帧准备必须按镜序串行，不能与独立批次混用并发');
  assert.deepEqual(contexts.map((entry) => entry.shotIndex), [1, 2, 3, 4, 5, 6]);
  for (let index = 1; index < contexts.length; index += 1) {
    assert.equal(
      contexts[index].referenceKeyframeUrl,
      `https://public.example.com/derived-${shotIds[index - 1]}.png`,
      `第 ${index + 1} 镜必须以第 ${index} 镜的已验证首帧为连续性锚点`
    );
  }
  assert.equal(fake.capturedCalls.length, 6);
});

test('conditioned first-frame structure carries the approved semantic action and visual seam, not only a generic product close-up', () => {
  const structure = buildConditioningShotStructure(
    {
      shotIndex: 4,
      semanticPurpose: 'Show the product performing the visible cleaning action.',
      sourceAction: 'The nozzle moves left to right and leaves a continuous foam ribbon on ceramic.',
      cameraMovement: 'overhead tracking from the package to the foam trail',
      lighting: 'soft daylight from camera left',
      preState: 'The product has been introduced and the surface problem is visible.',
      postState: 'The foam action result remains visible for proof.',
      promptOverride: 'Visual continuity contract v1. Keep the same product, tabletop, light, and motion direction.',
      negativeConstraints: ['no person or hand', 'no new background'],
    },
    {
      fullVideoPlan: {
        visualContinuity: {
          visualBible: {
            productIdentity: 'exact supplied product package',
            setAndProps: 'same warm ceramic tabletop',
            lighting: 'soft side daylight',
            palette: 'green and warm neutral',
            cameraLanguage: 'controlled macro product cinematography',
            motionLanguage: 'continuous left-to-right action',
          },
          seams: [
            {
              fromShotIndex: 3,
              toShotIndex: 4,
              outgoingVisualState: 'solution is identified in the hero frame',
              incomingVisualState: 'the same product enters the use action',
              sharedAnchors: ['exact package', 'same tabletop'],
            },
            {
              fromShotIndex: 4,
              toShotIndex: 5,
              outgoingVisualState: 'foam ribbon remains visible',
              incomingVisualState: 'same foam evolves into clean proof',
              sharedAnchors: ['same foam trail', 'same ceramic'],
            },
          ],
        },
      },
    },
    'generic close-up'
  );
  assert.match(structure, /Required visible action:.*foam ribbon/i);
  assert.match(structure, /Incoming visual seam:.*same product enters/i);
  assert.match(structure, /Outgoing visual seam:.*foam ribbon remains/i);
  assert.match(structure, /Shared visual bible:.*same warm ceramic tabletop/i);
  assert.match(structure, /Negative constraints:.*no person or hand/i);
});

test('S3 能力门禁：provider 不支持多图条件生成 → product_conditioning_provider_unavailable', async () => {
  const { callImageGenerationGateway } = await import('../lib/llm-gateway.ts');
  // z-image-turbo（文本生图模型）不在 edits-capable 声明表 → 显式失败
  const res = await callImageGenerationGateway({
    prompt: 'test',
    modelId: 'Z-Image Turbo',
    referenceImages: ['https://public.example.com/product.png'],
  });
  assert.equal(res.success, false);
  assert.match(res.error || '', /product_conditioning_provider_unavailable/);

  // 深模块同样显式抛错（ImageConditioningUnavailableError；参考输入已声明为策略放行资产，
  // 因此通过 ReferenceInputPolicy 后由能力门禁拒绝）
  await assert.rejects(
    () =>
      createProductConditionedFirstFrame({
        referenceKeyframeUrl: 'https://public.example.com/kf-1.jpg',
        productAssetUrls: ['https://public.example.com/product.png'],
        productName: 'BUV',
        shotStructure: 'close-up',
        modelId: 'Z-Image Turbo',
        referencePolicy: {
          mode: 'semantic_recreation',
          images: [
            { id: 'anchor', url: 'https://public.example.com/kf-1.jpg', kind: 'owned_scene_anchor' },
            { id: 'product-0', url: 'https://public.example.com/product.png', kind: 'product_shot' },
          ],
        },
      }),
    (err: any) => err instanceof ImageConditioningUnavailableError
  );
});

test('S3 预检失败 → Seedance 0 次调用，镜头标记失败并返回可读原因', async () => {
  const fake = new FakeVideoPort();
  const ctrl: WorkflowController = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: async () => {
      throw new ShotFirstFrameError(
        'first_frame_preflight_failed',
        '第 1 镜首帧预检未通过（产品未出现；包装颜色不一致）。未调用视频生成 provider'
      );
    },
  });
  const { sessionId, shotIds } = setupSession({ shotCount: 1 });
  // P3 修复：全失败时 confirm 明确报错（不再 200 假成功），镜头仍标记失败并带可读原因
  await assert.rejects(
    () => ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' }),
    (err: any) => err?.code === 'all_shots_submission_failed' && err?.status === 502
  );

  assert.equal(fake.capturedCalls.length, 0, '预检失败时绝不能调用视频 provider');
  const shot = db.prepare('SELECT status, error_message FROM shot_generation_tasks WHERE id = ?').get(shotIds[0]) as any;
  assert.equal(shot.status, 'failed');
  assert.match(shot.error_message || '', /first_frame_preflight_failed/);
  assert.match(shot.error_message || '', /未调用视频生成 provider/);
});

test('S3 预检失败可重新生成（最多两次），仍失败才放弃', async () => {
  const { ensureShotFirstFrame: realEnsure } = await import('../lib/shot-first-frame.ts');
  let deriveCalls = 0;
  let preflightCalls = 0;
  const fakeDerive: any = async (input: any) => {
    deriveCalls += 1;
    registerSafetyPassedFirstFrame('ff-owner', `https://public.example.com/derived-${deriveCalls}.png`);
    return {
      imageUrl: `https://public.example.com/derived-${deriveCalls}.png`,
      localPath: `/uploads/renders/derived-${deriveCalls}.png`,
      provider: 'fake',
      model: 'gpt-image-1 (gpt-image-1)',
      provenance: { ...input, conditionedFirstFrameUrl: `https://public.example.com/derived-${deriveCalls}.png` },
      confidence: null,
      capability: { supported: true, mechanism: 'edits_multipart', modelId: null, modelCode: 'gpt-image-1', evidence: 'fake', probedAt: null },
    };
  };
  const fakePreflight: any = async () => {
    preflightCalls += 1;
    if (preflightCalls === 1) {
      return {
        ok: false,
        issues: [{ code: 'product_missing', message: '首帧中未出现产品', fixAction: '重新生成', fixKind: 'regenerate_first_frame' }],
        score: 0.2,
        evidence: 'fake',
        checkedAt: Date.now(),
      };
    }
    return { ok: true, issues: [], score: 0.95, evidence: 'fake', checkedAt: Date.now() };
  };
  const fakeDeriveWithLast: any = async (input: any) => {
    fakeDerive.lastInput = input;
    return fakeDerive(input);
  };
  const fake = new FakeVideoPort();
  const ctrl: WorkflowController = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: (ctx) =>
      realEnsure({ ...ctx, deriveFn: fakeDeriveWithLast, preflightFn: fakePreflight }),
  });
  const { sessionId } = setupSession({ shotCount: 1 });
  await ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' });
  assert.equal(deriveCalls, 2, '首次预检失败后应重新生成一次');
  assert.equal(preflightCalls, 2, '每次生成后都应预检');
  assert.equal(fake.capturedCalls.length, 1, '重生成成功后只提交一次');
  // 派生输入必须携带修复指导（product_missing → 视觉约束）
  assert.ok(
    (fakeDerive.lastInput?.visualConstraints ?? []).some((v: string) => v.includes('产品')),
    '重生成必须携带可执行的修复指导'
  );
});

test('S3 同镜头并发提交仍只有一次 provider 调用（原子 claim）', async () => {
  const fake = new FakeVideoPort();
  const ctrl: WorkflowController = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: okFirstFrameSeam(),
  });
  const { sessionId } = setupSession({ shotCount: 1 });
  const results = await Promise.allSettled([
    ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' }),
    ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' }),
    ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' }),
  ]);
  // 并发请求：一个成功提交，其余 409（无待提交镜头/占用）——绝不出现两次 provider 调用
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(fulfilled >= 1, '至少一个请求完成提交');
  assert.equal(fake.capturedCalls.length, 1, '并发提交同一镜头只能有一次 provider 调用');
});

test('S3 两镜受限并发提交：每镜恰好一次 provider 调用，不重复提交', async () => {
  const fake = new FakeVideoPort();
  const ctrl: WorkflowController = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: okFirstFrameSeam(),
  });
  const { sessionId } = setupSession({ shotCount: 2 });
  const results = await Promise.allSettled([
    ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' }),
    ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' }),
  ]);
  // 两镜并发：第一轮提交 2 镜（每镜一次）；重复请求 409 不产生额外 provider 调用
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(fulfilled >= 1);
  const shotIds = new Set(fake.capturedCalls.map((c) => c.shotId));
  assert.equal(fake.capturedCalls.length, 2, '两镜各一次提交');
  assert.equal(shotIds.size, 2, '不允许同一镜头重复提交');
});

test('S3 派生产物标记：derived_first_frame_url 与 first_frame_preflight_status 落库', async () => {
  const fake = new FakeVideoPort();
  const ctrl: WorkflowController = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: okFirstFrameSeam(),
  });
  const { sessionId, shotIds } = setupSession({ shotCount: 1 });
  await ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' });
  const row = db
    .prepare('SELECT first_frame_url, derived_first_frame_url, first_frame_preflight_status FROM shot_generation_tasks WHERE id = ?')
    .get(shotIds[0]) as any;
  assert.equal(row.first_frame_url, `https://public.example.com/derived-${shotIds[0]}.png`);
  assert.equal(row.derived_first_frame_url, row.first_frame_url, '首帧必须标记为派生资产');
  assert.equal(row.first_frame_preflight_status, 'passed');
});

test('S3：爆款关键帧只用于条件化首帧，不得透传给视频 provider', async () => {
  const fake = new FakeVideoPort();
  const ctrl: WorkflowController = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: okFirstFrameSeam(),
  });
  const { sessionId, shotIds } = setupSession({
    shotCount: 1,
    referenceKeyframes: ['https://public.example.com/viral-source-keyframe.jpg'],
  });

  await ctrl.confirm({ ownerId: 'ff-owner', sessionId, type: 'batch_submit' });

  assert.equal(fake.capturedCalls.length, 1);
  assert.equal(fake.capturedCalls[0].imageUrl, `https://public.example.com/derived-${shotIds[0]}.png`);
  assert.deepEqual(
    fake.capturedCalls[0].referenceImageUrls,
    [],
    '原爆款关键帧不得作为 reference_image 发送给付费视频 provider'
  );
});

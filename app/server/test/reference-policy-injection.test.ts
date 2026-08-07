/**
 * P5 审查修复 7：受控注入测试——三种方式尝试把原视频帧送进 provider 出口，
 * 全部必须被 ReferenceInputPolicy 拦截（/images/edits 与 Seedance body 都不会
 * 出现该 URL）；另含一条「runner → 最终 MP4 → sequence gate」受控集成路径
 * （真实 ffmpeg 抽帧 + 真实 gate 代码 + fake LLM，无服务器/无付费）。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, spawnSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReferencePolicyViolationError } from '../domain/reference-policy/reference-input-policy';
import {
  runSequenceSemanticGate,
  runDeterministicStructureChecks,
} from '../lib/sequence-semantic-gate';
import { createFullVideoPlan, validateFullVideoPlan } from '../lib/full-video-plan';
import { buildSemanticStoryboard } from '../lib/semantic-storyboard';
import { ownedAnchorDeclaration, productShotDeclaration } from '../adapters/reference-policy-guard';

const here = path.dirname(fileURLToPath(import.meta.url));

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-ref-policy-injection-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
// 注意：db 及触达 db 链的模块必须动态 import——静态 import 会在 env 设置前
// 求值 db.ts，把 DATA_DIR 固化为仓库 ./data（单文件运行时读到历史数据）。
const { initDatabase, db } = await import('../lib/db');
const { ensureShotFirstFrame, shotFirstFrameContextFromDraft } = await import('../lib/shot-first-frame');
const { buildSubmissionReferenceMaterials } = await import('../lib/video-submission-port');
const { resolveConditioningReferenceImages } = await import('../lib/product-conditioned-frame');
initDatabase();

const FIXTURE_MP4 = path.resolve(here, '../../e2e/fixtures/quality-loop-source.mp4');

const RAW_KEYFRAME = 'https://raw.example/source-keyframe-face.jpg';
const PRODUCT_IMG = 'https://assets.example.com/buv-pack.png';
const SAFE_ANCHOR = 'https://assets.example.com/owned-anchor.jpg';

before(() => {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES ('owner-1', 'owner-1', 'unused', 'operator')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO products (id, name, positioning, price, revision)
     VALUES ('inj-product', 'BUV 注入测试', 'test', '49', 1)`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO product_assets (id, product_id, role, url, owner_id, safety_status, safety_evidence, safety_version, sha256)
     VALUES ('inj-product-1', 'inj-product', 'hero', ?, 'owner-1', 'pass', '{"face":false,"overlay":false,"watermark":false}', 'v2', ?)`
  ).run(PRODUCT_IMG, 'c'.repeat(64));
});

after(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

const okPreflight = async () => ({ ok: true, issues: [], score: 1, evidence: 'injection-fake', checkedAt: Date.now() });

function fakeDeriveSpy(calls: { count: number; lastInput?: any }) {
  return async (input: any) => {
    calls.count += 1;
    calls.lastInput = input;
    return {
      imageUrl: 'https://assets.example.com/derived.png',
      localPath: '/uploads/renders/derived.png',
      provider: 'fake',
      model: 'gpt-image-1',
      provenance: { ...input, conditionedFirstFrameUrl: 'https://assets.example.com/derived.png' },
      confidence: null,
      capability: { supported: true, mechanism: 'edits_multipart', modelId: null, modelCode: 'gpt-image-1', evidence: 'inj', probedAt: null },
    };
  };
}

// ==================== 注入方式 1：草稿自报 semantic_replacement + 原视频帧锚点 ====================

test('注入1：草稿自报标签不能放行原视频帧——context 声明失效，guard 拒绝且 0 次派生', async () => {
  const ctx = shotFirstFrameContextFromDraft({
    ownerId: 'owner-1',
    runId: 'run-inj-1',
    shot: { id: 'shot-inj-1', session_id: 'sess-inj-1', shot_index: 1, reference_keyframe_url: RAW_KEYFRAME },
    draft: {
      productName: 'BUV',
      productAssetUrls: [PRODUCT_IMG],
      referenceKeyframes: [RAW_KEYFRAME],
      shots: [
        {
          shotIndex: 1,
          // 攻击面：自报 semantic_replacement + 原视频帧 URL 作为 continuityAnchor
          referencePolicy: 'semantic_replacement',
          referenceKeyframeUrl: null,
          continuityAnchorUrl: RAW_KEYFRAME,
        },
      ],
    },
  });
  assert.equal(ctx.referenceKeyframeUrl, RAW_KEYFRAME);
  const calls = { count: 0 };
  await assert.rejects(
    () =>
      ensureShotFirstFrame({
        ...ctx,
        deriveFn: fakeDeriveSpy(calls) as any,
        preflightFn: okPreflight,
      }),
    (error: unknown) =>
      error instanceof ReferencePolicyViolationError && error.code === 'source_keyframe_to_provider'
  );
  assert.equal(calls.count, 0, '策略违规时不得发起任何派生/付费调用');
});

// ==================== 注入方式 2：旧任务 first_frame 复用原视频帧 ====================

test('注入2：旧任务里的原视频帧 first_frame 不能复用——provenance 核验拒绝', async () => {
  // 模拟历史数据：shot.first_frame_url 指向原视频帧（conditioned_first_frames 无记录）
  const shotId = 'shot-inj-2';
  db.prepare(
    `INSERT OR IGNORE INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, first_frame_url, video_prompt)
     VALUES (?, 'sess-inj-2', 'owner-1', 1, 'pending', ?, 'prompt')`
  ).run(shotId, RAW_KEYFRAME);
  const ctx = shotFirstFrameContextFromDraft({
    ownerId: 'owner-1',
    runId: 'run-inj-2',
    shot: { id: shotId, session_id: 'sess-inj-2', shot_index: 1, first_frame_url: RAW_KEYFRAME },
    draft: {
      productName: 'BUV',
      productAssetUrls: [PRODUCT_IMG],
      referenceKeyframes: [],
      shots: [{ shotIndex: 1, referencePolicy: 'semantic_replacement', continuityAnchorUrl: PRODUCT_IMG }],
    },
  });
  assert.equal(ctx.existingFirstFrameUrl, RAW_KEYFRAME);
  const calls = { count: 0 };
  await assert.rejects(
    () =>
      ensureShotFirstFrame({
        ...ctx,
        deriveFn: fakeDeriveSpy(calls) as any,
        preflightFn: okPreflight,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as any).code === 'first_frame_reuse_not_verifiable'
  );
  assert.equal(calls.count, 0);
});

// ==================== 注入方式 3：声明安全图、实际发送原视频帧（错配） ====================

test('注入3：声明/URL 错配被拒——声明安全图 + 发送原视频帧 → 不进入 Seedance body', () => {
  assert.throws(
    () =>
      buildSubmissionReferenceMaterials({
        referenceImageUrls: [RAW_KEYFRAME],
        referencePolicy: {
          mode: 'semantic_recreation',
          images: [ownedAnchorDeclaration(SAFE_ANCHOR)],
        },
      }),
    (error: unknown) =>
      error instanceof ReferencePolicyViolationError && /不一致（错配）/.test(error.message)
  );
  // 同组 URL 才放行，且发送的就是被校验的那组
  const materials = buildSubmissionReferenceMaterials({
    referenceImageUrls: [SAFE_ANCHOR],
    referencePolicy: {
      mode: 'semantic_recreation',
      images: [ownedAnchorDeclaration(SAFE_ANCHOR)],
    },
  });
  assert.deepEqual(materials.map((m) => m.url), [SAFE_ANCHOR]);
  assert.ok(!materials.some((m) => m.url === RAW_KEYFRAME));
});

test('注入3b：条件化首帧出口声明即发送——未声明的原帧 URL 不会进入 payload', () => {
  // 调用方声明产品图、传了原帧 URL 作 referenceKeyframeUrl：payload 从声明构建，
  // 原帧 URL 绝不进入 /images/edits 参考图列表。
  const payload = resolveConditioningReferenceImages({
    referenceKeyframeUrl: RAW_KEYFRAME,
    productAssetUrls: [PRODUCT_IMG],
    referencePolicy: {
      mode: 'semantic_recreation',
      images: [productShotDeclaration(PRODUCT_IMG)],
    },
  });
  assert.deepEqual(payload, [PRODUCT_IMG]);
  assert.ok(!payload.includes(RAW_KEYFRAME), '原视频帧绝不能进入条件化首帧 payload');
});

// ==================== 受控集成：runner → 最终 MP4 → sequence gate（真实 ffmpeg 抽帧） ====================

import { spawnSync } from 'node:child_process';

function hasFfmpeg(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}

test('受控集成：fixture MP4 → 真实帧提取 → 序列语义门禁（fake LLM，零付费）', async (t) => {
  if (!existsSync(FIXTURE_MP4)) {
    t.skip(`缺少 fixture: ${FIXTURE_MP4}`);
    return;
  }
  if (!hasFfmpeg()) {
    t.skip('本地无 ffmpeg，跳过真实抽帧路径');
    return;
  }
  // fixture 只有 2s，而 plan 节点帧在 2.5-22.5s：用 ffmpeg 循环生成 30s 临时视频，
  // 走【真实默认帧提取器】的抽帧路径（这正是 runner 成片 → sequence gate 的受控执行）。
  const looped = path.join(tempRoot, 'looped-30s.mp4');
  const loop = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-stream_loop', '14', '-i', FIXTURE_MP4, '-t', '30', '-c', 'copy', looped],
    { timeout: 60_000 }
  );
  if (!existsSync(looped)) {
    t.skip(`无法生成 30s 测试视频：${loop.stderr?.toString().slice(0, 200)}`);
    return;
  }
  const segments = Array.from({ length: 6 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 }));
  const storyboard = buildSemanticStoryboard({ productName: 'BUV', segments });
  const plan = createFullVideoPlan({
    productName: 'BUV',
    targetDurationSec: 30,
    safeReferenceSegments: segments,
    semanticStoryboard: storyboard,
  });
  assert.deepEqual(validateFullVideoPlan(plan), []);
  const structure = runDeterministicStructureChecks(plan);
  assert.ok(!structure.some((c) => c.verdict === 'fail'), '结构层必须通过');

  const gate = await runSequenceSemanticGate({
    plan,
    finalVideoUrl: looped,
    uploadsRoot: process.env.UPLOADS_DIR || path.join(tempRoot, 'uploads'),
    llm: async () => ({
      success: true,
      data: {
        checks: [
          { id: 'story_order', verdict: 'pass', evidence: ['顺序一致'], reason: 'ok' },
          { id: 'causal_handoff', verdict: 'pass', evidence: ['承接可见'], reason: 'ok' },
          { id: 'product_entry_timing', verdict: 'pass', evidence: ['产品进入可见'], reason: 'ok' },
          { id: 'cta_closure', verdict: 'pass', evidence: ['收尾干净'], reason: 'ok' },
          { id: 'no_filler_shot', verdict: 'pass', evidence: ['无装饰镜头'], reason: 'ok' },
          { id: 'visual_continuity', verdict: 'pass', evidence: ['相邻剪辑点的产品、台面、光线和结果连续'], reason: 'ok' },
        ],
      },
    }),
  });
  // 真实 ffmpeg 抽帧成功 → 有画面证据 → gate 判定 pass（不是 unverified）
  assert.ok(gate.sampledFrames.length > 0, `fixture 应抽出节点帧（实际 ${gate.sampledFrames.length}）`);
  assert.equal(gate.status, 'pass');
  assert.equal(gate.fallback, false);
});

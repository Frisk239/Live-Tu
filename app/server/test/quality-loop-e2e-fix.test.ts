/**
 * quality-loop E2E 修复回归测试（P3 质量闭环 + P5 首帧可信来源收紧）：
 *
 * 1. FAKE_VISUAL_SAFETY_PASS 必须 hash 绑定——有 SHA-256 才给 pass，
 *    无 hash 的裸 URL 保持 unverified（绝不因测试环境放宽任意 URL 判决）；
 * 2. FAKE_FIRST_FRAME_DERIVE 派生首帧必须走真实 provenance/安全登记链路
 *    （conditioned_first_frames 行 + safety pass + 本地文件 hash 一致性）；
 * 3. confirm(batch_submit) 全部镜头失败时不再 200 假成功——抛
 *    all_shots_submission_failed（前端能展示原因，UI 不再轮询黑洞）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { MaterialCheck, ShotPlanShot } from '../../shared/workbench-contract';
import type { FakeVideoPort } from '../lib/video-submission-port';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-ql-fix-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.ALLOW_MOCK_FALLBACK = 'true';
delete process.env.YUNWU_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.SEEDANCE_BASE_URL;
delete process.env.SEEDANCE_ACCOUNT;
delete process.env.SEEDANCE_PASSWORD;
delete process.env.FAKE_VISUAL_SAFETY_PASS;
delete process.env.FAKE_FIRST_FRAME_DERIVE;

const { initDatabase, db } = await import('../lib/db.ts');
initDatabase();
const {
  evaluateVisualSafety,
  requireVisualSafetyPass,
} = await import('../lib/visual-safety.ts');
const { createProductConditionedFirstFrame } = await import('../lib/product-conditioned-frame.ts');
const { ShotFirstFrameError } = await import('../lib/shot-first-frame.ts');
const { WorkflowController, WorkflowError } = await import('../lib/workflow-controller.ts');
const { FakeVideoPort } = await import('../lib/video-submission-port.ts');

const OWNER = 'ql-fix-owner';
const PRODUCT_URL = '/uploads/materials/hero.png';

const okProbe = async (url: string, kind: MaterialCheck['kind']): Promise<MaterialCheck> => ({
  kind,
  url,
  ok: true,
  status: 'verified',
  detail: '存在',
});

function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

before(() => {
  initDatabase();
  db.prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'operator')`).run(OWNER, OWNER);
  db.prepare('INSERT OR IGNORE INTO products (id, name, positioning, price) VALUES (?, ?, ?, ?)').run(
    'prod-ql-fix',
    'QL 回归产品',
    '卖点',
    '¥99'
  );
});

after(() => {
  delete process.env.FAKE_VISUAL_SAFETY_PASS;
  delete process.env.FAKE_FIRST_FRAME_DERIVE;
  try {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

// ==================== 1. FAKE_VISUAL_SAFETY_PASS hash 绑定 ====================

test('FAKE_VISUAL_SAFETY_PASS：有 SHA-256 才 pass，无 hash 保持 unverified（hash 绑定不破）', async () => {
  process.env.FAKE_VISUAL_SAFETY_PASS = 'true';
  try {
    const withHash = await evaluateVisualSafety('https://assets.example.test/a.png', { sha256: 'd'.repeat(64) });
    assert.equal(withHash.status, 'pass');
    assert.equal(withHash.sha256, 'd'.repeat(64));
    assert.ok(withHash.evidence.includes('FAKE_VISUAL_SAFETY_PASS'), '证据必须标注 E2E 确定性通道');

    // 无本地摘要的裸 URL：即使 fake 通道开启也必须 unverified（hash 绑定不可满足）
    const noHash = await evaluateVisualSafety('https://assets.example.test/b.png', {});
    assert.equal(noHash.status, 'unverified');
  } finally {
    delete process.env.FAKE_VISUAL_SAFETY_PASS;
  }
});

test('FAKE_VISUAL_SAFETY_PASS 关闭时行为不变（LLM 不可用 → unverified）', async () => {
  const assessment = await evaluateVisualSafety('https://assets.example.test/c.png', { sha256: 'e'.repeat(64) });
  assert.equal(assessment.status, 'unverified', '无 LLM key 且未开 fake 通道 → 拒绝（不假装安全）');
});

// ==================== 2. FAKE_FIRST_FRAME_DERIVE 真实登记链路 ====================

test('FAKE_FIRST_FRAME_DERIVE：确定性派生走真实 provenance + hash 绑定 safety 登记', async () => {
  process.env.FAKE_VISUAL_SAFETY_PASS = 'true';
  process.env.FAKE_FIRST_FRAME_DERIVE = 'true';
  try {
    // 产品图真实字节 + product_assets 行（safety 由评估登记为 pass）
    const heroBytes = Buffer.from('fake-hero-image-bytes-for-hash-binding');
    const heroDir = path.join(process.env.UPLOADS_DIR!, 'materials');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(heroDir, { recursive: true });
    const heroPath = path.join(heroDir, 'hero.png');
    writeFileSync(heroPath, heroBytes);
    const heroHash = sha256Of(heroBytes);
    db.prepare(
      `INSERT OR IGNORE INTO product_assets (id, product_id, role, url, file_path, owner_id)
       VALUES (?, ?, 'hero', ?, ?, ?)`
    ).run('pa-ql-fix', 'prod-ql-fix', PRODUCT_URL, 'uploads/materials/hero.png', OWNER);
    // 登记 hash 绑定的 pass（模拟 attach 时评估已通过；hash 必须等于真实字节）
    db.prepare(
      `UPDATE product_assets
          SET safety_status = 'pass', safety_evidence = '{"face":false,"overlay":false,"watermark":false}',
              safety_version = 'v2', sha256 = ?
        WHERE owner_id = ? AND url = ?`
    ).run(heroHash, OWNER, PRODUCT_URL);

    const result = await createProductConditionedFirstFrame({
      referenceKeyframeUrl: PRODUCT_URL,
      productAssetUrls: [PRODUCT_URL],
      productName: 'QL 回归产品',
      shotStructure: 'close-up · push-in · product packaging',
      referencePolicy: {
        mode: 'semantic_recreation',
        images: [
          { id: 'conditioning-anchor', url: PRODUCT_URL, kind: 'product_shot' },
          { id: 'product-0', url: PRODUCT_URL, kind: 'product_shot' },
        ],
      },
      persist: {
        ownerId: OWNER,
        runId: 'run-ql-fix',
        sessionId: 'sess-ql-fix',
        shotId: 'shot-ql-fix',
        referenceVideoUrl: null,
      },
    });

    assert.ok(result.imageUrl.startsWith('/uploads/renders/'), `条件化首帧必须本地登记：${result.imageUrl}`);
    assert.ok(result.provider.includes('fake'), 'provider 必须明确标注 fake 通道');
    // provenance 登记真实落库 + safety pass + hash 与本地文件一致
    const row = db.prepare(
      `SELECT conditioned_first_frame_url, safety_status, sha256, local_path
         FROM conditioned_first_frames WHERE owner_id = ? AND conditioned_first_frame_url = ?`
    ).get(OWNER, result.imageUrl) as any;
    assert.ok(row, 'conditioned_first_frames 必须有登记行');
    assert.equal(row.safety_status, 'pass');
    assert.equal(row.sha256, heroHash, '登记的 sha256 必须绑定真实文件字节');
    const onDisk = await import('node:fs');
    assert.ok(onDisk.existsSync(row.local_path), '本地产物必须存在');
    // 提交边界强制仍生效：pass + sha256 + 本地 hash 一致性（此处置为不抛错）
    requireVisualSafetyPass(OWNER, result.imageUrl, 'conditioned-first-frame');
  } finally {
    delete process.env.FAKE_VISUAL_SAFETY_PASS;
    delete process.env.FAKE_FIRST_FRAME_DERIVE;
  }
});

test('FAKE_FIRST_FRAME_DERIVE：产品图无本地文件 → 显式失败（hash 绑定不可满足）', async () => {
  process.env.FAKE_FIRST_FRAME_DERIVE = 'true';
  try {
    const remoteUrl = 'https://cdn.example.com/remote-hero.jpg';
    db.prepare(
      `INSERT OR IGNORE INTO product_assets (id, product_id, role, url, owner_id)
       VALUES (?, ?, 'hero', ?, ?)`
    ).run('pa-ql-remote', 'prod-ql-fix', remoteUrl, OWNER);
    await assert.rejects(
      () =>
        createProductConditionedFirstFrame({
          referenceKeyframeUrl: remoteUrl,
          productAssetUrls: [remoteUrl],
          productName: 'QL 回归产品',
          shotStructure: 'close-up',
          referencePolicy: {
            mode: 'semantic_recreation',
            images: [
              { id: 'conditioning-anchor', url: remoteUrl, kind: 'product_shot' },
              { id: 'product-0', url: remoteUrl, kind: 'product_shot' },
            ],
          },
          persist: { ownerId: OWNER, runId: 'r', sessionId: 's', shotId: 'shot', referenceVideoUrl: null },
        }),
      (error: any) =>
        error?.code === 'first_frame_derivation_context_missing' ||
        error?.code === 'asset_safety_not_passed'
    );
  } finally {
    delete process.env.FAKE_FIRST_FRAME_DERIVE;
  }
});

// ==================== 3. confirm 全失败 → 明确报错 ====================

function makeShot(shotIndex: number): ShotPlanShot {
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
  };
}

function insertShot(opts: { id: string; sessionId: string; shotIndex: number; status: string }) {
  db.prepare(
    `INSERT INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_prompt)
     VALUES (?, ?, ?, ?, ?, 'product close-up')`
  ).run(opts.id, opts.sessionId, OWNER, opts.shotIndex, opts.status);
}

test('confirm(batch_submit)：全部镜头失败 → all_shots_submission_failed，不再 200 假成功', async () => {
  const fake = new FakeVideoPort();
  const ctrl = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    // 模拟 P5 拒绝：首帧复用不可核验（fixture 过期场景）
    ensureFirstFrameFn: async (ctx) => {
      throw new ShotFirstFrameError(
        'first_frame_reuse_not_verifiable',
        `第 ${ctx.shotIndex} 镜的已有首帧无法核验为本系统派生的条件化首帧`
      );
    },
  });
  const sessionId = 'sess-ql-all-fail';
  insertShot({ id: `${sessionId}-1`, sessionId, shotIndex: 1, status: 'pending' });
  insertShot({ id: `${sessionId}-2`, sessionId, shotIndex: 2, status: 'pending' });
  const draftJson = JSON.stringify({
    shots: [makeShot(1), makeShot(2)],
    videoModelId: 'Seedance 2.0 Fast',
    referenceInputCount: 1,
    productId: 'prod-ql-fix',
    referenceKeyframes: [PRODUCT_URL],
  });
  ctrl.saveDraft({ ownerId: OWNER, sessionId, draftJson });
  ctrl.setPaidAuthorization({ ownerId: OWNER, sessionId, enabled: true });

  await assert.rejects(
    () => ctrl.confirm({ ownerId: OWNER, sessionId, type: 'batch_submit' }),
    (error: WorkflowError) =>
      error.code === 'all_shots_submission_failed' &&
      error.status === 502 &&
      error.message.includes('first_frame_reuse_not_verifiable')
  );
  // 零 provider 调用（失败发生在付费边界之前）
  assert.equal(fake.capturedCalls.length, 0);
  // 未写入 batch_submit 确认（不会留下假成功状态）
  const state = ctrl.getState({ ownerId: OWNER, sessionId });
  assert.equal(state.confirms.batch_submit, false);
  // 镜头明确标失败（可读原因，UI 可展示）
  const rows = db.prepare('SELECT status, error_message FROM shot_generation_tasks WHERE session_id = ?').all(sessionId) as any[];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'failed'));
  assert.ok(rows.every((r) => String(r.error_message).includes('first_frame_reuse_not_verifiable')));
});

test('confirm(batch_submit)：部分失败返回每镜 results 明细，成功镜头不受影响', async () => {
  const { registerSafetyPassedFirstFrame } = await import('./_helpers.ts');
  const fake = new FakeVideoPort();
  const ctrl = new WorkflowController({
    port: fake,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: async (ctx) => {
      if (ctx.shotIndex === 2) {
        throw new ShotFirstFrameError('first_frame_preflight_failed', '第 2 镜首帧预检未通过');
      }
      const url = `https://public.example.com/derived-${ctx.shotId}.png`;
      registerSafetyPassedFirstFrame(OWNER, url);
      return {
        firstFrameUrl: url,
        derived: true,
        attempts: 1,
        preflight: { ok: true, issues: [], score: 1, evidence: 'fake-seam', checkedAt: Date.now() },
      };
    },
  });
  const sessionId = 'sess-ql-partial';
  insertShot({ id: `${sessionId}-1`, sessionId, shotIndex: 1, status: 'pending' });
  insertShot({ id: `${sessionId}-2`, sessionId, shotIndex: 2, status: 'pending' });
  ctrl.saveDraft({
    ownerId: OWNER,
    sessionId,
    draftJson: JSON.stringify({
      shots: [makeShot(1), makeShot(2)],
      videoModelId: 'Seedance 2.0 Fast',
      referenceInputCount: 1,
      productId: 'prod-ql-fix',
      referenceKeyframes: [PRODUCT_URL],
    }),
  });
  ctrl.setPaidAuthorization({ ownerId: OWNER, sessionId, enabled: true });

  const result = await ctrl.confirm({ ownerId: OWNER, sessionId, type: 'batch_submit' });
  assert.equal(result.confirmed, true);
  assert.equal(result.submittedCount, 1);
  assert.ok(Array.isArray(result.results), 'confirm 必须返回每镜提交明细');
  const byIndex = Object.fromEntries((result.results ?? []).map((r) => [r.shotIndex, r]));
  assert.equal(byIndex['1'].submitted, true);
  assert.equal(byIndex['2'].submitted, false);
  assert.ok(byIndex['2'].reason?.includes('first_frame_preflight_failed'));
  // 成功镜头完成、失败镜头标失败
  const rows = db.prepare('SELECT shot_index, status FROM shot_generation_tasks WHERE session_id = ? ORDER BY shot_index').all(sessionId) as any[];
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[1].status, 'failed');
});

// ==================== 4. runFixLoop 幂等短路回归 ====================

test('runFixLoop 重置 pending 时必须清空旧 seedance_task_id（fix 重生成不被幂等短路）', async () => {
  const { ShotQaController } = await import('../lib/shot-qa-controller.ts');
  const shotId = 'shot-ql-fixloop';
  const sessionId = 'sess-ql-fixloop';
  db.prepare(
    `INSERT OR IGNORE INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_prompt, seedance_task_id, video_url, qa_status)
     VALUES (?, ?, ?, 1, 'completed', 'original prompt', 'fake-task-v1', 'http://fake.local/v1.mp4', 'fail')`
  ).run(shotId, sessionId, OWNER);
  db.prepare(
    `INSERT INTO shot_qa_reports (id, shot_id, run_id, version, owner_id, report_json, tech_status, semantic_status, overall_verdict, checked_at)
     VALUES (?, ?, ?, 1, ?, ?, 'verified', 'fail', 'fail', ?)`
  ).run(
    `qa-${shotId}-1`,
    shotId,
    sessionId,
    OWNER,
    JSON.stringify({
      semantic: {
        issues: [
          {
            verdict: 'fail',
            dimension: 'hook_quality',
            reason: '开头钩子不抓人',
            fix: { dimension: 'hook_quality', action: '重写开场钩子', promptFragment: 'stronger opening hook' },
          },
        ],
      },
      tech: { status: 'verified' },
    }),
    Date.now()
  );

  const ctrl = new ShotQaController();
  const result = await ctrl.runFixLoop(OWNER, { runId: sessionId, shotId });
  assert.equal(result.action, 'regenerated');
  // 关键断言：重置为 pending 时旧任务 id / 视频必须清空，
  // 否则 claimAndSubmitCheckedShot 幂等判定会把重新生成短路成「已提交过」
  const row = db.prepare(
    'SELECT status, seedance_task_id, video_url FROM shot_generation_tasks WHERE id = ?'
  ).get(shotId) as any;
  assert.equal(row.status, 'pending');
  assert.equal(row.seedance_task_id, null, 'fix 重置必须清空旧 seedance_task_id');
  assert.equal(row.video_url, null, 'fix 重置必须清空旧 video_url');
});

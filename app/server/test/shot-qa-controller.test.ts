/**
 * P3 shot-qa-controller 测试（临时 DB + FakeSemanticQaScorer 确定性 seam）：
 * - runShotQa：技术 QA + 语义 QA → 报告持久化 + shot qa_status 更新；
 * - runFixLoop：不合格镜头自动修复（最多 2 次）、已成功镜头不重提、
 *   修复记录进入成本账本（failure_reason= semantic_fix:*）；
 * - manualPass：人工通过后 qa_status=pass；
 * - useVersion：版本选择切换 video_url；
 * - 服务重启（新控制器实例）后 QA/版本状态恢复。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { ShotQaController, QaControllerError } from '../lib/shot-qa-controller';
import { FakeSemanticQaScorer } from '../lib/semantic-qa';
import type { FakeVideoPort } from '../lib/video-submission-port';
import { registerSafetyPassedFirstFrame } from './_helpers';

// 模块级单例 DB
const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-shot-qa-test-'));
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

const { initDatabase, db } = await import('../lib/db.ts');
initDatabase();

const { WorkflowController } = await import('../lib/workflow-controller.ts');
const { FakeVideoPort, resetVideoSubmissionPort } = await import('../lib/video-submission-port.ts');

before(() => {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, ?)`
  ).run('qa-owner', 'qa-owner', 'unused', 'operator');
});

after(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

/** 确定性技术 QA（fake seam）：始终 verified */
const okTechQa = async (url: string) => ({
  status: 'verified' as const,
  ok: true,
  checks: [
    { name: 'video_stream', ok: true, status: 'passed' as const, detail: 'codec=h264' },
    { name: 'duration', ok: true, status: 'passed' as const, detail: '5.00s' },
    { name: 'resolution', ok: true, status: 'passed' as const, detail: '720x1280' },
    { name: 'audio_track', ok: true, status: 'passed' as const, detail: 'codec=aac; 5.00s' },
    { name: 'av_sync', ok: true, status: 'passed' as const, detail: 'audio/video duration delta 0.000s; start delta 0.000s' },
    { name: 'black_frame', ok: true, status: 'passed' as const, detail: '黑帧占比 0.0%' },
  ],
});

/** 创建一个已完成状态的镜头任务（模拟真实生成完成） */
function createCompletedShot(opts: {
  sessionId: string;
  shotIndex: number;
  videoUrl?: string;
  ownerId?: string;
  prompt?: string;
}): string {
  const ownerId = opts.ownerId || 'qa-owner';
  const shotId = `shot-${opts.sessionId}-${opts.shotIndex}-${Date.now()}`;
  const videoUrl = opts.videoUrl || `/uploads/renders/${shotId}.mp4`;
  db.prepare(
    `INSERT INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_url, video_prompt, qa_status, current_version)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, 'pending', 1)`
  ).run(
    shotId,
    opts.sessionId,
    ownerId,
    opts.shotIndex,
    videoUrl,
    opts.prompt || 'product close-up'
  );
  // 版本 1 记录（与生产 confirmBatchSubmit/retryShot 一致）
  db.prepare(
    `INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, prompt, status)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'completed')`
  ).run(`sv-${shotId}-v1-${Date.now()}`, shotId, 'run-x', ownerId, videoUrl, opts.prompt || 'product close-up');
  return shotId;
}

test('runShotQa: 完成镜头执行 QA → 报告持久化 + qa_status 更新', async () => {
  const sessionId = `qa-sess-${Date.now()}`;
  const shotId = createCompletedShot({ sessionId, shotIndex: 1 });
  const scorer = new FakeSemanticQaScorer({ seed: 42 });
  const controller = new ShotQaController({ semanticScorer: scorer, techQaFn: okTechQa });

  const result = await controller.runShotQa('qa-owner', { runId: 'run-x', shotId });

  assert.equal(result.shotId, shotId);
  assert.equal(result.overallVerdict, 'pass');
  assert.ok(result.reportId.startsWith('qa-'));

  // 报告已持久化
  const report = db.prepare('SELECT * FROM shot_qa_reports WHERE id = ?').get(result.reportId) as any;
  assert.ok(report);
  assert.equal(report.overall_verdict, 'pass');

  // shot qa_status 已更新
  const shot = db.prepare('SELECT qa_status FROM shot_generation_tasks WHERE id = ?').get(shotId) as any;
  assert.equal(shot.qa_status, 'pass');
});

test('runShotQa: 图像模型无法判断 AV sync 时，以 ffprobe 时间轴证据闭环', async () => {
  const sessionId = `qa-sess-av-sync-${Date.now()}`;
  const shotId = createCompletedShot({ sessionId, shotIndex: 1 });
  const scorer = new FakeSemanticQaScorer({ seed: 42, forceUnverified: ['av_sync'] });
  const controller = new ShotQaController({ semanticScorer: scorer, techQaFn: okTechQa });

  const result = await controller.runShotQa('qa-owner', { runId: 'run-av-sync', shotId });

  assert.equal(result.overallVerdict, 'pass', 'ffprobe 已验证的流时间轴应解除图像输入造成的 av_sync 未验证');
  const report = db.prepare('SELECT report_json FROM shot_qa_reports WHERE id = ?').get(result.reportId) as any;
  const saved = JSON.parse(report.report_json);
  const avSync = saved.semantic.issues.find((issue: any) => issue.dimension === 'av_sync');
  assert.equal(avSync.verdict, 'pass');
  assert.ok(avSync.evidence.some((item: any) => item.source === 'ffprobe'));
  const audioGate = saved.semantic.scorecard.hardGates.find((gate: any) => gate.dimension === 'audio_track');
  assert.equal(audioGate.status, 'passed', '真实技术 QA 证据必须进入评分卡硬门禁');
  assert.equal(
    new Set(saved.semantic.scorecard.dimensions.map((dimension: any) => dimension.id)).size,
    saved.semantic.scorecard.dimensions.length,
    '合并技术评分后不得出现重复维度'
  );
});

test('runShotQa: 非 completed 镜头拒绝 QA', async () => {
  const sessionId = `qa-sess-pending-${Date.now()}`;
  const pendingShotId = `shot-pending-${Date.now()}`;
  db.prepare(
    `INSERT INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, current_version)
     VALUES (?, ?, 'qa-owner', 1, 'pending', 1)`
  ).run(pendingShotId, sessionId);

  const controller = new ShotQaController({ semanticScorer: new FakeSemanticQaScorer(), techQaFn: okTechQa });
  await assert.rejects(
    () => controller.runShotQa('qa-owner', { runId: 'run-x', shotId: pendingShotId }),
    (err: any) => err instanceof QaControllerError && err.code === 'shot_not_completed'
  );
});

test('runFixLoop: 不合格镜头触发自动修复（1 次），重生成后创建新版本', async () => {
  const sessionId = `qa-sess-fix-${Date.now()}`;
  const shotId = createCompletedShot({ sessionId, shotIndex: 1, prompt: 'original prompt' });
  // 先执行 QA（forceFail product_consistency → 不合格）
  const scorer = new FakeSemanticQaScorer({ seed: 42, forceFail: ['product_consistency'] });
  const controller = new ShotQaController({ semanticScorer: scorer, techQaFn: okTechQa });
  await controller.runShotQa('qa-owner', { runId: 'run-fix', shotId });

  const result = await controller.runFixLoop('qa-owner', { runId: 'run-fix', shotId });

  assert.equal(result.action, 'regenerated');
  assert.equal(result.newVersion, 2);
  assert.equal(result.autoFixCount, 1);
  assert.ok(result.summary.includes('修复'));

  // prompt 已被修复增强 + 状态回到 pending（等待重新生成）
  const shot = db.prepare('SELECT video_prompt, status FROM shot_generation_tasks WHERE id = ?').get(shotId) as any;
  assert.ok(shot.video_prompt.includes('[修复增强]'));
  assert.equal(shot.status, 'pending', '修复后镜头进入待重新生成状态');

  // 重新生成（retryShot，与 /fix-shot 路由一致）→ 创建版本 2
  // （注入首帧保障 fake seam：本测试聚焦修复闭环，不触发真实派生/预检）
  const { WorkflowController } = await import('../lib/workflow-controller.ts');
  const wc = new WorkflowController({
    ensureFirstFrameFn: async (ctx) => {
      const url = ctx.existingFirstFrameUrl || `https://public.example.com/derived-${ctx.shotId}.png`;
      registerSafetyPassedFirstFrame(ctx.ownerId, url);
      return {
        firstFrameUrl: url,
        derived: !ctx.existingFirstFrameUrl,
        attempts: 1,
        preflight: { ok: true, issues: [], score: 1, evidence: 'fake-seam', checkedAt: Date.now() },
      };
    },
  });
  await wc.retryShot({
    ownerId: 'qa-owner',
    runId: 'run-fix',
    shotId,
    attempt: 1,
    failureReason: 'auto_fix_regenerate:测试修复',
  });
  const versions = controller.getShotVersions(shotId, 'qa-owner');
  assert.equal(versions.length, 2, '修复前 v1 + 修复后 v2');
  assert.equal(versions[1].version, 2);
  assert.ok(versions[1].videoUrl, 'v2 有实际产物 URL');

  // 修复成本记录（semantic_fix:*）
  const ledger = db.prepare(
    `SELECT failure_reason FROM cost_ledger WHERE shot_id = ? AND failure_reason LIKE 'semantic_fix:%'`
  ).all(shotId) as Array<{ failure_reason: string }>;
  assert.ok(ledger.length >= 1);
  assert.ok(ledger[0].failure_reason.includes('product_consistency'));
});

test('runFixLoop: 最多 2 次自动修复，之后需人工确认', async () => {
  const sessionId = `qa-sess-maxfix-${Date.now()}`;
  const shotId = createCompletedShot({ sessionId, shotIndex: 1 });
  const scorer = new FakeSemanticQaScorer({ seed: 42, forceFail: ['product_consistency'] });
  const controller = new ShotQaController({ semanticScorer: scorer, techQaFn: okTechQa });

  // 第 1 次修复
  await controller.runShotQa('qa-owner', { runId: 'run-max', shotId });
  const fix1 = await controller.runFixLoop('qa-owner', { runId: 'run-max', shotId });
  assert.equal(fix1.action, 'regenerated');

  // 第 2 次修复
  const fix2 = await controller.runFixLoop('qa-owner', { runId: 'run-max', shotId });
  assert.equal(fix2.action, 'regenerated');

  // 第 3 次 → 达到上限，需人工确认
  const fix3 = await controller.runFixLoop('qa-owner', { runId: 'run-max', shotId });
  assert.equal(fix3.action, 'max_fixes_reached');
  assert.ok(fix3.summary.includes('人工确认'));
});

test('manualPass: 人工通过后 qa_status=pass，版本保留', async () => {
  const sessionId = `qa-sess-manual-${Date.now()}`;
  const shotId = createCompletedShot({ sessionId, shotIndex: 1 });
  const scorer = new FakeSemanticQaScorer({ seed: 42, forceFail: ['product_consistency'] });
  const controller = new ShotQaController({ semanticScorer: scorer, techQaFn: okTechQa });
  await controller.runShotQa('qa-owner', { runId: 'run-manual', shotId });

  const result = controller.manualPass('qa-owner', { runId: 'run-manual', shotId, comment: '人工确认可用' });
  assert.equal(result.manualPassed, true);
  assert.equal(result.comment, '人工确认可用');

  const shot = db.prepare('SELECT qa_status FROM shot_generation_tasks WHERE id = ?').get(shotId) as any;
  assert.equal(shot.qa_status, 'pass');

  // 人工选择进入成本账本
  const manual = db.prepare('SELECT manual_choice FROM cost_ledger WHERE shot_id = ? AND manual_choice LIKE ?')
    .all(shotId, 'manual-pass:%') as Array<{ manual_choice: string }>;
  assert.ok(manual.length >= 1);
});

test('useVersion: 选择历史版本切换 video_url', async () => {
  const sessionId = `qa-sess-version-${Date.now()}`;
  const shotId = createCompletedShot({ sessionId, shotIndex: 1, videoUrl: '/uploads/renders/v1.mp4' });
  const controller = new ShotQaController({ semanticScorer: new FakeSemanticQaScorer(), techQaFn: okTechQa });

  // 创建第 2 版
  await controller.runShotQa('qa-owner', { runId: 'run-v', shotId });
  const fixResult = await controller.runFixLoop('qa-owner', { runId: 'run-v', shotId, skipAutoFix: true });
  // 手动插入一个历史版本
  db.prepare(
    `INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, status)
     VALUES (?, ?, 'run-v', 'qa-owner', 5, '/uploads/renders/v5-old.mp4', 'completed')`
  ).run(`sv-${shotId}-v5-${Date.now()}`, shotId);

  const versions = controller.getShotVersions(shotId, 'qa-owner');
  const v5 = versions.find((v) => v.version === 5);
  assert.ok(v5);

  const result = controller.useVersion('qa-owner', { runId: 'run-v', shotId, versionId: v5!.versionId });
  assert.equal(result.newVersion, 5);
  assert.equal(result.videoUrl, '/uploads/renders/v5-old.mp4');

  const shot = db.prepare('SELECT video_url, current_version FROM shot_generation_tasks WHERE id = ?').get(shotId) as any;
  assert.equal(shot.video_url, '/uploads/renders/v5-old.mp4');
  assert.equal(shot.current_version, 5);
});

test('useVersion: 版本回退恢复完整状态（prompt/QA 判决/展示关系，状态不漂移）', async () => {
  const sessionId = `qa-sess-drift-${Date.now()}`;
  const shotId = createCompletedShot({
    sessionId,
    shotIndex: 1,
    videoUrl: '/uploads/renders/v1.mp4',
    prompt: 'prompt-original',
  });
  const controller = new ShotQaController({ semanticScorer: new FakeSemanticQaScorer(), techQaFn: okTechQa });

  // 版本 1：QA fail（强制）→ 任务 qa_status=fail
  const failScorer = new FakeSemanticQaScorer({ forceFail: ['product_consistency'] });
  const cFail = new ShotQaController({ semanticScorer: failScorer, techQaFn: okTechQa });
  await cFail.runShotQa('qa-owner', { runId: 'run-drift', shotId });
  const shotAfterFail = db.prepare('SELECT qa_status, video_prompt, current_version FROM shot_generation_tasks WHERE id = ?').get(shotId) as any;
  assert.equal(shotAfterFail.qa_status, 'fail');

  // 版本 2：模拟真实重生成（retryShot/confirmBatchSubmit 行为）——创建版本 2 行 +
  // 更新 current_version/video_url/video_prompt，然后 QA pass
  await controller.runFixLoop('qa-owner', { runId: 'run-drift', shotId, skipAutoFix: true });
  db.prepare(
    `UPDATE shot_generation_tasks SET status = 'completed', video_url = '/uploads/renders/v2.mp4',
       video_prompt = 'prompt-original\n\n[修复增强] product fix', current_version = 2, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(shotId);
  db.prepare(
    `INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, prompt, model_code, status)
     VALUES (?, ?, 'run-drift', 'qa-owner', 2, '/uploads/renders/v2.mp4',
             'prompt-original\n\n[修复增强] product fix', 'doubao-seedance-2-0-fast', 'completed')`
  ).run(`sv-${shotId}-v2-${Date.now()}`, shotId);
  await controller.runShotQa('qa-owner', { runId: 'run-drift', shotId });
  const shotAfterPass = db.prepare('SELECT qa_status, video_prompt, current_version FROM shot_generation_tasks WHERE id = ?').get(shotId) as any;
  assert.equal(shotAfterPass.qa_status, 'pass');
  assert.equal(shotAfterPass.current_version, 2);

  // 版本 2 的 QA 报告应挂到版本 2（runShotQa 持久化 qa_report_id）
  const v2Row = db.prepare("SELECT qa_report_id FROM shot_versions WHERE shot_id = ? AND version = 2").get(shotId) as { qa_report_id: string | null };
  assert.ok(v2Row.qa_report_id, '版本 2 必须关联其 QA 报告');

  // 回退到版本 1：必须恢复 video_url、current_version、prompt、qa_status=fail
  const versions = controller.getShotVersions(shotId, 'qa-owner');
  const v1 = versions.find((v) => v.version === 1);
  assert.ok(v1);
  const result = controller.useVersion('qa-owner', { runId: 'run-drift', shotId, versionId: v1!.versionId });
  assert.equal(result.newVersion, 1);
  assert.equal(result.videoUrl, '/uploads/renders/v1.mp4');

  const shotAfterRollback = db.prepare(
    'SELECT video_url, current_version, video_prompt, qa_status FROM shot_generation_tasks WHERE id = ?'
  ).get(shotId) as any;
  assert.equal(shotAfterRollback.video_url, '/uploads/renders/v1.mp4');
  assert.equal(shotAfterRollback.current_version, 1);
  assert.equal(shotAfterRollback.video_prompt, 'prompt-original', '回退必须恢复该版本的 prompt');
  assert.equal(shotAfterRollback.qa_status, 'fail', '回退必须恢复该版本的 QA 判决');

  // 再次切回版本 2：qa_status 恢复 pass、video_prompt 恢复版本 2 的增强 prompt
  const v2 = versions.find((v) => v.version === 2);
  assert.ok(v2);
  controller.useVersion('qa-owner', { runId: 'run-drift', shotId, versionId: v2!.versionId });
  const shotBackToV2 = db.prepare(
    'SELECT video_url, current_version, video_prompt, qa_status FROM shot_generation_tasks WHERE id = ?'
  ).get(shotId) as any;
  assert.equal(shotBackToV2.video_url, '/uploads/renders/v2.mp4');
  assert.equal(shotBackToV2.current_version, 2);
  assert.equal(shotBackToV2.qa_status, 'pass', '切回版本 2 后 QA 判决必须恢复 pass');
  assert.ok(
    (shotBackToV2.video_prompt || '').includes('[修复增强]'),
    '切回版本 2 后 prompt 必须是版本 2 的增强 prompt'
  );
});

test('服务重启恢复: 新控制器实例在同一 DB 上恢复 QA/版本状态', async () => {
  const sessionId = `qa-sess-restart-${Date.now()}`;
  const shotId = createCompletedShot({ sessionId, shotIndex: 1 });
  const controllerA = new ShotQaController({ semanticScorer: new FakeSemanticQaScorer({ seed: 42 }), techQaFn: okTechQa });
  await controllerA.runShotQa('qa-owner', { runId: 'run-restart', shotId });

  // 模拟服务重启：新控制器实例
  const controllerB = new ShotQaController({ semanticScorer: new FakeSemanticQaScorer({ seed: 42 }), techQaFn: okTechQa });
  const versions = controllerB.getShotVersions(shotId, 'qa-owner');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);

  const report = db.prepare(
    'SELECT * FROM shot_qa_reports WHERE shot_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(shotId) as any;
  assert.ok(report);
  assert.equal(report.overall_verdict, 'pass');
  assert.equal(report.manual_passed, 0);
});

test('getShotVersions 与 WorkflowController 集成: getState 携带版本/QA 字段', async () => {
  const sessionId = `qa-sess-state-${Date.now()}`;
  const shotId = createCompletedShot({ sessionId, shotIndex: 1 });
  const controller = new ShotQaController({ semanticScorer: new FakeSemanticQaScorer({ seed: 42 }), techQaFn: okTechQa });
  await controller.runShotQa('qa-owner', { runId: 'run-state', shotId });

  // 通过 WorkflowController 读取 state
  const wc = new WorkflowController();
  const state = wc.getState({ ownerId: 'qa-owner', sessionId });
  const runtime = state.shotStates.find((s) => s.shotId === shotId);
  assert.ok(runtime);
  assert.equal(runtime?.currentVersion, 1);
  assert.equal(runtime?.semanticVerdict, 'pass');
  assert.ok(runtime?.versions.length >= 1);
  assert.equal(runtime?.qaSummary, '8 项全部通过');
});

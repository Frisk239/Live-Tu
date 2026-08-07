/**
 * S2 workflow-controller 集成测试（临时 DB + FakeVideoPort 确定性 seam）：
 * - 证据 #1：付费授权默认关闭；切换自主模式绝不暗中打开授权；
 * - 证据 #2：preflight 有 blocker 时不得提交 provider；
 * - 证据 #4（账本侧）：提交成本账目携带估算价（微美元精度）；
 * - 证据 #5：单镜失败只重试该镜，成功镜头不重新提交；
 * - 证据 #6：典型可恢复错误在 2 次重试动作内恢复；
 * - 证据 #7：刷新/服务端重启（新 controller 实例）后恢复 run/shot/SaveState；
 * - 证据 #8：保存失败（非法草稿）抛错阻断切换；
 * - 证据 #12：所有 provider 调用被 fake seam 捕获，无隐藏付费提交。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { MaterialCheck, ShotPlanShot } from '../../shared/workbench-contract';
import type { WorkflowError, WorkflowController } from '../lib/workflow-controller';
import type { FakeVideoPort } from '../lib/video-submission-port';


/** S3 首帧保障 fake seam：直接复用已有候选首帧/派生 URL，预检恒通过（零真实调用） */
function makeCtrl(port: FakeVideoPort): WorkflowController {
  return new WorkflowController({
    port,
    preflightDeps: { materialProbe: okProbe },
    ensureFirstFrameFn: async (ctx) => {
      // P5 三轮：派生 seam 同时登记服务端视觉安全核验结果（提交边界要求 pass）
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
}

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
    candidates: [{ id: `cand-${shotIndex}`, url: '/uploads/frame.png', prompt: 'frame', model: 'GPT Image 2', createdAt: 0 }],
    selectedCandidateId: `cand-${shotIndex}`,
    promptOverride: null,
    modelId: 'Seedance 2.0 Fast',
    ...overrides,
  };
}

// 模块级单例 DB（与其余 server 测试一致）：整个文件共享一个临时数据库
const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-workbench-test-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.ALLOW_MOCK_FALLBACK = 'true';
delete process.env.YUNWU_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.SEEDANCE_BASE_URL;
delete process.env.SEEDANCE_ACCOUNT;
delete process.env.SEEDANCE_PASSWORD;

const { initDatabase, db } = await import('../lib/db.ts');
initDatabase();
const { registerSafetyPassedFirstFrame } = await import('./_helpers.ts');
// 注意：workflow-controller / video-submission-port 在模块加载时即初始化 db，
// 必须等 DATA_DIR 设置完成后再动态导入（防止误用仓库 data/pipeline.db）。
const [{ WorkflowController, WorkflowError }, { FakeVideoPort }] = await Promise.all([
  import('../lib/workflow-controller.ts'),
  import('../lib/video-submission-port.ts'),
]);

before(() => {
  initDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
  ).run('owner-one', 'owner-one', 'unused', 'operator', 'owner-two', 'owner-two', 'unused', 'operator');
  // 默认产品 + 资产：draftJson 默认携带 productId，服务端按真实 product_assets 计数
  // （远端 URL 视为可达）；Spec2 测试显式构造无 productId 的草稿验证 blocker 路径。
  db.prepare('INSERT OR IGNORE INTO products (id, name, positioning, price) VALUES (?, ?, ?, ?)').run(
    'prod-default',
    '默认测试产品',
    '卖点',
    '¥99'
  );
  db.prepare(
    `INSERT OR IGNORE INTO product_assets (id, product_id, role, url, owner_id)
     VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
  ).run(
    'asset-default-a',
    'prod-default',
    'hero',
    'https://cdn.example.com/hero-a.jpg',
    'owner-one',
    'asset-default-b',
    'prod-default',
    'hero',
    'https://cdn.example.com/hero-b.jpg',
    'owner-two'
  );
});

after(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  } catch {}
});

function insertShot(
  db: any,
  opts: {
    id: string;
    sessionId: string;
    ownerId: string;
    shotIndex: number;
    status: string;
    prompt?: string;
    frameUrl?: string;
    runId?: string | null;
  }
) {
  db.prepare(
    `INSERT INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_prompt, first_frame_url, pipeline_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.sessionId,
    opts.ownerId,
    opts.shotIndex,
    opts.status,
    opts.prompt || 'product close-up',
    opts.frameUrl || '/uploads/frame.png',
    opts.runId ?? null
  );
}

function draftJson(shots: ShotPlanShot[], videoModelId = 'Seedance 2.0 Fast') {
  // productId 指向 before() 预置的默认产品（1 个可达资产 → reference=1）
  return JSON.stringify({ shots, videoModelId, referenceInputCount: 1, productId: 'prod-default' });
}

test('证据#1：付费授权默认关闭；切换自主模式绝不暗中打开授权', async () => {
    const fake = new FakeVideoPort();
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';
    const sessionId = 'sess-auth';

    // 默认：未保存任何设置时，付费授权关闭
    const fresh = ctrl.getState({ ownerId, sessionId });
    assert.equal(fresh.paidAuthorization.enabled, false);

    // 保存草稿并设置自主模式 = 逐步控制，付费授权保持关闭
    ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([makeShot(1)]), autonomyMode: 'step_by_step' });
    let state = ctrl.getState({ ownerId, sessionId });
    assert.equal(state.autonomyMode, 'step_by_step');
    assert.equal(state.paidAuthorization.enabled, false, '设置自主模式不得打开付费授权');

    // 显式开启付费授权
    state = ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });
    assert.equal(state.paidAuthorization.enabled, true);

    // 再切换自主模式 → 授权保持开启（双向不串扰）
    state = ctrl.setAutonomyMode({ ownerId, sessionId, autonomyMode: 'managed' });
    assert.equal(state.autonomyMode, 'managed');
    assert.equal(state.paidAuthorization.enabled, true, '切换自主模式不得关闭已开启的授权');
    assert.equal(fake.capturedCalls.length, 0, '设置操作不得触发任何 provider 调用');
});

test('证据#2：preflight 有 blocker 时不得提交 provider', async () => {
    const fake = new FakeVideoPort();
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';
    const sessionId = 'sess-blocked';

    insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
    // 草稿镜头缺首帧候选 → blocker first_frame_missing
    const shots = [makeShot(1, { candidates: [] })];
    ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson(shots) });
    ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });

    await assert.rejects(
      () => ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' }),
      (error: WorkflowError) =>
        error.code === 'preflight_blocked' && error.preflight?.canSubmit === false
    );
    assert.equal(fake.capturedCalls.length, 0, '有 blocker 时不得有任何 provider 调用');
    // 镜头保持 pending
    const row = db.prepare('SELECT status FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
    assert.equal(row.status, 'pending');
});

test('批量提交：付费授权未开启 → 拒绝（paid_auth_required）且零 provider 调用', async () => {
    const fake = new FakeVideoPort();
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';
    const sessionId = 'sess-noauth';
    insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
    ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([makeShot(1)]) });

    await assert.rejects(
      () => ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' }),
      (error: WorkflowError) => error.code === 'paid_auth_required' && error.status === 409
    );
    assert.equal(fake.capturedCalls.length, 0);
});

test('证据#12 + #4：批量提交成功——仅提交 pending/failed 镜头，成本账目带估算价', async () => {
    const fake = new FakeVideoPort();
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';
    const sessionId = 'sess-batch';
    insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
    insertShot(db, { id: `${sessionId}-shot-2`, sessionId, ownerId, shotIndex: 2, status: 'pending' });
    ctrl.saveDraft({
      ownerId,
      sessionId,
      draftJson: draftJson([makeShot(1), makeShot(2)]),
    });
    ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });

    const result = await ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' });
    assert.equal(result.confirmed, true);
    assert.equal(result.submittedCount, 2);
    // 证据#12：fake seam 捕获恰好 2 次提交，shotId 一一对应，无隐藏付费
    assert.equal(fake.capturedCalls.length, 2);
    const callShotIds = fake.capturedCalls.map((c) => c.shotId).sort();
    assert.deepEqual(callShotIds, [`${sessionId}-shot-1`, `${sessionId}-shot-2`]);
    for (const call of fake.capturedCalls) {
      assert.equal(call.provider, 'fake');
      assert.equal(call.attempt, 1);
      assert.ok(call.runId, 'runId 必须携带');
    }
    // 镜头进入 completed（fake 立即完成）
    const rows = db.prepare('SELECT status, seedance_task_id, video_url FROM shot_generation_tasks WHERE session_id = ? ORDER BY shot_index').all(sessionId) as any[];
    assert.ok(rows.every((r) => r.status === 'completed'));
    assert.ok(rows.every((r) => r.video_url && r.video_url.startsWith('http://fake.local/')));
    // 证据#4（账本侧）：估算价 = 每镜 $0.18（视频 $0.10 + 候选图 $0.08），micros 精度
    const { queryCostLedger } = await import('../lib/telemetry.ts');
    const ledger = queryCostLedger({ ownerId, runId: sessionId, scope: 'shot' });
    assert.equal(ledger.length, 2);
    for (const entry of ledger) {
      assert.equal(entry.estimatedUsd, 0.18);
      assert.equal(entry.actualUsd, 'unknown', '实际成本未知必须显式 unknown');
      assert.equal(entry.scope, 'shot');
    }
    // 确认点已记录
    const state = ctrl.getState({ ownerId, sessionId });
    assert.equal(state.confirms.batch_submit, true);
});

test('证据#5：单镜失败只重试该镜；成功镜头拒绝重提，不重复付费', async () => {
    const fake = new FakeVideoPort();
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';
    const sessionId = 'sess-retry';
    insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
    insertShot(db, { id: `${sessionId}-shot-2`, sessionId, ownerId, shotIndex: 2, status: 'pending' });
    ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([makeShot(1), makeShot(2)]) });
    ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });

    // 第一次批量提交：shot-1 成功（completed），shot-2 失败（provider_error）
    const failing = new FakeVideoPort({ failShotIds: [`${sessionId}-shot-2`] });
    const ctrl2 = makeCtrl(failing);
    const result = await ctrl2.confirm({ ownerId, sessionId, type: 'batch_submit' });
    assert.equal(result.submittedCount, 1);
    const shot1 = db.prepare('SELECT status, seedance_task_id FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
    const shot2 = db.prepare('SELECT status, error_message FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-2`) as any;
    assert.equal(shot1.status, 'completed');
    assert.equal(shot2.status, 'failed');

    // 对成功镜头 shot-1 重试 → 拒绝（不重复付费）
    const rejected = await ctrl2.retryShot({
      ownerId,
      runId: sessionId,
      shotId: `${sessionId}-shot-1`,
      attempt: 1,
      failureReason: 'provider_error',
    });
    assert.equal(rejected.submitted, false);
    assert.ok(rejected.rejectedReason);
    assert.equal(failing.capturedCalls.filter((c) => c.shotId === `${sessionId}-shot-1`).length, 1, '成功镜头不得被再次提交');

    // 仅重试失败镜头 shot-2 → 成功；shot-1 保持 completed 且 video 不丢
    // （provider 已恢复：用全新 fake 端口重试，模拟可恢复错误修复后重试）
    const retryPort = new FakeVideoPort();
    const ctrl3 = makeCtrl(retryPort);
    const retried = await ctrl3.retryShot({
      ownerId,
      runId: sessionId,
      shotId: `${sessionId}-shot-2`,
      attempt: 2,
      failureReason: 'provider_error',
    });
    assert.equal(retried.submitted, true);
    assert.equal(retried.status, 'completed');
    const shot1After = db.prepare('SELECT status, video_url FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
    assert.equal(shot1After.status, 'completed');
    assert.ok(shot1After.video_url, '成功镜头产物不得丢失');
    // 证据#12：总调用 = 初始 shot-1 ×1 + shot-2 ×1（失败）+ 重试 shot-2 ×1；无隐藏付费
    assert.deepEqual(
      failing.capturedCalls.map((c) => `${c.shotId}#${c.attempt}`).sort(),
      [`${sessionId}-shot-1#1`, `${sessionId}-shot-2#1`]
    );
    assert.deepEqual(
      retryPort.capturedCalls.map((c) => `${c.shotId}#${c.attempt}`).sort(),
      [`${sessionId}-shot-2#2`]
    );
});

test('证据#6：典型可恢复错误在 2 次重试动作内恢复；retry 携带 runId/shotId/attempt/失败原因并进入账本', async () => {
    const fake = new FakeVideoPort({ failNext: 2 }); // 初始 + 第 1 次重试失败
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';
    const sessionId = 'sess-recover';
    insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
    ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([makeShot(1)]) });
    ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });

    // 初始提交失败（P3 修复：全失败时 confirm 明确报错，不再 200 假成功）
    await assert.rejects(
      () => ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' }),
      (error: WorkflowError) => error.code === 'all_shots_submission_failed' && error.status === 502
    );
    let row = db.prepare('SELECT status, error_message FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
    assert.equal(row.status, 'failed');

    // 重试动作 #1 → 仍失败（可恢复错误）
    await assert.rejects(
      () =>
        ctrl.retryShot({ ownerId, runId: sessionId, shotId: `${sessionId}-shot-1`, attempt: 1, failureReason: 'provider_error' }),
      (error: WorkflowError) => error.code === 'retry_failed'
    );
    row = db.prepare('SELECT status, error_message FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
    assert.equal(row.status, 'failed');

    // 重试动作 #2 → 恢复成功（2 次重试动作内恢复典型可恢复错误）
    const recovered = await ctrl.retryShot({ ownerId, runId: sessionId, shotId: `${sessionId}-shot-1`, attempt: 2, failureReason: 'provider_error' });
    assert.equal(recovered.submitted, true);
    assert.equal(recovered.status, 'completed');

    // 账本：3 条 shot 记录，retries = 1/2，失败原因写入
    const { queryCostLedger } = await import('../lib/telemetry.ts');
    const ledger = queryCostLedger({ ownerId, runId: sessionId, scope: 'shot' });
    assert.equal(ledger.length, 3);
    const failureEntries = ledger.filter((e) => e.failureReason !== null);
    assert.equal(failureEntries.length, 2, '两次失败都必须在账本中带失败原因');
    const retries = ledger.map((e) => e.retries).sort((a, b) => a - b);
    assert.deepEqual(retries, [1, 1, 2]);
    for (const entry of ledger) {
      assert.ok(entry.shotId, 'shotId 必须进入账本');
      assert.ok(entry.runId === sessionId, 'runId 必须进入账本');
    }
});

test('证据#7：刷新/服务端重启（新 controller 实例）后恢复 run/shot/SaveState', async () => {
    const fake = new FakeVideoPort();
    const ctrl1 = makeCtrl(fake);
    const ownerId = 'owner-one';
    const sessionId = 'sess-restart';

    insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
    ctrl1.saveDraft({
      ownerId,
      sessionId,
      draftJson: draftJson([makeShot(1)]),
      autonomyMode: 'confirm_key_points',
      saveState: 'dirty',
    });
    ctrl1.setPaidAuthorization({ ownerId, sessionId, enabled: true });
    ctrl1.confirm({ ownerId, sessionId, type: 'deconstruction' });
    ctrl1.confirm({ ownerId, sessionId, type: 'shot_plan' });
    await ctrl1.confirm({ ownerId, sessionId, type: 'batch_submit' });
    // 提交后用户又做了局部编辑（未保存）→ dirty 必须可跨重启恢复
    ctrl1.saveDraft({ ownerId, sessionId, saveState: 'dirty' });

    // 模拟服务端重启：全新 controller 实例（同一 DB）
    const fake2 = new FakeVideoPort();
    const ctrl2 = makeCtrl(fake2);
    const state = ctrl2.getState({ ownerId, sessionId });
    assert.equal(state.autonomyMode, 'confirm_key_points');
    assert.equal(state.paidAuthorization.enabled, true, '重启后付费授权必须恢复');
    assert.equal(state.confirms.deconstruction, true);
    assert.equal(state.confirms.shot_plan, true);
    assert.equal(state.confirms.batch_submit, true);
    assert.equal(state.saveState, 'dirty', '重启后 SaveState 必须恢复');
    assert.ok(state.draftJson && state.draftJson.includes('videoModelId'));
    assert.equal(state.shotStates.length, 1);
    assert.equal(state.shotStates[0].status, 'completed', '重启后镜头状态必须恢复');
    assert.equal(state.phase, 'completed');
    assert.equal(state.safeToLeave, true);
    assert.equal(fake2.capturedCalls.length, 0, '重启恢复不得触发任何 provider 调用');
});

test('证据#8：保存失败（非法草稿）抛错阻断；offline_retry 状态持久化', async () => {
    const fake = new FakeVideoPort();
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';

    await assert.rejects(
      () => Promise.resolve().then(() =>
        ctrl.saveDraft({ ownerId, sessionId: 'sess-x', draftJson: '{not-json', saveState: 'saving' })
      ),
      (error: WorkflowError) => error.status === 400 && error.code === 'invalid_draft'
    );
    // 离线重试状态可持久化：保存 offline_retry 后再查询仍是 offline_retry
    ctrl.saveDraft({ ownerId, sessionId: 'sess-x', draftJson: JSON.stringify({}), saveState: 'offline_retry' });
    const state = ctrl.getState({ ownerId, sessionId: 'sess-x' });
    assert.equal(state.saveState, 'offline_retry');
    // 成功后落回 saved
    ctrl.saveDraft({ ownerId, sessionId: 'sess-x', saveState: 'saved' });
    assert.equal(ctrl.getState({ ownerId, sessionId: 'sess-x' }).saveState, 'saved');
});

test('确认点：拆解结果/分镜计划需先保存草稿；cancel 保留已完成镜头', async () => {
    const fake = new FakeVideoPort();
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';

    // 无 runId/sessionId 时确认 → 409
    await assert.rejects(
      () => Promise.resolve(ctrl.confirm({ ownerId, type: 'deconstruction' })),
      (error: WorkflowError) => error.status === 409 && error.code === 'confirm_context_missing'
    );

    const sessionId = 'sess-cancel';
    insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
    insertShot(db, { id: `${sessionId}-shot-2`, sessionId, ownerId, shotIndex: 2, status: 'completed', runId: sessionId });
    ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([makeShot(1)]) });
    ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });

    const deconstruction = await ctrl.confirm({ ownerId, sessionId, type: 'deconstruction' });
    assert.equal(deconstruction.confirmed, true);

    // cancel：pending → cancelled，completed 保留（不删除、不回滚、不重复付费）
    const state = ctrl.cancel({ ownerId, sessionId });
    const rows = db.prepare('SELECT id, status, video_url FROM shot_generation_tasks WHERE session_id = ? ORDER BY shot_index').all(sessionId) as any[];
    assert.equal(rows[0].status, 'cancelled');
    assert.equal(rows[1].status, 'completed');
    assert.equal(state.shotStates.filter((s) => s.status === 'completed').length, 1);
    assert.equal(fake.capturedCalls.length, 0, 'cancel 不得触发 provider 调用');
});

test('retryShot 携带 promptOverride 局部修改，且被写入镜头任务', async () => {
    const fake = new FakeVideoPort({ failNext: 1 });
    const ctrl = makeCtrl(fake);
    const ownerId = 'owner-one';
    const sessionId = 'sess-prompt';
    insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending', prompt: 'original prompt' });
    ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([makeShot(1)]) });
    ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });

    await assert.rejects(
      () => ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' }),
      (error: WorkflowError) => error.code === 'all_shots_submission_failed' && error.status === 502
    ); // shot-1 failed (failNext=1)
    const result = await ctrl.retryShot({
      ownerId,
      runId: sessionId,
      shotId: `${sessionId}-shot-1`,
      attempt: 1,
      failureReason: 'provider_error',
      promptOverride: 'edited: show packaging close-up',
    });
    assert.equal(result.submitted, true);
    const row = db.prepare('SELECT video_prompt FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
    assert.equal(row.video_prompt, 'edited: show packaging close-up');
});

// ==================== P0 验收修复：并发付费防护 / 跨用户覆写 ====================

test('P0-1a：并发 retryShot 同一镜头——原子占位只放行一个，另一个 409，provider 恰好 1 次', async () => {
  const fake = new FakeVideoPort({ delayMs: 50 });
  const ctrl = makeCtrl(fake);
  const ownerId = 'owner-one';
  const sessionId = 'sess-race-retry';
  insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
  ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([makeShot(1)]) });
  ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });
  // 先让镜头失败（进入可重试状态；全失败时 confirm 明确报错）
  const failPort = new FakeVideoPort({ failNext: 1 });
  const ctrlFail = makeCtrl(failPort);
  await assert.rejects(
    () => ctrlFail.confirm({ ownerId, sessionId, type: 'batch_submit' }),
    (error: WorkflowError) => error.code === 'all_shots_submission_failed' && error.status === 502
  );
  const before = db.prepare('SELECT status FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
  assert.equal(before.status, 'failed');

  const [a, b] = await Promise.allSettled([
    ctrl.retryShot({ ownerId, runId: sessionId, shotId: `${sessionId}-shot-1`, attempt: 1, failureReason: 'provider_error' }),
    ctrl.retryShot({ ownerId, runId: sessionId, shotId: `${sessionId}-shot-1`, attempt: 2, failureReason: 'provider_error' }),
  ]);
  const fulfilled = [a, b].find((r) => r.status === 'fulfilled');
  const rejected = [a, b].find((r) => r.status === 'rejected');
  assert.ok(fulfilled && fulfilled.status === 'fulfilled', '恰好一个请求成功');
  assert.equal((fulfilled as PromiseFulfilledResult<any>).value.submitted, true);
  assert.ok(rejected && rejected.status === 'rejected');
  const err = (rejected as PromiseRejectedResult).reason as WorkflowError;
  assert.equal(err.status, 409);
  assert.equal(err.code, 'shot_busy');
  assert.equal(fake.capturedCalls.length, 1, '并发重试同一镜头只允许 1 次 provider 调用（绝不重复扣费）');
  const after = db.prepare('SELECT status FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
  assert.equal(after.status, 'completed');
});

test('P0-1b：并发 batch_submit——原子占位防重复提交，provider 调用数 = 镜头数', async () => {
  const fake = new FakeVideoPort({ delayMs: 50 });
  const ctrl = makeCtrl(fake);
  const ownerId = 'owner-one';
  const sessionId = 'sess-race-batch';
  insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
  insertShot(db, { id: `${sessionId}-shot-2`, sessionId, ownerId, shotIndex: 2, status: 'pending' });
  ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([makeShot(1), makeShot(2)]) });
  ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });

  const [a, b] = await Promise.allSettled([
    ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' }),
    ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' }),
  ]);
  const submittedSum = [a, b].reduce(
    (sum, r) => sum + (r.status === 'fulfilled' ? (r as PromiseFulfilledResult<any>).value.submittedCount : 0),
    0
  );
  assert.equal(submittedSum, 2, '两个并发请求合计提交 2 镜（各镜头只提交一次）');
  assert.equal(fake.capturedCalls.length, 2, '并发批量提交不得重复调用 provider');
  const shotIds = fake.capturedCalls.map((c) => c.shotId).sort();
  assert.deepEqual(shotIds, [`${sessionId}-shot-1`, `${sessionId}-shot-2`]);
  const rows = db.prepare('SELECT status FROM shot_generation_tasks WHERE session_id = ? ORDER BY shot_index').all(sessionId) as any[];
  assert.ok(rows.every((r) => r.status === 'completed'));
});

test('P0-2：跨用户覆写防护——用户 B 用用户 A 的 sessionId 写状态 → 403，A 的行原样保留', async () => {
  const fake = new FakeVideoPort();
  const ctrl = makeCtrl(fake);
  const ownerA = 'owner-one';
  const ownerB = 'owner-two';
  const sessionId = 'sess-shared-key';
  ctrl.saveDraft({ ownerId: ownerA, sessionId, draftJson: draftJson([makeShot(1)]), autonomyMode: 'step_by_step' });
  ctrl.setPaidAuthorization({ ownerId: ownerA, sessionId, enabled: true });

  // B 用相同 sessionId 保存草稿 → 403（不得静默成功）
  await assert.rejects(
    () => Promise.resolve().then(() =>
      ctrl.saveDraft({ ownerId: ownerB, sessionId, draftJson: draftJson([makeShot(1, { promptOverride: 'B hack' })]) })
    ),
    (error: WorkflowError) => error.status === 403 && error.code === 'workbench_owner_mismatch'
  );
  // B 试图开付费授权 → 403
  await assert.rejects(
    () => Promise.resolve().then(() => ctrl.setPaidAuthorization({ ownerId: ownerB, sessionId, enabled: true })),
    (error: WorkflowError) => error.status === 403 && error.code === 'workbench_owner_mismatch'
  );
  // B 切换自主模式 → 403
  await assert.rejects(
    () => Promise.resolve().then(() => ctrl.setAutonomyMode({ ownerId: ownerB, sessionId, autonomyMode: 'managed' })),
    (error: WorkflowError) => error.status === 403 && error.code === 'workbench_owner_mismatch'
  );
  // A 的行未被篡改：授权仍开启、草稿仍为 A 的
  const state = ctrl.getState({ ownerId: ownerA, sessionId });
  assert.equal(state.paidAuthorization.enabled, true);
  assert.equal(state.autonomyMode, 'step_by_step');
  assert.ok(state.draftJson && !state.draftJson.includes('B hack'));
  assert.equal(fake.capturedCalls.length, 0);
});

// ==================== Spec 验收修复：编辑值进生成 / 素材预检真实化 / 授权唯一入口 ====================

test('Spec1：批量提交使用草稿的 promptOverride/selectedCandidateId（编辑值真正进入 provider 并回写任务行）', async () => {
  const fake = new FakeVideoPort();
  const ctrl = makeCtrl(fake);
  const ownerId = 'owner-one';
  const sessionId = 'sess-spec1';
  insertShot(db, {
    id: `${sessionId}-shot-1`,
    sessionId,
    ownerId,
    shotIndex: 1,
    status: 'pending',
    prompt: 'original',
    frameUrl: '/uploads/orig.png',
  });
  const edited = makeShot(1, {
    promptOverride: 'edited: packaging hero close-up',
    candidates: [
      { id: 'cand-orig', url: '/uploads/orig.png', prompt: 'orig', model: 'GPT Image 2', createdAt: 0 },
      { id: 'cand-new', url: '/uploads/new-frame.png', prompt: 'new', model: 'GPT Image 2', createdAt: 0 },
    ],
    selectedCandidateId: 'cand-new',
  });
  ctrl.saveDraft({ ownerId, sessionId, draftJson: draftJson([edited]) });
  ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });

  const result = await ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' });
  assert.equal(result.submittedCount, 1);
  // provider 实际收到的 prompt/首帧 = 编辑后的值（编辑必然进生成，而非仅展示层）
  assert.equal(fake.capturedCalls[0].prompt, 'edited: packaging hero close-up');
  assert.equal(fake.capturedCalls[0].imageUrl, '/uploads/new-frame.png');
  // 任务行回写，展示/账本与真实生成一致
  const row = db.prepare('SELECT video_prompt, first_frame_url FROM shot_generation_tasks WHERE id = ?').get(`${sessionId}-shot-1`) as any;
  assert.equal(row.video_prompt, 'edited: packaging hero close-up');
  assert.equal(row.first_frame_url, '/uploads/new-frame.png');
});

test('Spec2：素材预检按真实 product_assets 计数（忽略客户端硬编码 referenceInputCount）', async () => {
  const fake = new FakeVideoPort();
  const ctrl = makeCtrl(fake);
  const ownerId = 'owner-one';
  const sessionId = 'sess-spec2';
  insertShot(db, { id: `${sessionId}-shot-1`, sessionId, ownerId, shotIndex: 1, status: 'pending' });
  // 客户端硬编码 referenceInputCount: 5，但草稿没有 productId → 服务端按 0 计 → blocker
  const lyingDraft = JSON.stringify({ shots: [makeShot(1)], videoModelId: 'Seedance 2.0 Fast', referenceInputCount: 5 });
  ctrl.saveDraft({ ownerId, sessionId, draftJson: lyingDraft });
  ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });
  await assert.rejects(
    () => ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' }),
    (error: WorkflowError) =>
      error.code === 'preflight_blocked' &&
      error.preflight?.blockers.some((b) => b.code === 'missing_product_asset')
  );
  assert.equal(fake.capturedCalls.length, 0, '素材缺失时不得提交 provider');

  // 真实资产存在（远端 URL 视为可达）+ draft 携带 productId → 预检通过
  db.prepare('INSERT INTO products (id, name, positioning, price) VALUES (?, ?, ?, ?)').run(
    'prod-spec2',
    '测试产品',
    '卖点',
    '¥99'
  );
  db.prepare(
    'INSERT INTO product_assets (id, product_id, role, url, owner_id) VALUES (?, ?, ?, ?, ?)'
  ).run('asset-1', 'prod-spec2', 'hero', 'https://cdn.example.com/hero.jpg', ownerId);
  const withProduct = JSON.stringify({
    shots: [makeShot(1)],
    videoModelId: 'Seedance 2.0 Fast',
    productId: 'prod-spec2',
    referenceInputCount: 5,
  });
  ctrl.saveDraft({ ownerId, sessionId, draftJson: withProduct });
  const result = await ctrl.confirm({ ownerId, sessionId, type: 'batch_submit' });
  assert.equal(result.submittedCount, 1);
  assert.equal(fake.capturedCalls.length, 1);
});

test('P1-2：saveDraft 不再接受 paidAuthEnabled——草稿接口传授权参数被忽略，授权保持关闭', async () => {
  const fake = new FakeVideoPort();
  const ctrl = makeCtrl(fake);
  const ownerId = 'owner-one';
  const sessionId = 'sess-p12';
  // 即使旧客户端/脚本传入 paidAuthEnabled: true，saveDraft 也必须忽略（唯一入口 = setPaidAuthorization）
  (ctrl.saveDraft as any)({ ownerId, sessionId, draftJson: draftJson([makeShot(1)]), paidAuthEnabled: true });
  const state = ctrl.getState({ ownerId, sessionId });
  assert.equal(state.paidAuthorization.enabled, false, '草稿接口不得暗中打开付费授权');
  // 唯一入口生效
  ctrl.setPaidAuthorization({ ownerId, sessionId, enabled: true });
  assert.equal(ctrl.getState({ ownerId, sessionId }).paidAuthorization.enabled, true);
  assert.equal(fake.capturedCalls.length, 0);
});

test('P1-2：新 session 切换自主模式不得继承上一 session 的付费授权', () => {
  const fake = new FakeVideoPort();
  const ctrl = makeCtrl(fake);
  const ownerId = 'owner-one';
  const authorizedSession = 'sess-authorized';
  const freshSession = 'sess-fresh';

  ctrl.saveDraft({
    ownerId,
    sessionId: authorizedSession,
    draftJson: draftJson([makeShot(1)]),
    autonomyMode: 'managed',
  });
  ctrl.setPaidAuthorization({ ownerId, sessionId: authorizedSession, enabled: true });

  ctrl.setAutonomyMode({
    ownerId,
    sessionId: freshSession,
    autonomyMode: 'confirm_key_points',
  });

  assert.equal(
    ctrl.getState({ ownerId, sessionId: freshSession }).paidAuthorization.enabled,
    false,
    '显式新上下文必须使用默认关闭授权，不能读取 latest 会话'
  );
  assert.equal(
    ctrl.getState({ ownerId, sessionId: authorizedSession }).paidAuthorization.enabled,
    true,
    '原会话授权不应被修改'
  );
  assert.equal(fake.capturedCalls.length, 0);
});

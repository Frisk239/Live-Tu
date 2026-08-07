/**
 * S2 workbench HTTP 适配层测试（薄路由）：
 * - 401 未认证；
 * - /state 返回 shared 契约形状（SaveState/自主模式/付费授权/确认点）；
 * - 非法草稿 400；未知自主模式 400；未知确认点 400；
 * - 未开启付费授权批量提交 → 409 paid_auth_required；
 * - retry-shot 缺参数 → 400。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import express from 'express';
import type { ShotPlanShot } from '../../shared/workbench-contract';
import type { WorkflowController } from '../lib/workflow-controller';
import type { FakeVideoPort } from '../lib/video-submission-port';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-wb-routes-'));
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
const { WorkflowController } = await import('../lib/workflow-controller.ts');
const { FakeVideoPort } = await import('../lib/video-submission-port.ts');
const { workbenchRouter, setWorkbenchControllerForTest } = await import('../routes/workbench.ts');

function makeShot(shotIndex: number): ShotPlanShot {
  return {
    shotIndex,
    startTime: 0,
    endTime: 5,
    shotSize: 'close_up',
    cameraPosition: 'front',
    cameraMovement: 'push_in',
    lighting: 'soft',
    dialogue: [],
    soundEffects: [],
    mustKeep: [],
    mustReplace: [],
    generationMode: 'image_to_video',
    capabilityConstraints: { maxDurationSec: 5, minDurationSec: 3, supportedAspectRatios: ['9:16'], supportedResolutions: ['720p'], requiredReferenceInputs: 1 },
    status: 'pending',
    blockers: [],
    warnings: [],
    evidence: [],
    candidates: [{ id: 'c1', url: '/uploads/frame.png', prompt: 'p', model: 'GPT Image 2', createdAt: 0 }],
    selectedCandidateId: 'c1',
    promptOverride: null,
    modelId: 'Seedance 2.0 Fast',
  };
}

let server: ReturnType<typeof app.listen> | null = null;
let baseUrl = '';

function app() {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => {
    if (req.headers['x-test-user'] === 'anonymous') return next();
    req.authUser = { id: 'test-admin', username: 'test-admin', role: 'admin', permissions: [] };
    next();
  });
  application.use('/workbench', workbenchRouter);
  return application;
}

before(async () => {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role)
     VALUES ('test-admin', 'test-admin', 'unused', 'admin')`
  ).run();
  const fake = new FakeVideoPort();
  const ctrl = new WorkflowController({ port: fake });
  setWorkbenchControllerForTest(ctrl);
  server = app().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server!.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}/workbench`;
});

after(() => {
  setWorkbenchControllerForTest(null);
  server?.close();
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  } catch {}
});

test('未认证访问 workbench API → 401', async () => {
  const res = await fetch(`${baseUrl}/state`, { headers: { 'x-test-user': 'anonymous' } });
  assert.equal(res.status, 401);
});

test('GET /state 返回 shared 契约形状（默认：托管直出 + 付费授权关闭）', async () => {
  const res = await fetch(`${baseUrl}/state?sessionId=sess-api`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  const state = json.data;
  assert.equal(state.autonomyMode, 'managed');
  assert.equal(state.paidAuthorization.enabled, false);
  assert.ok(['saving', 'saved', 'dirty', 'offline_retry'].includes(state.saveState));
  assert.deepEqual(Object.keys(state.confirms).sort(), ['batch_submit', 'deconstruction', 'shot_plan']);
  assert.equal(typeof state.safeToLeave, 'boolean');
  assert.ok(Array.isArray(state.shotStates));
});

test('POST /draft 非法草稿 → 400；合法草稿落库', async () => {
  const bad = await fetch(`${baseUrl}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-api', draftJson: '{oops' }),
  });
  assert.equal(bad.status, 400);
  const good = await fetch(`${baseUrl}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'sess-api',
      draftJson: JSON.stringify({ shots: [makeShot(1)], videoModelId: 'Seedance 2.0 Fast' }),
      saveState: 'saved',
    }),
  });
  assert.equal(good.status, 200);
  const json = await good.json();
  assert.equal(json.data.saveState, 'saved');
  assert.equal(json.data.draftJson.includes('videoModelId'), true);
});

test('POST /autonomy 未知模式 → 400；切换不改变付费授权', async () => {
  const bad = await fetch(`${baseUrl}/autonomy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-api', autonomyMode: 'auto-pay' }),
  });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${baseUrl}/autonomy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-api', autonomyMode: 'confirm_key_points' }),
  });
  assert.equal(ok.status, 200);
  const json = await ok.json();
  assert.equal(json.data.autonomyMode, 'confirm_key_points');
  assert.equal(json.data.paidAuthorization.enabled, false, '切换自主模式不得打开付费授权');
});

test('POST /confirm 未知确认点 → 400；批量提交未授权 → 409 paid_auth_required', async () => {
  const bad = await fetch(`${baseUrl}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-api', type: 'pay_now' }),
  });
  assert.equal(bad.status, 400);
  const blocked = await fetch(`${baseUrl}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-api', type: 'batch_submit' }),
  });
  assert.equal(blocked.status, 409);
  const json = await blocked.json();
  assert.equal(json.code, 'paid_auth_required');
});

test('POST /preflight 无分镜草稿 → 409 draft_shot_plan_missing', async () => {
  const res = await fetch(`${baseUrl}/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-no-draft' }),
  });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.code, 'draft_shot_plan_missing');
});

test('POST /retry-shot 缺参数 → 400', async () => {
  const res = await fetch(`${baseUrl}/retry-shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.code, 'missing_shot_id');
});

// ==================== P3 质量闭环修复回归 ====================

test('POST /fix-shot 空 runId → fallback 到会话 id，不抛 missing_run_id（修复后镜头重新生成）', async () => {
  const { registerSafetyPassedFirstFrame } = await import('./_helpers.ts');
  const fake = new FakeVideoPort();
  const ctrl = new WorkflowController({
    port: fake,
    preflightDeps: {
      materialProbe: async (url: string, kind: any) => ({ kind, url, ok: true, status: 'verified', detail: '存在' }),
    },
    ensureFirstFrameFn: async (ctx) => {
      registerSafetyPassedFirstFrame('test-admin', `https://public.example.com/derived-${ctx.shotId}.png`);
      return {
        firstFrameUrl: `https://public.example.com/derived-${ctx.shotId}.png`,
        derived: true,
        attempts: 1,
        preflight: { ok: true, issues: [], score: 1, evidence: 'fake', checkedAt: Date.now() },
      };
    },
  });
  setWorkbenchControllerForTest(ctrl);

  const shotId = 'shot-fix-empty-run';
  const sessionId = 'sess-fix-empty-run';
  db.prepare(
    `INSERT OR IGNORE INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_prompt, qa_status)
     VALUES (?, ?, 'test-admin', 1, 'completed', 'original', 'fail')`
  ).run(shotId, sessionId);
  db.prepare(
    `INSERT INTO shot_qa_reports (id, shot_id, run_id, version, owner_id, report_json, tech_status, semantic_status, overall_verdict, checked_at)
     VALUES (?, ?, ?, 1, 'test-admin', ?, 'verified', 'fail', 'fail', ?)`
  ).run(
    `qa-${shotId}-1`,
    shotId,
    sessionId,
    JSON.stringify({
      semantic: {
        issues: [
          {
            verdict: 'fail',
            dimension: 'hook_quality',
            reason: '钩子不抓人',
            fix: { dimension: 'hook_quality', action: '重写钩子', promptFragment: 'stronger hook' },
          },
        ],
      },
      tech: { status: 'verified' },
    }),
    Date.now()
  );

  // v1 版本行（批量提交已创建；fix 后应产生 v2）
  db.prepare(
    `INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, prompt, model_code, status, created_at)
     VALUES (?, ?, ?, 'test-admin', 1, 'http://fake.local/v1.mp4', 'original', 'doubao-seedance-2-0-fast', 'completed', CURRENT_TIMESTAMP)`
  ).run(`sv-${shotId}-v1`, shotId, sessionId);
  db.prepare('UPDATE shot_generation_tasks SET current_version = 1 WHERE id = ?').run(shotId);

  // 前端未绑定 runId 时传空字符串——必须 fallback 到会话 id 而不是抛 missing_run_id
  const res = await fetch(`${baseUrl}/fix-shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: '', shotId }),
  });
  assert.equal(res.status, 200, `fix-shot 不应因空 runId 失败: ${res.status}`);
  const json = await res.json();
  assert.equal(json.data.action, 'regenerated');
  // 镜头被重新提交（fake provider 捕获一次调用）且版本推进
  assert.equal(fake.capturedCalls.length, 1);
  const row = db.prepare('SELECT status, current_version FROM shot_generation_tasks WHERE id = ?').get(shotId) as any;
  assert.equal(row.status, 'completed');
  assert.equal(row.current_version, 2);
});

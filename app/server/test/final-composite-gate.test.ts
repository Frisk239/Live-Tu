/**
 * S3 final-composite-gate 测试（临时 DB）：
 * - fail / unverified / warning / 未 QA（pending）镜头阻断最终合成；
 * - manualPassed（人工通过）放行；
 * - 全部 QA pass 放行；
 * - 非 completed 镜头阻断；
 * - 无镜头会话阻断。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { evaluateFinalCompositeGate } from '../lib/final-composite-gate';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-composite-gate-test-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.FAKE_VIDEO_PROVIDER = 'true';
delete process.env.YUNWU_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.SEEDANCE_BASE_URL;
delete process.env.SEEDANCE_ACCOUNT;
delete process.env.SEEDANCE_PASSWORD;

const { initDatabase, db } = await import('../lib/db.ts');
initDatabase();

before(() => {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, ?)`
  ).run('gate-owner', 'gate-owner', 'unused', 'operator');
});

after(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

let seq = 0;

function createShot(opts: {
  sessionId: string;
  shotIndex: number;
  status?: string;
  qaStatus?: string | null;
  currentVersion?: number;
  verdict?: string | null; // 当前版本 QA 报告判决
  manualPassed?: boolean;
  version?: number;
}): string {
  seq += 1;
  const shotId = `gate-shot-${Date.now()}-${seq}`;
  const version = opts.version ?? opts.currentVersion ?? 1;
  db.prepare(
    `INSERT INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_url, qa_status, current_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    shotId,
    opts.sessionId,
    'gate-owner',
    opts.shotIndex,
    opts.status || 'completed',
    `/uploads/renders/${shotId}.mp4`,
    opts.qaStatus ?? 'pending',
    version
  );
  if (opts.verdict !== undefined && opts.verdict !== null) {
    db.prepare(
      `INSERT INTO shot_qa_reports
         (id, shot_id, run_id, version, owner_id, report_json, tech_status, semantic_status, overall_verdict, manual_passed, checked_at)
       VALUES (?, ?, 'run-gate', ?, 'gate-owner', '{}', 'verified', ?, ?, ?, 1)`
    ).run(
      `qa-${shotId}-${Date.now()}-${seq}`,
      shotId,
      version,
      opts.verdict === 'pass' ? 'pass' : opts.verdict,
      opts.verdict,
      opts.manualPassed ? 1 : 0
    );
  }
  return shotId;
}

test('门禁：任一镜头 fail 阻断合成并返回可读原因', () => {
  const sessionId = `gate-fail-${Date.now()}`;
  createShot({ sessionId, shotIndex: 1, verdict: 'pass' });
  createShot({ sessionId, shotIndex: 2, verdict: 'fail' });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, false);
  assert.equal(gate.blockedShots.length, 1);
  assert.match(gate.reasons[0], /第 2 镜 QA 判决为「不合格」/);
});

test('门禁：unverified 镜头阻断合成', () => {
  const sessionId = `gate-unverified-${Date.now()}`;
  createShot({ sessionId, shotIndex: 1, verdict: 'pass' });
  createShot({ sessionId, shotIndex: 2, verdict: 'unverified' });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, false);
  assert.match(gate.reasons[0], /第 2 镜 QA 判决为「未验证」/);
});

test('门禁：warning 镜头也阻断（只有 pass 或人工通过才允许合成）', () => {
  const sessionId = `gate-warning-${Date.now()}`;
  createShot({ sessionId, shotIndex: 1, verdict: 'warning' });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, false);
  assert.match(gate.reasons[0], /有风险/);
});

test('门禁：从未执行 QA 的镜头（无报告）视为未验证并阻断', () => {
  const sessionId = `gate-noqa-${Date.now()}`;
  createShot({ sessionId, shotIndex: 1, qaStatus: 'pending', verdict: null });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, false);
  assert.match(gate.reasons[0], /尚未执行 QA/);
});

test('门禁：非 completed 镜头阻断合成', () => {
  const sessionId = `gate-failed-shot-${Date.now()}`;
  createShot({ sessionId, shotIndex: 1, status: 'failed', qaStatus: 'pending', verdict: null });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, false);
  assert.match(gate.reasons[0], /状态为「failed」/);
});

test('门禁：全部镜头 QA pass 允许合成', () => {
  const sessionId = `gate-all-pass-${Date.now()}`;
  createShot({ sessionId, shotIndex: 1, verdict: 'pass' });
  createShot({ sessionId, shotIndex: 2, verdict: 'pass' });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, true);
  assert.deepEqual(gate.blockedShots, []);
  assert.deepEqual(gate.reasons, []);
  assert.equal(gate.checkedShots, 2);
});

test('门禁：fail 镜头人工通过（manualPassed）后允许合成', () => {
  const sessionId = `gate-manual-${Date.now()}`;
  createShot({ sessionId, shotIndex: 1, verdict: 'pass' });
  createShot({ sessionId, shotIndex: 2, verdict: 'fail', manualPassed: true });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, true, JSON.stringify(gate.reasons));
});

test('门禁：unverified 镜头人工通过（manualPassed）后允许合成', () => {
  const sessionId = `gate-manual-unv-${Date.now()}`;
  createShot({ sessionId, shotIndex: 1, verdict: 'unverified', manualPassed: true });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, true, JSON.stringify(gate.reasons));
});

test('门禁：任务级 qa_status=pass（manualPass 落库）允许合成', () => {
  const sessionId = `gate-qa-status-pass-${Date.now()}`;
  // 只有任务级 qa_status=pass（无报告）也视为人工/QA 通过
  createShot({ sessionId, shotIndex: 1, qaStatus: 'pass', verdict: null });

  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, true, JSON.stringify(gate.reasons));
});

test('门禁：无镜头会话阻断并提示缺少镜头任务', () => {
  const sessionId = `gate-empty-${Date.now()}`;
  const gate = evaluateFinalCompositeGate({ sessionId, ownerId: 'gate-owner' });
  assert.equal(gate.canCompose, false);
  assert.match(gate.reasons[0], /没有镜头任务/);
});

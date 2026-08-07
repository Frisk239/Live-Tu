/**
 * 剪辑点定向返修（seam-repair）回归测试：
 *
 * 1. resolveSeamRepairTargets：sequence gate fail/warning → 定位接收镜（≥2 才有前一镜），
 *    同一接收镜去重；
 * 2. registerSeamAnchorFrame：只从「本系统生成视频」提取结束边界帧并完成 hash 绑定
 *    可信登记；外链/爆款参考视频一律拒绝；
 * 3. repairShotAtSeam：新锚点写入草稿接收镜 + 只重生成接收镜（fake port 捕获恰好一次
 *    提交，前一镜不重提）——绝不整条重跑。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { MaterialCheck } from '../../shared/workbench-contract';
import type { FakeVideoPort } from '../lib/video-submission-port';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-seam-repair-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.ALLOW_MOCK_FALLBACK = 'true';
delete process.env.YUNWU_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.FAKE_VISUAL_SAFETY_PASS;

const { initDatabase, db } = await import('../lib/db.ts');
initDatabase();
const {
  registerSeamAnchorFrame,
  resolveSeamRepairTargets,
  repairShotAtSeam,
  SeamRepairError,
} = await import('../lib/seam-repair.ts');
const { WorkflowController } = await import('../lib/workflow-controller.ts');
const { FakeVideoPort } = await import('../lib/video-submission-port.ts');
const { hasFfmpeg } = await import('./_helpers.ts');

const OWNER = 'seam-owner';
const SESSION = 'sess-seam';

const okProbe = async (url: string, kind: MaterialCheck['kind']): Promise<MaterialCheck> => ({
  kind,
  url,
  ok: true,
  status: 'verified',
  detail: '存在',
});

before(async () => {
  initDatabase();
  db.prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'operator')`).run(OWNER, OWNER);
  db.prepare('INSERT OR IGNORE INTO products (id, name, positioning, price) VALUES (?, ?, ?, ?)').run('prod-seam', '返修产品', '卖点', '¥99');
  // 本系统生成视频：复制 fixture 短视频到 uploads/renders（模拟已完成镜头产物）
  const uploadsRoot = process.env.UPLOADS_DIR!;
  const { mkdirSync, existsSync } = await import('node:fs');
  mkdirSync(path.join(uploadsRoot, 'renders'), { recursive: true });
  const fixture = path.resolve(process.cwd(), 'e2e', 'fixtures', 'quality-loop-source.mp4');
  if (existsSync(fixture)) {
    copyFileSync(fixture, path.join(uploadsRoot, 'renders', 'generated-shot-1.mp4'));
    copyFileSync(fixture, path.join(uploadsRoot, 'renders', 'generated-shot-2.mp4'));
  }
});

after(() => {
  delete process.env.FAKE_VISUAL_SAFETY_PASS;
  try {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

function insertShot(opts: { id: string; shotIndex: number; status: string; videoUrl?: string | null }) {
  db.prepare(
    `INSERT OR IGNORE INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_prompt, video_url)
     VALUES (?, ?, ?, ?, ?, 'prompt', ?)`
  ).run(opts.id, SESSION, OWNER, opts.shotIndex, opts.status, opts.videoUrl ?? null);
}

// ==================== 1. resolveSeamRepairTargets ====================

test('resolveSeamRepairTargets：gate 定位 seam 只作用于接收镜（≥2）且去重', () => {
  const gate = {
    version: 'v1' as const,
    status: 'fail' as const,
    scorer: 'llm-vision-sequence-qa',
    fallback: false,
    checkedAt: Date.now(),
    sampledFrames: [],
    checks: [
      {
        id: 'visual_continuity',
        verdict: 'fail' as const,
        evidence: ['boundary break'],
        reason: '第 3 镜场景光线跳变',
        fix: { shotIndex: 3, action: '重做第 3 镜' },
      },
      {
        id: 'causal_handoff',
        verdict: 'warning' as const,
        evidence: [],
        reason: '第 3 镜承接弱',
        fix: { shotIndex: 3, action: '重做第 3 镜' },
      },
      {
        id: 'story_order',
        verdict: 'fail' as const,
        evidence: [],
        reason: '第 1 镜顺序断裂',
        fix: { shotIndex: 1, action: '重排' },
      },
      {
        id: 'cta_closure',
        verdict: 'fail' as const,
        evidence: [],
        reason: '第 6 镜未收束',
        fix: { shotIndex: 6, action: '重做第 6 镜' },
      },
      {
        id: 'product_entry_timing',
        verdict: 'pass' as const,
        evidence: [],
        reason: 'ok',
        fix: null,
      },
    ],
  };
  const targets = resolveSeamRepairTargets(gate as any, 6);
  // 第 1 镜无前一镜 → 跳过；第 3 镜去重合并；第 6 镜保留
  assert.deepEqual(targets.map((t) => t.toShotIndex), [3, 6]);
  const shot3 = targets.find((t) => t.toShotIndex === 3)!;
  assert.equal(shot3.fromShotIndex, 2);
  assert.ok(shot3.reason.includes('visual_continuity') && shot3.reason.includes('causal_handoff'), '同镜多检查原因合并');
});

// ==================== 2. registerSeamAnchorFrame ====================

test('registerSeamAnchorFrame：只接受本系统生成视频（/uploads 本地产物），外链爆款拒绝', async () => {
  if (!hasFfmpeg()) {
    console.warn('ffmpeg 不可用，跳过末帧提取断言（登记失败路径仍验证）');
  }
  process.env.FAKE_VISUAL_SAFETY_PASS = 'true';
  try {
    // 外链产物（爆款参考/未缓存直出）→ 拒绝
    const remoteShot = {
      id: 'shot-remote',
      shot_index: 2,
      status: 'completed',
      owner_id: OWNER,
      video_url: 'https://relay.example.com/videos/x.mp4',
    };
    await assert.rejects(
      () => registerSeamAnchorFrame({ ownerId: OWNER, sessionId: SESSION, fromShot: remoteShot, reason: 'test' }),
      (error: any) => error instanceof SeamRepairError && error.code === 'seam_anchor_unavailable'
    );

    // 本系统生成视频（/uploads/renders 本地文件）→ 提取末帧 + 可信登记
    const localShot = {
      id: 'shot-1',
      shot_index: 1,
      status: 'completed',
      owner_id: OWNER,
      video_url: '/uploads/renders/generated-shot-1.mp4',
    };
    if (!hasFfmpeg()) {
      await assert.rejects(
        () => registerSeamAnchorFrame({ ownerId: OWNER, sessionId: SESSION, fromShot: localShot, reason: 'test' }),
        (error: any) => error instanceof SeamRepairError
      );
      return;
    }
    const anchor = await registerSeamAnchorFrame({ ownerId: OWNER, sessionId: SESSION, fromShot: localShot, reason: 'test' });
    assert.ok(anchor.anchorUrl.startsWith('/uploads/renders/seam-anchors/'), anchor.anchorUrl);
    assert.match(anchor.anchorSha256, /^[a-f0-9]{64}$/);
    // 可信登记落库：owner 匹配 + safety pass + sha256 绑定
    const row = db.prepare(
      `SELECT conditioned_first_frame_url, safety_status, sha256, provider, reference_video_url
         FROM conditioned_first_frames WHERE conditioned_first_frame_url = ?`
    ).get(anchor.anchorUrl) as any;
    assert.ok(row, 'seam anchor 必须登记到 conditioned_first_frames');
    assert.equal(row.safety_status, 'pass');
    assert.equal(row.sha256, anchor.anchorSha256);
    assert.equal(row.provider, 'seam-anchor-extraction');
    assert.equal(row.reference_video_url, '/uploads/renders/generated-shot-1.mp4');
  } finally {
    delete process.env.FAKE_VISUAL_SAFETY_PASS;
  }
});

// ==================== 3. repairShotAtSeam 完整闭环 ====================

test('repairShotAtSeam：锚点写入接收镜草稿 + 只重生成接收镜（前一镜不重提，不整条重跑）', async () => {
  if (!hasFfmpeg()) {
    console.warn('ffmpeg 不可用，跳过完整闭环测试');
    return;
  }
  process.env.FAKE_VISUAL_SAFETY_PASS = 'true';
  try {
    const fake = new FakeVideoPort();
    const ctrl = new WorkflowController({
      port: fake,
      preflightDeps: { materialProbe: okProbe },
      ensureFirstFrameFn: async (ctx) => {
        // 复用登记过的 seam anchor 作为可信首帧（与真实派生链路同语义）
        return {
          firstFrameUrl: ctx.referenceKeyframeUrl || `https://public.example.com/derived-${ctx.shotId}.png`,
          derived: true,
          attempts: 1,
          preflight: { ok: true, issues: [], score: 1, evidence: 'fake-seam', checkedAt: Date.now() },
        };
      },
    });
    insertShot({ id: 'shot-1', shotIndex: 1, status: 'completed', videoUrl: '/uploads/renders/generated-shot-1.mp4' });
    insertShot({ id: 'shot-2', shotIndex: 2, status: 'completed', videoUrl: '/uploads/renders/generated-shot-2.mp4' });
    // 草稿（接收镜带 continuityGroup/plan 元数据；无 seamRepair 时行为不变）
    db.prepare(
      `INSERT OR IGNORE INTO workbench_state (owner_id, session_id, save_state, draft_json, confirms_json, autonomy_mode, paid_auth_enabled)
       VALUES (?, ?, 'saved', ?, '{"deconstruction":true,"shot_plan":true,"batch_submit":true}', 'step_by_step', 1)`
    ).run(
      OWNER,
      SESSION,
      JSON.stringify({
        shots: [
          { shotIndex: 1, referencePolicy: 'semantic_replacement', continuityAnchorUrl: '/uploads/materials/hero.png' },
          { shotIndex: 2, referencePolicy: 'semantic_replacement', continuityAnchorUrl: '/uploads/materials/hero.png' },
        ],
        videoModelId: 'Seedance 2.0 Fast',
        productId: 'prod-seam',
      })
    );

    const result = await repairShotAtSeam({
      controller: ctrl,
      ownerId: OWNER,
      sessionId: SESSION,
      toShotId: 'shot-2',
      toShotIndex: 2,
      fromShotId: 'shot-1',
      fromShotIndex: 1,
      reason: 'visual_continuity: 第 2 镜光线跳变',
    });
    assert.equal(result.submitted, true);
    assert.ok(result.anchorUrl.startsWith('/uploads/renders/seam-anchors/'));
    // 草稿接收镜已写入 seam 锚点（下一轮重生成/复检使用）
    const row = db.prepare('SELECT draft_json FROM workbench_state WHERE owner_id = ? AND session_id = ?').get(OWNER, SESSION) as any;
    const draft = JSON.parse(row.draft_json);
    const shot2 = draft.shots.find((s: any) => s.shotIndex === 2);
    assert.equal(shot2.continuityAnchorUrl, result.anchorUrl);
    assert.equal(shot2.seamRepair.anchorUrl, result.anchorUrl);
    assert.equal(shot2.seamRepair.fromShotIndex, 1);
    // 只重生成接收镜：fake port 恰好 1 次提交（shot-2），shot-1 绝不重提
    assert.equal(fake.capturedCalls.length, 1);
    assert.equal(fake.capturedCalls[0].shotId, 'shot-2');
    // 接收镜进入 completed（fake 即时完成）
    const shot2Row = db.prepare('SELECT status FROM shot_generation_tasks WHERE id = ?').get('shot-2') as any;
    assert.equal(shot2Row.status, 'completed');
  } finally {
    delete process.env.FAKE_VISUAL_SAFETY_PASS;
  }
});

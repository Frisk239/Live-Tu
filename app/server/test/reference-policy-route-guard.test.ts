/**
 * P5 二轮审查修复 6：路由级拦截测试（HTTP 路由 → 工作流 → provider body）。
 *
 * 覆盖第二轮审查的 P0：
 * - /api/seedance/generations 不再原样转发任意 body（materials/预构建 body 拒绝）；
 * - 受信提交（shotId + sessionId）经 submitCheckedShot，付费边界按 owner+URL 查库复核；
 * - /api/pipeline/step2/submit-shot 不得把 reference_keyframe_url 追加进 provider body
 *   （人脸原帧作锚点 → 422，provider 0 次调用）；
 * - gate 契约错误回归（preState 清空 → causal_handoff fail）；
 * - LLM 候选 shotIndex 坐标贯穿选段（与无 LLM 基线不同）。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { runDeterministicStructureChecks } from '../lib/sequence-semantic-gate';
import { createFullVideoPlan } from '../lib/full-video-plan';
import { buildSemanticStoryboard } from '../lib/semantic-storyboard';
import { selectNarrativeSegments } from '../domain/reference-analysis/reference-analysis';

const here = path.dirname(fileURLToPath(import.meta.url));

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-route-guard-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.FAKE_VIDEO_PROVIDER = 'true';
process.env.SEEDANCE_PREFLIGHT = 'false';
process.env.FAKE_FIRST_FRAME_PREFLIGHT = 'true';
// seedance 路由的 hasSeedanceConfig() 前置检查需要配置存在（占位即可——
// 实际提交走 FakeVideoPort，不会触达真实中转）
process.env.SEEDANCE_BASE_URL = 'https://seedance.test.local';
process.env.SEEDANCE_ACCOUNT = 'route-test';
process.env.SEEDANCE_PASSWORD = 'route-test';
// 注意：db 与 video-submission-port（→ routes/seedance → db）必须动态 import——
// 静态 import 链会在本模块顶层 env 设置之前触达 db.ts，把 DATA_DIR 固化为仓库 ./data
// （单文件运行时会读到历史数据，导致 UNIQUE 冲突）。
const { initDatabase, db } = await import('../lib/db');
const { FakeVideoPort, getVideoSubmissionPort, resetVideoSubmissionPort } = await import('../lib/video-submission-port');
const { claimAndSubmitCheckedShot } = await import('../lib/submit-checked-shot');
initDatabase();
resetVideoSubmissionPort();

const OWNER = 'route-owner';
const SESSION = 'route-session-1';
const FACE_KEYFRAME = 'https://raw.example/source-keyframe-face.jpg';
const TRUSTED_PRODUCT = 'https://assets.example.com/buv-pack.png';
const TRUSTED_CFF = 'https://assets.example.com/derived/buv-first-frame.png';
const SAFETY_SHA256 = 'b'.repeat(64);

let fake: FakeVideoPort;
let app: express.Express;
let server: any;
let base: string;

before(async () => {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`
  ).run(OWNER, OWNER, 'unused', 'admin');
  db.prepare(
    `INSERT OR IGNORE INTO products (id, name, positioning, price, revision)
     VALUES ('route-product', 'BUV 路由测试', 'test', '49', 1)`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO product_assets (id, product_id, role, url, owner_id, safety_status, safety_evidence, safety_version, sha256)
     VALUES ('route-asset-1', 'route-product', 'hero', ?, ?, 'pass', '{"face":false,"overlay":false,"watermark":false}', 'v2', ?)`
  ).run(TRUSTED_PRODUCT, OWNER, SAFETY_SHA256);
  db.prepare(
    `INSERT OR IGNORE INTO conditioned_first_frames
       (id, owner_id, conditioned_first_frame_url, product_asset_urls_json, provider, model, prompt_version, prompt,
        safety_status, safety_evidence, safety_version, sha256)
     VALUES ('route-cff-1', ?, ?, '[]', 'test', 'test', 'v2', 'x', 'pass', '{"face":false,"overlay":false,"watermark":false}', 'v2', ?)`
  ).run(OWNER, TRUSTED_CFF, SAFETY_SHA256);

  fake = getVideoSubmissionPort() as FakeVideoPort;
  const { pipelineRouter } = await import('../routes/pipeline.ts');
  const { seedanceRouter } = await import('../routes/seedance.ts');
  app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.authUser = { id: OWNER, username: OWNER, role: 'admin', permissions: [] };
    next();
  });
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/seedance', seedanceRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  resetVideoSubmissionPort();
  delete process.env.FAKE_VIDEO_PROVIDER;
  delete process.env.FAKE_FIRST_FRAME_PREFLIGHT;
  try {
    server?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

/** 每个测试独立 session，禁止 INSERT OR IGNORE 吞掉 UNIQUE 冲突（保证测到目标记录） */
let shotSeq = 0;
function insertShot(opts: {
  id: string;
  shotIndex?: number;
  status?: string;
  firstFrameUrl?: string | null;
  referenceKeyframeUrl?: string | null;
  sessionId?: string;
}) {
  shotSeq += 1;
  const sessionId = opts.sessionId ?? `route-session-${shotSeq}`;
  db.prepare(
    `INSERT INTO shot_generation_tasks
       (id, session_id, owner_id, shot_index, status, video_prompt, first_frame_url, reference_keyframe_url)
     VALUES (?, ?, ?, ?, ?, 'prompt', ?, ?)`
  ).run(
    opts.id,
    sessionId,
    OWNER,
    opts.shotIndex ?? 1,
    opts.status ?? 'pending',
    opts.firstFrameUrl ?? null,
    opts.referenceKeyframeUrl ?? null
  );
  return sessionId;
}

/** 捕获 console.error（断言测试期间无被吞的服务器错误） */
function captureConsoleErrors(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(' '));
  };
  return { messages, restore: () => { console.error = original; } };
}

// ==================== P0-1：/api/seedance/generations 不再转发任意 body ====================

test('路由：/generations 拒绝任意素材 body（materials/预构建/裸 imageUrl）', async () => {
  const beforeCount = fake.capturedCalls.length;
  for (const body of [
    { materials: [{ url: FACE_KEYFRAME, kind: 'image', role: 'reference_image' }], prompt: 'x' },
    { params: { duration: 5 }, model: 'm', prompt: 'x' },
    { imageUrl: FACE_KEYFRAME, prompt: 'x' },
    {},
  ]) {
    const res = await fetch(`${base}/api/seedance/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: any = await res.json();
    assert.ok(res.status === 400, `任意 body 必须 400（${JSON.stringify(body).slice(0, 60)} → ${res.status} ${JSON.stringify(json).slice(0, 120)}）`);
  }
  assert.equal(fake.capturedCalls.length, beforeCount, '任意 body 不得触发任何 provider 调用');
});

test('路由：/generations 受信提交（shotId）在付费边界复核 provenance——原帧首帧被拒', async () => {
  // 注入：shot.first_frame_url = 原视频帧（无可信来源）
  const sessionId = insertShot({ id: 'route-shot-face', firstFrameUrl: FACE_KEYFRAME });
  const beforeCount = fake.capturedCalls.length;
  const capture = captureConsoleErrors();
  let res: Response;
  try {
    res = await fetch(`${base}/api/seedance/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'route-shot-face', sessionId }),
    });
  } finally {
    capture.restore();
  }
  const json: any = await res.json();
  assert.equal(res.status, 422, JSON.stringify(json).slice(0, 200));
  assert.equal(json.code, 'source_keyframe_to_provider');
  assert.equal(fake.capturedCalls.length, beforeCount, '原帧首帧不得触发 provider 调用');
  assert.deepEqual(capture.messages.filter((m) => !m.includes('ExperimentalWarning')), [], '拒绝路径不得产生被吞的服务器错误');
});

test('路由：/generations 受信提交（shotId）——可信条件化首帧通过，body 只含受信资产', async () => {
  const sessionId = insertShot({ id: 'route-shot-ok', firstFrameUrl: TRUSTED_CFF });
  const beforeCount = fake.capturedCalls.length;
  const capture = captureConsoleErrors();
  let res: Response;
  try {
    res = await fetch(`${base}/api/seedance/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'route-shot-ok', sessionId }),
    });
  } finally {
    capture.restore();
  }
  const json: any = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json).slice(0, 300));
  assert.equal(fake.capturedCalls.length, beforeCount + 1, '可信提交恰好一次 provider 调用');
  const call = fake.capturedCalls.at(-1)!;
  assert.equal(call.imageUrl, TRUSTED_CFF);
  assert.deepEqual(call.referenceImageUrls, [], '参考素材为空（无原视频关键帧）');
  assert.deepEqual(capture.messages.filter((m) => !m.includes('ExperimentalWarning')), [], '成功提交不得产生被吞的服务器错误');
});

// ==================== P0-2：pipeline submit-shot 不再追加 reference_keyframe_url ====================

test('路由：submit-shot 携带「可信条件化首帧 + 人脸 reference_keyframe_url」→ 原帧不进 provider body', async () => {
  // 独立 session + 非 IGNORE 插入：保证测到「可信首帧 + 人脸关键帧」记录本身
  const sessionId = insertShot({
    id: 'route-shot-kf',
    firstFrameUrl: TRUSTED_CFF,
    referenceKeyframeUrl: FACE_KEYFRAME, // 原关键帧作锚点/参考素材
  });
  const beforeCount = fake.capturedCalls.length;
  const capture = captureConsoleErrors();
  let res: Response;
  try {
    res = await fetch(`${base}/api/pipeline/step2/submit-shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, shotIndex: 1 }),
    });
  } finally {
    capture.restore();
  }
  const json: any = await res.json();
  assert.equal(res.status, 200, `submit-shot 必须成功且过滤原帧（实际 ${res.status} ${JSON.stringify(json).slice(0, 200)}）`);
  assert.equal(fake.capturedCalls.length, beforeCount + 1, '只允许一次受信 provider 提交');
  const call = fake.capturedCalls.at(-1)!;
  assert.equal(call.imageUrl, TRUSTED_CFF);
  assert.deepEqual(call.referenceImageUrls, [], '原关键帧不得进入 provider');
  assert.deepEqual(capture.messages.filter((m) => !m.includes('ExperimentalWarning')), [], '成功路径不得产生被吞的服务器错误');
});

test('源码契约：pipeline submit-shot 段不再存在 reference_image 素材追加逻辑', () => {
  const source = readFileSync(path.resolve(here, '../routes/pipeline.ts'), 'utf8');
  const submitShotSection = source.slice(source.indexOf('step2/submit-shot'), source.indexOf('shot-tasks/:sessionId'));
  assert.ok(
    !/role:\s*'reference_image'/.test(submitShotSection),
    'submit-shot 段不得再出现 reference_image 素材追加（role: reference_image）'
  );
  assert.ok(
    !/label:\s*'reference_keyframe'/.test(submitShotSection),
    'submit-shot 段不得再出现 reference_keyframe 素材'
  );
});

// ==================== P1-2 回归：gate 契约错误不得被过滤 ====================

test('gate：第二镜 preState 清空 → causal_handoff fail（审查者实测场景）', () => {
  const segments = Array.from({ length: 6 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 }));
  const storyboard = buildSemanticStoryboard({ productName: 'BUV', segments });
  const plan = createFullVideoPlan({
    productName: 'BUV',
    targetDurationSec: 30,
    safeReferenceSegments: segments,
    semanticStoryboard: storyboard,
  });
  plan.shots[1].preState = '';
  const checks = runDeterministicStructureChecks(plan);
  const handoff = checks.find((c) => c.id === 'causal_handoff');
  assert.equal(handoff?.verdict, 'fail', `preState 缺失必须 fail（实际 ${handoff?.verdict}）`);
  assert.ok(handoff?.evidence?.some((e) => /preState/.test(e)), JSON.stringify(handoff?.evidence));
});

// ==================== Spec P1-1 回归：LLM shotIndex 坐标贯穿选段 ====================

test('选段：LLM 高价值 shotIndex 驱动选段（与无 LLM 基线不同）', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({
    candidateId: `cand-${i + 1}`,
    startSec: i * 5,
    endSec: i * 5 + 4.8,
  }));
  // 基线（无 LLM）：三区保底选择，不会选 cand-7 / cand-12
  const baseline = selectNarrativeSegments({
    sceneChanges: [],
    durationSec: 60,
    shotCount: 6,
    candidates,
  });
  assert.ok(!baseline.some((s) => s.startSec === candidates[6].startSec), '基线不应选中 cand-7');
  assert.ok(!baseline.some((s) => s.startSec === candidates[11].startSec), '基线不应选中 cand-12');

  // LLM 标注：shotIndex 指向中段高价值候选与结尾 CTA（shotIndex = 候选序号，1-based）
  const driven = selectNarrativeSegments({
    sceneChanges: [],
    durationSec: 60,
    shotCount: 6,
    candidates,
    rawAnalysis: {
      sourceIntent: '高价值候选驱动',
      shotCandidates: [
        { shotIndex: 1, beat: 'hook', narrativeValue: 0.99 },
        { shotIndex: 7, beat: 'proof', narrativeValue: 0.97 },
        { shotIndex: 12, beat: 'cta', narrativeValue: 0.98 },
      ],
      narrativeBeats: [
        { beat: 'hook', startSec: 0, endSec: 4 },
        { beat: 'cta', startSec: 55, endSec: 60 },
      ],
    },
  });
  assert.ok(driven.some((s) => s.startSec === candidates[6].startSec), 'LLM 标注的 cand-7 必须被选中');
  assert.ok(driven.some((s) => s.startSec === candidates[11].startSec), 'LLM 标注的 cand-12（CTA）必须被选中');
  // 与基线不同（语义驱动而非分区兜底）
  assert.notDeepEqual(
    driven.map((s) => s.startSec),
    baseline.map((s) => s.startSec),
    'LLM 标注必须改变选段结果'
  );
});

// ==================== P5 三轮：语义继承（candidateId → storyboard 语义字段） ====================

test('语义继承：cand-7/cand-12 的 LLM 语义字段进入 storyboard 对应镜（不按最终镜序错位）', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({
    candidateId: `cand-${i + 1}`,
    startSec: i * 5,
    endSec: i * 5 + 4.8,
  }));
  const driven = selectNarrativeSegments({
    sceneChanges: [],
    durationSec: 60,
    shotCount: 6,
    candidates,
    rawAnalysis: {
      sourceIntent: '高价值候选驱动',
      shotCandidates: [
        { shotIndex: 1, beat: 'hook', narrativeValue: 0.99 },
        { shotIndex: 7, beat: 'proof', narrativeValue: 0.97 },
        { shotIndex: 12, beat: 'cta', narrativeValue: 0.98 },
      ],
    },
  });
  // 选段输出必须保留 candidateId（语义继承坐标）
  assert.ok(driven.some((s) => s.candidateId === 'cand-7'), '选段输出必须保留 candidateId=cand-7');
  assert.ok(driven.some((s) => s.candidateId === 'cand-12'), '选段输出必须保留 candidateId=cand-12');

  // storyboard：cand-7 镜的 purpose 来自 raw shotList[7]（而非按最终镜序读 shotList[5]）
  const storyboard = buildSemanticStoryboard({
    productName: 'BUV',
    segments: driven.map(({ startSec, endSec, candidateId }) => ({ startSec, endSec, candidateId })),
    rawAnalysis: {
      sourceIntent: 'x',
      shotList: [
        { shotIndex: 7, beat: 'proof', purpose: 'cand-7 专属：中段证据强化的语义', sourceAction: 'cand-7 动作' },
        { shotIndex: 12, beat: 'cta', purpose: 'cand-12 专属：结尾 CTA 的语义', sourceAction: 'cand-12 动作' },
      ],
      narrativeBeats: [
        { beat: 'hook', startSec: 0, endSec: 4 },
        { beat: 'cta', startSec: 55, endSec: 60 },
      ],
    },
  });
  const shotOfCand7 = storyboard.shots.find((s) => s.startSec === candidates[6].startSec);
  const shotOfCand12 = storyboard.shots.find((s) => s.startSec === candidates[11].startSec);
  assert.ok(shotOfCand7, 'cand-7 镜必须在 storyboard');
  assert.ok(shotOfCand12, 'cand-12 镜必须在 storyboard');
  assert.equal(shotOfCand7?.purpose, 'cand-7 专属：中段证据强化的语义', 'cand-7 必须继承候选 7 的语义（不是最终镜序错位）');
  assert.equal(shotOfCand12?.purpose, 'cand-12 专属：结尾 CTA 的语义', 'cand-12 必须继承候选 12 的语义');
});

test('runner contract: candidateId is retained from candidate analysis through storyboard construction', () => {
  const runner = readFileSync(path.resolve(here, '../../scripts/run-p3-demo.mjs'), 'utf8');
  assert.match(
    runner,
    /candidateSegments\.map\(\(\{ candidateId, startSec, endSec, structure \}\) => \(\{ candidateId, startSec, endSec, structure \}\)\)/,
    'analysis input must retain candidateId'
  );
  assert.match(
    runner,
    /segments\.map\(\(\{ candidateId, startSec, endSec, structure \}\) => \(\{ candidateId, startSec, endSec, structure \}\)\)/,
    'storyboard input must retain candidateId'
  );
});

// ==================== P5 三轮：唯一付费边界（幂等/并发防重） ====================

test('付费边界：同一 shotId 并发 POST /generations 只触发一次 provider 调用（原子 claim + 幂等）', async () => {
  const sessionId = insertShot({ id: 'route-shot-idem', firstFrameUrl: TRUSTED_CFF });
  const beforeCount = fake.capturedCalls.length;
  const results = await Promise.allSettled([
    fetch(`${base}/api/seedance/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'route-shot-idem', sessionId }),
    }),
    fetch(`${base}/api/seedance/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'route-shot-idem', sessionId }),
    }),
    fetch(`${base}/api/seedance/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'route-shot-idem', sessionId }),
    }),
  ]);
  const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
  assert.ok(statuses.every((s) => s === 200 || s === 409), `并发提交只允许 200/409（实际 ${statuses.join(',')}）`);
  assert.equal(fake.capturedCalls.length, beforeCount + 1, '同一 shotId 并发提交只能有一次 provider 调用');
});

test('共享提交服务：首帧准备在 claim 后执行，并发请求只派生一次', async () => {
  const sessionId = insertShot({ id: 'route-shot-prepare-once', firstFrameUrl: null });
  const beforeCount = fake.capturedCalls.length;
  let prepareCalls = 0;
  const prepareFirstFrame = async () => {
    prepareCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    db.prepare(`UPDATE shot_generation_tasks SET first_frame_url = ? WHERE id = ?`)
      .run(TRUSTED_CFF, 'route-shot-prepare-once');
  };
  const results = await Promise.allSettled([
    claimAndSubmitCheckedShot(fake, { ownerId: OWNER, sessionId, shotId: 'route-shot-prepare-once', prepareFirstFrame }),
    claimAndSubmitCheckedShot(fake, { ownerId: OWNER, sessionId, shotId: 'route-shot-prepare-once', prepareFirstFrame }),
  ]);
  assert.equal(prepareCalls, 1, '未取得 claim 的并发方不得调用图像派生');
  assert.equal(fake.capturedCalls.length, beforeCount + 1, 'provider 只能提交一次');
  assert.ok(results.every((result) => result.status === 'fulfilled' || (result.reason as any)?.code === 'submit_conflict'));
});

// ==================== P5 三轮：视觉安全状态强制（unverified/fail 拒绝付费） ====================

test('视觉安全：登记未核验（unverified）的条件化首帧 → 提交被拒', async () => {
  const faceAssetUrl = 'https://cdn.example.com/unverified-conditioned-frame.jpg';
  db.prepare(
    `INSERT OR IGNORE INTO conditioned_first_frames
       (id, owner_id, conditioned_first_frame_url, product_asset_urls_json, provider, model, prompt_version, prompt)
     VALUES ('route-face-asset', ?, ?, '[]', 'test', 'test', 'v2', 'x')`
  ).run(OWNER, faceAssetUrl);
  const sessionId = insertShot({ id: 'route-shot-face-asset', firstFrameUrl: faceAssetUrl });
  const beforeCount = fake.capturedCalls.length;
  const res = await fetch(`${base}/api/seedance/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shotId: 'route-shot-face-asset', sessionId }),
  });
  const json: any = await res.json();
  assert.equal(res.status, 422, JSON.stringify(json).slice(0, 200));
  assert.equal(json.code, 'asset_safety_not_passed', 'unverified 资产必须拒绝付费提交');
  assert.equal(fake.capturedCalls.length, beforeCount, '未通过视觉安全核验的资产不得触发 provider');
});

test('源码契约：submitSeedanceVideoWithFallback 只允许 video-submission-port 直接调用', () => {
  // 递归扫描 server 下非测试 .ts 文件，凡引用该函数者必须是 video-submission-port 或定义处 seedance.ts
  const serverRoot = path.resolve(here, '../');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const content = readFileSync(full, 'utf8');
        if (content.includes('submitSeedanceVideoWithFallback')) {
          const rel = path.relative(serverRoot, full).split(path.sep).join('/');
          if (!rel.includes('video-submission-port.ts') && !rel.includes('routes/seedance.ts')) {
            offenders.push(rel);
          }
        }
      }
    }
  };
  walk(serverRoot);
  assert.deepEqual(offenders, [], 'submitSeedanceVideoWithFallback 不得被除 video-submission-port 外的文件直接调用（唯一付费边界）');
});

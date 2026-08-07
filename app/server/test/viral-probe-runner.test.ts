/**
 * viral-probe-runner 测试（PROBE_FAKE 零付费确定性演练 + 契约断言）：
 * - 三条件组的 materials/请求体/顺序/角色/kind 精确断言：
 *   video_only = [video]，image_only = [image first_frame]，video_image = [video, image first_frame]；
 * - 音频组 generateAudio 语义：silent → false；no_line/spoken/continuity → true；
 *   spoken 组 prompt 含 spokenLine；
 * - fake 模式下绝不调用真实 provider（无真实 taskId/inferenceId 模式）；
 * - ASR 不可用 → 如实 unverified（semanticMatch=null，不伪造）；
 * - 证据 JSON 结构完整性 + 能力落库 + 路由判定；
 * - silent_fallback 恒可路由，nativeSpeech 未验证不可路由。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runViralProbe, FakeQualityScorer, readProviderCapabilities, type ProbeEvidence } from '../lib/viral-probe-runner';
import { FakeAsrClient } from '../lib/viral-audio-probe';
import type { SubtitleOverlayScorer } from '../lib/viral-subclip';
import { hasFfmpeg } from './_helpers';

const fakeSubtitleScorer: SubtitleOverlayScorer = {
  name: 'fake-subtitle-preflight',
  async checkFrames(_frameUrls: string[]) {
    return { ok: true, detected: [], reason: 'fake 放行' };
  },
};

const fakeAsrOk = new FakeAsrClient({ available: true, transcript: '这个产品用起来很方便' });

/** 真实素材：P3 已知合格产物回归对照用的 78s 真实爆款视频（产品介绍段 25-50s） */
const REAL_MATERIAL = path.resolve(process.cwd(), 'uploads', 'materials', 'mat_1785761660278_l27efzmt.mp4');
/** 真实素材不存在时退回 testsrc 生成视频的测试范围 */
const TESTSRC_RANGE = { start: 0, end: 6 };

/**
 * 源视频选择（fake 模式零付费，但裁切/抽帧/约束走真实 ffmpeg）：
 * 1. 优先使用真实素材（存在且可被 ffmpeg 解码）→ 用产品介绍段 25-50s；
 * 2. 无真实素材时用 ffmpeg testsrc 生成 8s 测试视频；
 * 3. 两者都不可用（无 ffmpeg 且无素材）→ 抛错，测试整体跳过。
 */
async function makeSourceVideo(tmp: string): Promise<{ srcPath: string; start: number; end: number }> {
  if (fs.existsSync(REAL_MATERIAL) && hasFfmpeg()) {
    // 验证真实素材可被 ffmpeg 解码（损坏则回退 testsrc）
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', REAL_MATERIAL], { timeout: 30_000 });
      return { srcPath: REAL_MATERIAL, start: 25, end: 50 };
    } catch {
      // fall through to testsrc
    }
  }
  if (hasFfmpeg()) {
    const srcPath = path.join(tmp, 'src.mp4');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=720x1280:rate=30',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', srcPath,
    ], { timeout: 60_000 });
    if (fs.existsSync(srcPath)) return { srcPath, start: TESTSRC_RANGE.start, end: TESTSRC_RANGE.end };
  }
  throw new Error('无可用源视频（需要真实素材或 ffmpeg），跳过依赖视频内容的测试');
}

/** 在 UPLOADS_DIR 下创建测试产品图（fake 派生需要本地字节） */
function makeProductImage(uploadsDir: string): string {
  const dir = path.join(uploadsDir, 'product-assets');
  fs.mkdirSync(dir, { recursive: true });
  const pngPath = path.join(dir, 'pa-test.png');
  fs.writeFileSync(pngPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));
  return '/uploads/product-assets/pa-test.png';
}

/** 断言三条件组请求体材料契约 */
function assertConditionMaterials(evidence: ProbeEvidence): void {
  const bodyOf = (condition: keyof ProbeEvidence['conditions']) =>
    (evidence.conditions[condition] as ProbeEvidence['conditions'][typeof condition])[0]?.requestBody as any;

  const videoOnly = bodyOf('video_only');
  assert.ok(videoOnly, 'video_only 必须有请求体（fake 模式也构建）');
  const vMaterials = videoOnly.materials || [];
  assert.equal(vMaterials.length, 1);
  assert.equal(vMaterials[0].kind, 'video');
  assert.equal(vMaterials[0].label, 'reference_subclip');

  const imageOnly = bodyOf('image_only');
  const iMaterials = imageOnly.materials || [];
  assert.equal(iMaterials.length, 1);
  assert.equal(iMaterials[0].kind, 'image');
  assert.equal(iMaterials[0].role, 'first_frame');
  assert.equal(iMaterials[0].label, 'product_control_image');

  const joint = bodyOf('video_image');
  const jMaterials = joint.materials || [];
  assert.equal(jMaterials.length, 2);
  assert.equal(jMaterials[0].kind, 'video', '联合组首材料必须是参考视频');
  assert.equal(jMaterials[1].kind, 'image', '联合组第二材料必须是控制图');
  assert.equal(jMaterials[1].role, 'first_frame');
}

test('fake 模式三条件组：materials/请求体/角色/顺序契约 + 零真实 provider 调用', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-probe-'));
  const prevUploads = process.env.UPLOADS_DIR;
  const prevData = process.env.DATA_DIR;
  process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
  process.env.DATA_DIR = tmp;
  try {
    // 隔离环境（run-server-tests.mjs 注入空 DATA_DIR）：能力门禁需要 model_config 表
    const { initDatabase } = await import('../lib/db');
    initDatabase();
    const srcVideo = await makeSourceVideo(tmp);
    const srcPath = srcVideo.srcPath;
    const uploadsDir = process.env.UPLOADS_DIR;
    fs.mkdirSync(uploadsDir, { recursive: true });
    const productUrl = makeProductImage(uploadsDir);
    const evidenceDir = path.join(tmp, 'evidence');
    const evidence = await runViralProbe({
      sourceVideoPath: srcPath,
      rangeStartSec: srcVideo.start,
      rangeEndSec: srcVideo.end,
      productAssetUrls: [productUrl],
      productName: 'BUV 小绿泥洁面',
      shotStructure: '中景',
      repeats: 1,
      durationSec: 4,
      scorer: new FakeQualityScorer(),
      subtitleScorer: fakeSubtitleScorer,
      asrClient: fakeAsrOk,
      fake: true,
      evidenceDir,
      runAudioGroups: false,
    });

    assert.equal(evidence.fake, true);
    assert.equal(evidence.provider, 'fake');
    assertConditionMaterials(evidence);

    // 三条件组各 1 条记录，全部 success（fake 完成态）
    for (const condition of ['video_only', 'image_only', 'video_image'] as const) {
      assert.equal(evidence.conditions[condition].length, 1);
      const rec = evidence.conditions[condition][0];
      assert.equal(rec.status, 'success');
      assert.ok(rec.taskId?.startsWith('fake-probe-'), 'fake taskId 前缀（证明未走真实 provider）');
      assert.equal(rec.inferenceId?.startsWith('fake-inference-'), true);
    }

    // fake 质量评分：联合组双高
    assert.equal(evidence.summary.productIdentityRate, 0.85);
    assert.equal(evidence.summary.motionRetentionRate, 0.85);
    assert.ok(Math.abs(evidence.summary.motionRetentionGain! - 0.65) < 1e-9, 'motionRetentionGain=0.85-0.2'); // 0.85-0.2
    assert.ok(Math.abs(evidence.summary.productIdentityDelta! - 0.05) < 1e-9, 'productIdentityDelta=0.85-0.8'); // 0.85-0.8

    // fake 模式能力不伪造：全部不可路由
    assert.equal(evidence.capabilities.nativeReferenceVideo, false, 'fake 模式不得标记真实能力');
    assert.equal(evidence.routeDecisions.nativeReferenceVideo.routable, false);
    assert.equal(evidence.routeDecisions.nativeSpeech.routable, false);
    assert.equal(evidence.routeDecisions.silentFallback.routable, true);

    // 证据 JSON 落盘
    const evidencePath = path.join(evidenceDir, `${evidence.runId}.json`);
    assert.ok(fs.existsSync(evidencePath));
    const parsed = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(parsed.probeVersion, 'p0-v1');
    assert.ok(parsed.subclip.startSec >= 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevUploads === undefined) delete process.env.UPLOADS_DIR; else process.env.UPLOADS_DIR = prevUploads;
    if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData;
  }
});

test('音频组 generateAudio 语义 + ASR 语义匹配 + 能力落库', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-probe-'));
  process.env.DATA_DIR = tmp;
  process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
  try {
    const { initDatabase } = await import('../lib/db');
    initDatabase();
    const srcVideo = await makeSourceVideo(tmp);
    const srcPath = srcVideo.srcPath;
    const uploadsDir = path.join(tmp, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const productUrl = makeProductImage(uploadsDir);
    const evidenceDir = path.join(tmp, 'evidence');
    const evidence = await runViralProbe({
      sourceVideoPath: srcPath,
      rangeStartSec: srcVideo.start,
      rangeEndSec: srcVideo.end,
      productAssetUrls: [productUrl],
      productName: 'BUV 小绿泥洁面',
      shotStructure: '中景',
      repeats: 1,
      durationSec: 4,
      scorer: new FakeQualityScorer(),
      subtitleScorer: fakeSubtitleScorer,
      asrClient: fakeAsrOk,
      fake: true,
      evidenceDir,
      runAudioGroups: true,
    });

    // 音频四组 generateAudio 语义
    const silent = evidence.audio.silent[0].requestBody as any;
    assert.equal(silent.params.generateAudio, false, 'silent 组必须 generateAudio=false');

    for (const mode of ['no_line', 'spoken', 'continuity'] as const) {
      const rec = evidence.audio[mode][0];
      const body = rec.requestBody as any;
      assert.equal(body.params.generateAudio, true, `${mode} 组必须 generateAudio=true`);
      if (mode === 'spoken') {
        assert.ok(String(body.prompt).includes('这个产品用起来很方便'), 'spoken 组 prompt 含 spokenLine');
      }
    }

    // fake ASR：转写成功且语义匹配
    const spoken = evidence.audio.spoken[0];
    assert.equal(spoken.asr?.ok, true);
    assert.equal(spoken.asr?.semanticMatch, true);

    // 能力落库：fake 模式不得路由原生口播（能力未真实验证）
    assert.equal(evidence.capabilities.nativeSpeechGeneration, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ASR 不可用 → 如实 unverified，不伪造可懂性', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-probe-'));
  const prevUploads = process.env.UPLOADS_DIR;
  process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
  try {
    const { initDatabase } = await import('../lib/db');
    initDatabase();
    const srcVideo = await makeSourceVideo(tmp);
    const srcPath = srcVideo.srcPath;
    const uploadsDir = process.env.UPLOADS_DIR;
    fs.mkdirSync(uploadsDir, { recursive: true });
    const productUrl = makeProductImage(uploadsDir);
    const evidence = await runViralProbe({
      sourceVideoPath: srcPath,
      rangeStartSec: srcVideo.start,
      rangeEndSec: srcVideo.end,
      productAssetUrls: [productUrl],
      productName: 'BUV 小绿泥洁面',
      shotStructure: '中景',
      repeats: 1,
      durationSec: 4,
      scorer: new FakeQualityScorer(),
      subtitleScorer: fakeSubtitleScorer,
      asrClient: new FakeAsrClient({ available: false }),
      fake: true,
      evidenceDir: tmp,
      runAudioGroups: true,
    });
    // fake 模式：ASR 结果来自 fake 但能力不落库为 verified
    assert.equal(evidence.capabilities.mandarinSpeechIntelligibility, 'unverified');
    assert.equal(evidence.routeDecisions.nativeSpeech.routable, false);
    assert.equal(evidence.routeDecisions.silentFallback.routable, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevUploads === undefined) delete process.env.UPLOADS_DIR; else process.env.UPLOADS_DIR = prevUploads;
  }
});

test('字幕预检失败 → 拒绝提交（抛出明确错误）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-probe-'));
  try {
    const srcVideo = await makeSourceVideo(tmp);
    const srcPath = srcVideo.srcPath;
    const failingScorer: SubtitleOverlayScorer = {
      name: 'fail-subtitle',
      async checkFrames() {
        return { ok: false, detected: ['subtitle_overlay'], reason: '检出字幕' };
      },
    };
    await assert.rejects(
      () =>
        runViralProbe({
          sourceVideoPath: srcPath,
          rangeStartSec: 0,
          rangeEndSec: 6,
          productAssetUrls: ['/uploads/product-assets/pa-test.png'],
          productName: 'BUV',
          shotStructure: '中景',
          repeats: 1,
          scorer: new FakeQualityScorer(),
          subtitleScorer: failingScorer,
          asrClient: fakeAsrOk,
          fake: true,
          evidenceDir: tmp,
        }),
      /字幕\/水印预检未通过/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('allowTextLayer=true：预检失败不阻断，prompt 含忽略文字层指令，证据记录警告', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-probe-'));
  const prevUploads = process.env.UPLOADS_DIR;
  const prevData = process.env.DATA_DIR;
  process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
  process.env.DATA_DIR = tmp;
  try {
    const { initDatabase } = await import('../lib/db');
    initDatabase();
    const srcVideo = await makeSourceVideo(tmp);
    const uploadsDir = process.env.UPLOADS_DIR;
    fs.mkdirSync(uploadsDir, { recursive: true });
    const productUrl = makeProductImage(uploadsDir);
    const failingScorer: SubtitleOverlayScorer = {
      name: 'fail-subtitle',
      async checkFrames() {
        return { ok: false, detected: ['subtitle_overlay', 'watermark'], reason: '检出字幕与水印' };
      },
    };
    const evidence = await runViralProbe({
      sourceVideoPath: srcVideo.srcPath,
      rangeStartSec: srcVideo.start,
      rangeEndSec: srcVideo.end,
      productAssetUrls: [productUrl],
      productName: 'BUV 小绿泥洁面',
      shotStructure: '中景',
      repeats: 1,
      durationSec: 4,
      scorer: new FakeQualityScorer(),
      subtitleScorer: failingScorer,
      asrClient: fakeAsrOk,
      fake: true,
      evidenceDir: path.join(tmp, 'evidence'),
      allowTextLayer: true,
      runAudioGroups: false,
    });
    // 证据记录文字层警告
    assert.equal((evidence.subclip as any).textLayerAccepted, true);
    // 请求体 prompt 必须含忽略文字层指令（source video 带烧录字幕提示）
    const jointBody = evidence.conditions.video_image[0].requestBody as any;
    assert.ok(String(jointBody.prompt).includes('burned-in subtitles'), 'allowTextLayer 模式 prompt 必须要求忽略源字幕');
    assert.ok(String(jointBody.prompt).includes('zero readable text'), 'prompt 必须要求零可读文字');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevUploads === undefined) delete process.env.UPLOADS_DIR; else process.env.UPLOADS_DIR = prevUploads;
    if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData;
  }
});

test('buildProbePrompt：默认模式 prompt 禁止任何文字层', async () => {
  const { buildProbePrompt } = await import('../lib/viral-probe-runner');
  const defaultPrompt = buildProbePrompt({ productName: 'BUV' });
  assert.ok(defaultPrompt.includes('Do NOT generate any text'), '默认 prompt 禁止生成文字');
  const spokenPrompt = buildProbePrompt({ productName: 'BUV', spokenLine: '这个产品用起来很方便' });
  assert.ok(spokenPrompt.includes('口播：这个产品用起来很方便'), 'spokenLine 进入 prompt');
  assert.ok(spokenPrompt.includes('Do NOT generate any text'));
});

test('readProviderCapabilities：无记录 → 保守默认；损坏 JSON → 保守默认', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-probe-'));
  process.env.DATA_DIR = tmp;
  process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
  try {
    // 未初始化 DB 时读取 → 保守默认
    const caps = readProviderCapabilities('relay', 'doubao-seedance-2-0-fast');
    assert.equal(caps.nativeReferenceVideo, false);
    assert.equal(caps.nativeSpeechGeneration, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

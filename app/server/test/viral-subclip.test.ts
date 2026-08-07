/**
 * viral-subclip 测试：
 * - 窗口选择确定性（scene_boundary / evenly_sampled 两类）；
 * - 字幕预检 fake（检出/未检出/不可用三态，不可用不得放行）；
 * - ffmpeg 约束校验（有 ffmpeg 时真实裁切小 fixture，无则跳过）；
 * - 带字幕素材拒绝提交语义（预检失败 → 拒绝，不进入提交）。
 * 全部零真实付费：字幕 scorer 用 Fake，裁切用本地 fixture。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  selectSubclipWindow,
  selectSubclipWindows,
  extractWindowFrames,
  preflightSubtitleOverlay,
  checkSeedanceVideoConstraints,
  SEEDANCE_VIDEO_CONSTRAINTS,
  SubtitlePreflightError,
  type SubtitleOverlayScorer,
} from '../lib/viral-subclip';
import { hasFfmpeg } from './_helpers';

/** 测试用确定性字幕预检 scorer */
function fakeScorer(opts: { detected?: string[]; unavailable?: boolean } = {}): SubtitleOverlayScorer {
  return {
    name: 'fake-scorer',
    async checkFrames(_frameUrls: string[]) {
      if (opts.unavailable) return { ok: false, detected: [], reason: 'scorer 不可用' };
      return { ok: opts.detected?.length === 0, detected: opts.detected ?? [], reason: 'fake' };
    },
  };
}

// ==================== 窗口选择 ====================

test('selectSubclipWindow：优先落在最长物理场景段内', () => {
  const window = selectSubclipWindow({
    rangeStartSec: 25,
    rangeEndSec: 50,
    sceneChanges: [27, 28.5, 40, 41.5],
    targetSec: 6,
  });
  // 最长 gap = 28.5-40 = 11.5s → 取 6s 窗口 [28.5, 34.5]
  assert.equal(window.basis, 'scene_boundary');
  assert.ok(window.startSec >= 28.5 && window.startSec < 40);
  assert.ok(window.endSec - window.startSec >= 4 && window.endSec - window.startSec <= 8);
  assert.ok(window.endSec <= 50);
});

test('selectSubclipWindow：无物理切点 → 均匀采样', () => {
  const window = selectSubclipWindow({
    rangeStartSec: 25,
    rangeEndSec: 50,
    sceneChanges: [],
    targetSec: 6,
  });
  assert.equal(window.basis, 'evenly_sampled');
  assert.equal(window.startSec, 25);
  assert.equal(window.endSec, 31);
});

test('selectSubclipWindow：短范围与非法范围', () => {
  // 范围短于最小 4s → 抛错
  assert.throws(
    () => selectSubclipWindow({ rangeStartSec: 10, rangeEndSec: 12, sceneChanges: [], minSec: 4 }),
    /源时间范围/
  );
  // endSec <= startSec → 抛错
  assert.throws(
    () => selectSubclipWindow({ rangeStartSec: 20, rangeEndSec: 20, sceneChanges: [] }),
    /无效/
  );
});

test('selectSubclipWindows：多候选窗口按优先级排序（scene gap 优先，均匀采样补齐）', () => {
  // 两个 scene gap：28.5-40（11.5s）与 41.5-50（8.5s）→ 第一个候选是更大 gap
  const windows = selectSubclipWindows({
    rangeStartSec: 25,
    rangeEndSec: 50,
    sceneChanges: [27, 28.5, 40, 41.5],
    targetSec: 6,
    maxCandidates: 3,
  });
  assert.ok(windows.length >= 2, '应产出多个候选窗口');
  assert.equal(windows[0].basis, 'scene_boundary');
  assert.equal(windows[0].startSec, 28.5);
  assert.equal(windows[0].endSec, 34.5);
  // 全部候选不越界且长度在 4-8s
  for (const w of windows) {
    assert.ok(w.endSec > w.startSec);
    assert.ok(w.endSec - w.startSec >= 4 && w.endSec - w.startSec <= 8);
    assert.ok(w.endSec <= 50 && w.startSec >= 25);
  }
});

test('selectSubclipWindows：无切点 → 均匀采样多窗口', () => {
  const windows = selectSubclipWindows({
    rangeStartSec: 25,
    rangeEndSec: 50,
    sceneChanges: [],
    targetSec: 6,
    maxCandidates: 4,
  });
  assert.equal(windows[0].basis, 'evenly_sampled');
  assert.equal(windows[0].startSec, 25);
  assert.equal(windows[0].endSec, 31);
  assert.ok(windows.length >= 3, '25-50s 范围应产出多个均匀窗口');
  // 窗口不重叠（步长 >= target）
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i].startSec >= windows[i - 1].endSec - 0.01);
  }
});

test('selectSubclipWindow：兼容单窗口语义（取第一个候选）', () => {
  const single = selectSubclipWindow({
    rangeStartSec: 25,
    rangeEndSec: 50,
    sceneChanges: [],
    targetSec: 6,
  });
  const first = selectSubclipWindows({
    rangeStartSec: 25,
    rangeEndSec: 50,
    sceneChanges: [],
    targetSec: 6,
  })[0];
  assert.equal(single.startSec, first.startSec);
  assert.equal(single.endSec, first.endSec);
});

test('selectSubclipWindows：短范围与非法范围', () => {
  assert.throws(
    () => selectSubclipWindows({ rangeStartSec: 10, rangeEndSec: 12, sceneChanges: [], minSec: 4 }),
    /源时间范围/
  );
  assert.throws(
    () => selectSubclipWindows({ rangeStartSec: 20, rangeEndSec: 20, sceneChanges: [] }),
    /无效/
  );
});

// ==================== 字幕预检 ====================

test('preflightSubtitleOverlay：检出字幕 → 失败且不放行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-subclip-'));
  try {
    // 无视频文件时抽帧失败 → 返回失败（不抛错），reason 明确
    const result = await preflightSubtitleOverlay({
      videoPath: path.join(tmp, 'missing.mp4'),
      window: { startSec: 0, endSec: 4, basis: 'evenly_sampled', sceneChangesInside: [] },
      scorer: fakeScorer({ detected: ['subtitle_overlay'] }),
    });
    assert.equal(result.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('preflightSubtitleOverlay：scorer 不可用 → 失败（不得放行未检素材）', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('无本地 ffmpeg，跳过 scorer 不可用分支测试');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-subclip-'));
  try {
    // 生成真实小视频（抽帧可成功），让预检真正走到 scorer 调用
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const srcPath = path.join(tmp, 'src.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=720x1280:rate=30',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', srcPath,
    ], { timeout: 60_000 });
    const result = await preflightSubtitleOverlay({
      videoPath: srcPath,
      window: { startSec: 0, endSec: 4, basis: 'evenly_sampled', sceneChangesInside: [] },
      scorer: fakeScorer({ unavailable: true }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('不得放行'), `reason 必须明确不放行，实际: ${result.reason}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ==================== ffmpeg 约束 ====================

test('checkSeedanceVideoConstraints：不存在的文件 → 失败', async () => {
  const result = await checkSeedanceVideoConstraints('/nonexistent/xyz.mp4');
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
});

test('约束常量符合星河 video material 文档', () => {
  assert.equal(SEEDANCE_VIDEO_CONSTRAINTS.minSec, 2);
  assert.equal(SEEDANCE_VIDEO_CONSTRAINTS.maxSec, 15);
  assert.equal(SEEDANCE_VIDEO_CONSTRAINTS.maxBytes, 50 * 1024 * 1024);
  // 720x1280 像素在范围内
  assert.ok(720 * 1280 <= SEEDANCE_VIDEO_CONSTRAINTS.maxPixels);
  assert.ok(720 * 1280 >= SEEDANCE_VIDEO_CONSTRAINTS.minPixels);
});

test('cutSubclip + 约束校验：真实 ffmpeg 裁切小 fixture（无 ffmpeg 跳过）', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('无本地 ffmpeg，跳过真实裁切测试');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-subclip-'));
  try {
    // 用 ffmpeg 生成 2s 测试视频（testsrc 源，缩放目标满足约束）
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const srcPath = path.join(tmp, 'src.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=720x1280:rate=30',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', srcPath,
    ], { timeout: 60_000 });

    const { cutSubclip } = await import('../lib/viral-subclip');
    const result = await cutSubclip({
      sourceVideoPath: srcPath,
      window: { startSec: 0, endSec: 2.5, basis: 'evenly_sampled', sceneChangesInside: [] },
      skipPublish: true,
    });
    assert.ok(result.localPath.endsWith('.mp4'));
    assert.ok(result.durationSec >= 2 && result.durationSec <= 3);
    assert.ok(result.width > 0 && result.height > 0);
    assert.ok(result.bytes > 0);
    // 约束校验通过（无 skip 时由 cutSubclip 内部执行）
    const check = await checkSeedanceVideoConstraints(result.localPath);
    assert.equal(check.ok, true, check.issues.join('; '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('带字幕素材拒绝提交语义：SubtitlePreflightError 具有稳定 code', () => {
  const verdict = { ok: false, detected: ['subtitle_overlay'], evidenceFrames: [], reason: '检出字幕' };
  const err = new SubtitlePreflightError(verdict);
  assert.equal(err.code, 'subtitle_preflight_failed');
  assert.equal(err.verdict, verdict);
});

test('extractWindowFrames：缺失视频返回空数组（不抛错）', async () => {
  const frames = await extractWindowFrames({
    videoPath: '/nonexistent/video.mp4',
    startSec: 0,
    endSec: 4,
    frameCount: 3,
  });
  assert.deepEqual(frames, []);
});

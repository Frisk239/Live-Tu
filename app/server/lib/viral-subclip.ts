/**
 * viral-subclip — P0 参考子视频安全裁切（深模块）。
 *
 * 职责（P0 字幕纪律）：
 * - 参考原片（带烧录字幕）只保留为证据，绝不直接提交给 provider；
 * - selectSubclipWindow：在指定源时间范围内（如产品介绍段 25-50s）用
 *   物理切点 + 固定采样选出 4-8 秒候选窗口；
 * - preflightSubtitleOverlay：对候选窗口抽 3-5 帧做 LLM vision 字幕/水印预检
 *   （允许人物——P0 素材为已授权公司素材，只查 subtitle/watermark/competitor）；
 * - cutSubclip：ffmpeg 裁切并满足星河 video material 硬约束
 *   （h264、≤50MB、像素 409600-927408 → 缩放到 720x1280、24-60fps、2-15s）；
 * - 字幕预检失败 → 尝试 crop 底部字幕带 → 仍失败则拒绝该段并记录。
 *
 * LLM 预检通过注入的 scorer 接口执行（测试用 Fake，真实运行用 visual-safety 的
 * 评估器形态），本模块绝不自己拼 LLM 调用。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveFfmpegBinary, resolveFfprobeBinary, resolveMediaPath } from '../routes/render';
import { publishLocalAsset, type PublishedAsset } from './asset-publisher';
import { sha256OfLocalFile } from './visual-safety';

const execFileAsync = promisify(execFile);

/** 星河 video material 硬约束（docs/星河seedance2.0外部接口文档.md §素材约束） */
export const SEEDANCE_VIDEO_CONSTRAINTS = {
  minSec: 2,
  maxSec: 15,
  maxBytes: 50 * 1024 * 1024,
  minPixels: 409600, // ≈ 640x640
  maxPixels: 927408, // ≈ 720x1280
  minFps: 24,
  maxFps: 60,
} as const;

export const SUBTITLE_PREFLIGHT_VERSION = 'v1';

export interface SubclipWindow {
  startSec: number;
  endSec: number;
  /** 候选来源（scene_boundary / evenly_sampled） */
  basis: 'scene_boundary' | 'evenly_sampled';
  /** 源时间范围内该窗口内已知场景切点（供分析证据） */
  sceneChangesInside: number[];
}

/**
 * 在源时间范围内选出最多 maxCandidates 个候选窗口（4-8 秒），按优先级排序：
 * 1. 物理场景 gap（相邻切点间距 ≥ minSec）从大到小；
 * 2. 均匀采样窗口（从范围起点依次滑动）。
 * 调用方依次对候选窗口做字幕预检，第一个通过的窗口即为安全子片段；
 * 全部失败才拒绝该段（计划 §P0：选无字幕窗口，而不是单窗口失败即放弃）。
 */
export function selectSubclipWindows(input: {
  rangeStartSec: number;
  rangeEndSec: number;
  sceneChanges: number[];
  targetSec?: number;
  minSec?: number;
  maxSec?: number;
  maxCandidates?: number;
}): SubclipWindow[] {
  const { rangeStartSec, rangeEndSec } = input;
  const minSec = input.minSec ?? 4;
  const maxSec = Math.min(input.maxSec ?? 8, SEEDANCE_VIDEO_CONSTRAINTS.maxSec);
  const target = Math.min(Math.max(input.targetSec ?? 6, minSec), maxSec);
  const maxCandidates = Math.max(1, input.maxCandidates ?? 4);
  const rangeDuration = rangeEndSec - rangeStartSec;
  if (rangeDuration <= 0) {
    throw new Error('selectSubclipWindows: 源时间范围无效（endSec 必须大于 startSec）');
  }
  if (rangeDuration < minSec) {
    throw new Error(`selectSubclipWindows: 源时间范围 ${rangeDuration}s 短于最小 ${minSec}s`);
  }

  const inside = (input.sceneChanges || [])
    .filter((t) => t > rangeStartSec && t < rangeEndSec)
    .sort((a, b) => a - b);

  const candidates: Array<{ startSec: number; endSec: number; basis: SubclipWindow['basis'] }> = [];

  // 1) 物理场景 gap（从大到小，窗口 = gap 前 min(target, gapSec) 秒）
  if (inside.length > 0) {
    const bounds = [rangeStartSec, ...inside, rangeEndSec];
    const gaps: Array<{ start: number; end: number; gapSec: number }> = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const gapSec = bounds[i + 1] - bounds[i];
      if (gapSec >= minSec) {
        gaps.push({ start: bounds[i], end: bounds[i + 1], gapSec });
      }
    }
    gaps.sort((a, b) => b.gapSec - a.gapSec);
    for (const gap of gaps) {
      const end = Math.min(gap.start + target, gap.end);
      candidates.push({ startSec: gap.start, endSec: end, basis: 'scene_boundary' });
      if (candidates.length >= maxCandidates) break;
    }
  }

  // 2) 均匀采样窗口补齐（从范围起点按 target 步长滑动）
  if (candidates.length < maxCandidates) {
    const step = Math.max(target, minSec);
    for (let start = rangeStartSec; start + minSec <= rangeEndSec; start += step) {
      const end = Math.min(start + target, rangeEndSec);
      const basis: SubclipWindow['basis'] = 'evenly_sampled';
      if (!candidates.some((c) => Math.abs(c.startSec - start) < 0.01 && Math.abs(c.endSec - end) < 0.01)) {
        candidates.push({ startSec: start, endSec: end, basis });
        if (candidates.length >= maxCandidates) break;
      }
    }
  }

  return candidates.map((c) => ({
    ...c,
    startSec: Math.round(c.startSec * 100) / 100,
    endSec: Math.round(c.endSec * 100) / 100,
    sceneChangesInside: inside.filter((t) => t > c.startSec && t < c.endSec),
  }));
}

/**
 * 兼容旧接口：取第一个候选窗口（单窗口语义，供既有调用方与测试使用）。
 * 新代码应使用 selectSubclipWindows 并逐候选预检。
 */
export function selectSubclipWindow(input: Parameters<typeof selectSubclipWindows>[0]): SubclipWindow {
  return selectSubclipWindows(input)[0];
}

export interface SubtitlePreflightVerdict {
  ok: boolean;
  /** 检出的文字层（subtitle_overlay / watermark / competitor_branding） */
  detected: string[];
  evidenceFrames: string[];
  reason: string;
}

/** LLM vision 预检 scorer 端口（本模块只依赖此接口） */
export interface SubtitleOverlayScorer {
  readonly name: string;
  /**
   * 对一组图片 URL 判定是否存在烧录字幕/水印/竞品文字。
   * 返回 present 列表；调用失败必须返回 { ok:false }，绝不伪造 pass。
   */
  checkFrames(
    frameUrls: string[]
  ): Promise<{ ok: boolean; detected: string[]; reason: string }>;
}

export interface SubclipResult {
  localPath: string;
  publicUrl: string;
  sha256: string;
  durationSec: number;
  startSec: number;
  endSec: number;
  width: number;
  height: number;
  fps: number;
  bytes: number;
  preflight: SubtitlePreflightVerdict;
}

export class SubtitlePreflightError extends Error {
  readonly code = 'subtitle_preflight_failed' as const;
  readonly verdict: SubtitlePreflightVerdict;
  constructor(verdict: SubtitlePreflightVerdict) {
    super(`参考子视频字幕/水印预检未通过：${verdict.reason}`);
    this.verdict = verdict;
  }
}

export class SubclipConstraintsError extends Error {
  readonly code = 'subclip_constraints_violated' as const;
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`参考子视频不满足星河 video material 约束：${issues.join('; ')}`);
    this.issues = issues;
  }
}

const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
const subclipDir = path.join(uploadsRoot, 'renders', 'viral-probe');
fs.mkdirSync(subclipDir, { recursive: true });

/**
 * 抽帧（ffmpeg）：在 [startSec, endSec] 内取 n 个等距时间点各抽 1 帧，返回本地路径。
 */
export async function extractWindowFrames(input: {
  videoPath: string;
  startSec: number;
  endSec: number;
  frameCount?: number;
  prefix?: string;
}): Promise<string[]> {
  const { videoPath, startSec, endSec } = input;
  const mediaPath = resolveMediaPath(videoPath);
  const frameCount = Math.min(Math.max(input.frameCount ?? 4, 2), 6);
  const ffmpegBin = resolveFfmpegBinary();
  const outDir = path.join(subclipDir, 'frames');
  fs.mkdirSync(outDir, { recursive: true });
  const urls: string[] = [];
  const duration = endSec - startSec;
  for (let i = 0; i < frameCount; i++) {
    const t = startSec + (duration * i) / Math.max(frameCount - 1, 1);
    const filename = `${input.prefix ?? 'subclip'}_${i}_${t.toFixed(1)}s.jpg`;
    const outputPath = path.join(outDir, filename);
    try {
      await execFileAsync(
        ffmpegBin,
        ['-y', '-ss', String(t), '-i', mediaPath, '-vframes', '1', '-q:v', '2', outputPath],
        { timeout: 20_000, maxBuffer: 10 * 1024 * 1024 }
      );
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        const rel = path.relative(uploadsRoot, outputPath).split(path.sep).join('/');
        urls.push(`/uploads/${rel}`);
      }
    } catch (err: any) {
      console.warn(`[viral-subclip] 抽帧失败 t=${t.toFixed(1)}s:`, err.message);
    }
  }
  return urls;
}

/**
 * 字幕/水印预检：对窗口帧执行 scorer（LLM vision）。
 * 失败（检出字幕/水印/竞品文字）→ 尝试排除底部字幕带重新预检？
 * 不做自动 crop 重试（会把构图裁坏）：detected 时返回失败，由调用方决定换窗口。
 * 预检只检查文字层，不检查人物（P0 素材为已授权公司素材，人物允许保留）。
 */
export async function preflightSubtitleOverlay(input: {
  videoPath: string;
  window: SubclipWindow;
  scorer: SubtitleOverlayScorer;
  frameCount?: number;
}): Promise<SubtitlePreflightVerdict> {
  const frameUrls = await extractWindowFrames({
    videoPath: input.videoPath,
    startSec: input.window.startSec,
    endSec: input.window.endSec,
    frameCount: input.frameCount ?? 4,
    prefix: `preflight_${randomUUID().slice(0, 6)}`,
  });
  if (frameUrls.length === 0) {
    return { ok: false, detected: [], evidenceFrames: [], reason: '窗口抽帧全部失败，无法完成字幕预检' };
  }
  let result: { ok: boolean; detected: string[]; reason: string };
  try {
    result = await input.scorer.checkFrames(frameUrls);
  } catch (err: any) {
    return {
      ok: false,
      detected: [],
      evidenceFrames: frameUrls,
      reason: `字幕预检 scorer 调用失败：${err?.message || String(err)}（不得放行未检素材）`,
    };
  }
  return {
    ok: result.ok && result.detected.length === 0,
    detected: result.detected,
    evidenceFrames: frameUrls,
    reason: result.ok
      ? result.detected.length === 0
        ? `字幕/水印预检通过（${frameUrls.length} 帧，${input.scorer.name}）`
        : `检出文字层：${result.detected.join(', ')}`
      : `字幕预检不可用（${result.reason}）——不得放行未检素材`,
  };
}

/**
 * 校验本地 mp4 是否满足星河 video material 硬约束（ffprobe）。
 */
export async function checkSeedanceVideoConstraints(localPath: string): Promise<{
  ok: boolean;
  issues: string[];
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  bytes: number;
}> {
  const issues: string[] = [];
  let durationSec = 0;
  let width = 0;
  let height = 0;
  let fps = 0;
  let bytes = 0;
  try {
    bytes = fs.statSync(localPath).size;
  } catch {
    issues.push('文件不存在');
  }
  if (bytes > SEEDANCE_VIDEO_CONSTRAINTS.maxBytes) {
    issues.push(`文件大小 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 50MB 上限`);
  }
  try {
    const ffprobeBin = resolveFfprobeBinary();
    const { stdout } = await execFileAsync(
      ffprobeBin,
      ['-v', 'error', '-show_entries', 'format=duration', '-show_streams', '-of', 'json', localPath],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const probe = JSON.parse(stdout);
    durationSec = Number(probe.format?.duration || 0);
    const videoStream = (probe.streams || []).find((s: any) => s.codec_type === 'video');
    if (videoStream) {
      width = Number(videoStream.width || 0);
      height = Number(videoStream.height || 0);
      const parts = String(videoStream.r_frame_rate || '').split('/');
      if (parts.length === 2 && Number(parts[1]) > 0) {
        fps = Math.round((Number(parts[0]) / Number(parts[1])) * 100) / 100;
      } else {
        fps = Number(videoStream.r_frame_rate || 0);
      }
    }
    if (durationSec < SEEDANCE_VIDEO_CONSTRAINTS.minSec || durationSec > SEEDANCE_VIDEO_CONSTRAINTS.maxSec) {
      issues.push(`时长 ${durationSec.toFixed(1)}s 不在 2-15s 内`);
    }
    const pixels = width * height;
    if (pixels < SEEDANCE_VIDEO_CONSTRAINTS.minPixels || pixels > SEEDANCE_VIDEO_CONSTRAINTS.maxPixels) {
      issues.push(`像素总数 ${pixels} 不在 409600-927408 内（需缩放至约 720x1280）`);
    }
    if (fps < SEEDANCE_VIDEO_CONSTRAINTS.minFps || fps > SEEDANCE_VIDEO_CONSTRAINTS.maxFps) {
      issues.push(`帧率 ${fps} 不在 24-60 内`);
    }
  } catch (err: any) {
    issues.push(`ffprobe 失败：${err?.message || String(err)}`);
  }
  return { ok: issues.length === 0, issues, durationSec, width, height, fps, bytes };
}

/**
 * 裁切参考子视频：ffmpeg 提取 [startSec, endSec] → 缩放到 720x1280（9:16 竖屏）
 * → h264 + yuv420p（兼容播放器）→ 约束校验 → 发布公网。
 */
export async function cutSubclip(input: {
  sourceVideoPath: string;
  window: SubclipWindow;
  ownerId?: string;
  runId?: string;
  scale?: string;
  fps?: number;
  skipPublish?: boolean;
}): Promise<SubclipResult> {
  const { window } = input;
  const mediaPath = resolveMediaPath(input.sourceVideoPath);
  if (!mediaPath || !fs.existsSync(mediaPath)) {
    throw new Error(`cutSubclip: 源视频不存在: ${input.sourceVideoPath}`);
  }
  const scale = input.scale ?? '720:1280';
  const fps = input.fps ?? 30;
  const ffmpegBin = resolveFfmpegBinary();
  const filename = `subclip_${Date.now()}_${randomUUID().slice(0, 8)}.mp4`;
  const outputPath = path.join(subclipDir, filename);

  try {
    await execFileAsync(
      ffmpegBin,
      [
        '-y',
        '-ss', String(window.startSec),
        '-t', String(Math.round((window.endSec - window.startSec) * 100) / 100),
        '-i', mediaPath,
        '-vf', `scale=${scale}:force_original_aspect_ratio=decrease,pad=${scale}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},format=yuv420p`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-movflags', '+faststart',
        outputPath,
      ],
      { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }
    );
  } catch (err: any) {
    throw new Error(`cutSubclip: ffmpeg 裁切失败: ${err?.message || String(err)}`);
  }
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('cutSubclip: 裁切产物为空文件');
  }

  const check = await checkSeedanceVideoConstraints(outputPath);
  if (!check.ok) {
    fs.unlinkSync(outputPath);
    throw new SubclipConstraintsError(check.issues);
  }

  if (input.skipPublish) {
    return {
      localPath: outputPath,
      publicUrl: '',
      sha256: sha256OfLocalFile(outputPath) || '',
      durationSec: check.durationSec,
      startSec: window.startSec,
      endSec: window.endSec,
      width: check.width,
      height: check.height,
      fps: check.fps,
      bytes: check.bytes,
      preflight: { ok: true, detected: [], evidenceFrames: [], reason: 'skipPublish（未发布）' },
    };
  }

  const published: PublishedAsset = await publishLocalAsset(outputPath, {
    runId: input.runId,
  });
  return {
    localPath: outputPath,
    publicUrl: published.publicUrl,
    sha256: published.sha256 || sha256OfLocalFile(outputPath) || '',
    durationSec: check.durationSec,
    startSec: window.startSec,
    endSec: window.endSec,
    width: check.width,
    height: check.height,
    fps: check.fps,
    bytes: check.bytes,
    preflight: { ok: true, detected: [], evidenceFrames: [], reason: '预检由调用方在裁切前执行' },
  };
}

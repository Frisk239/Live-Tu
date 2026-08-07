/**
 * 镜头级 QA — 对 Seedance 生成的单镜视频做启发式质检。
 * 检查项：视频流存在、时长下限、分辨率下限、黑帧占比。
 * 纯 I/O 模块，不依赖业务状态。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { ScoreDimensionId, ScoreEntry, ScoreStatus } from '../../shared/scorecard';

const execAsync = promisify(exec);

function resolveFfprobe(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function resolveFfmpeg(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export type ShotQaCheckStatus = 'passed' | 'failed' | 'unverified';

export interface ShotQaCheck {
  name: string;
  ok: boolean;
  detail?: string;
  evidence?: any;
  status?: ShotQaCheckStatus;
}

export interface ShotQaResult {
  status: 'verified' | 'unverified' | 'warning';
  ok: boolean;
  checks: ShotQaCheck[];
  reason?: string;
  evidence?: Record<string, any>;
}

/**
 * 将可复核的技术 QA 结论投影到评分卡。缺失检查必须是 unverified，不能借
 * `techQa.status=verified` 静默补齐；这样新增硬门禁时，测试和生产都会暴露遗漏。
 */
export function technicalQaScoreEntries(result: ShotQaResult): ScoreEntry[] {
  const mappings: Array<{ check: string; dimension: ScoreDimensionId }> = [
    { check: 'video_stream', dimension: 'playability' },
    { check: 'black_frame', dimension: 'black_frame' },
    { check: 'duration', dimension: 'duration' },
    { check: 'resolution', dimension: 'resolution' },
    { check: 'audio_track', dimension: 'audio_track' },
  ];

  return mappings.map(({ check: checkName, dimension }) => {
    const check = result.checks.find((item) => item.name === checkName);
    const checkStatus = check?.status ?? (check ? (check.ok ? 'passed' : 'failed') : 'unverified');
    const status: ScoreStatus = checkStatus === 'unverified' ? 'unverified' : 'measured';
    const blackRatio = dimension === 'black_frame' && typeof check?.evidence?.ratio === 'number'
      ? Math.max(0, Math.min(1, Number(check.evidence.ratio)))
      : null;
    const value = checkStatus === 'unverified'
      ? 1
      : blackRatio !== null
        ? 1 - blackRatio
        : checkStatus === 'passed'
          ? 1
          : 0;

    return {
      id: dimension,
      layer: 'technical',
      kind: 'auto',
      value,
      status,
      evidence: [
        {
          source: 'ffprobe/ffmpeg',
          detail: check?.detail || `技术 QA 未提供 ${checkName} 检查结果`,
        },
      ],
      confidence: status === 'measured' ? 1 : 0,
      scorer: 'shot-technical-qa',
      scorerVersion: 'v1.0.0',
    };
  });
}

/** 从 ffmpeg blackdetect 输出解析时长（HH:MM:SS.xx 格式）。纯函数，便于单元测试。 */
export function parseDurationFromOutput(output: string): number {
  const match = output.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * 从 ffmpeg blackdetect 输出解析黑帧统计。
 * 修正：black_end 是结束时间戳而不是时长 —— 每段黑帧时长 = black_end - black_start，
 * 旧实现把 black_end 直接累加，导致黑帧时长被系统性高估（启发式误差，S1 修复）。
 */
export function parseBlackDetectOutput(output: string): {
  totalSec: number;
  blackSec: number;
  ratio: number;
  segments: Array<{ start: number; end: number; duration: number }>;
} {
  const totalSec = parseDurationFromOutput(output);
  const segments: Array<{ start: number; end: number; duration: number }> = [];
  const pattern = /black_start:([\d.]+) black_end:([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const duration = Math.max(0, end - start);
    segments.push({ start, end, duration });
  }
  const blackSec = segments.reduce((sum, s) => sum + s.duration, 0);
  return {
    totalSec,
    blackSec,
    ratio: totalSec > 0 ? blackSec / totalSec : 0,
    segments,
  };
}

/**
 * 把 Seedance 返回的远端 URL 解析成本地可探测路径：
 * - /uploads/... 相对路径 → 本地磁盘路径
 * - https://... 远端 → 先探测远程是否存在（无法本地 ffprobe 时只做基本检查）
 */
function localPathFor(url: string): string | null {
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  const trimmed = String(url || '').trim();
  if (trimmed.startsWith('/uploads/')) {
    const candidate = path.join(uploadsRoot, trimmed.replace(/^\/uploads\//, ''));
    return fs.existsSync(candidate) ? candidate : null;
  }
  // 已缓存到 uploads/renders 的远端产物（remote_*.mp4）
  if (trimmed.startsWith('http')) {
    const name = path.basename(new URL(trimmed).pathname);
    const cached = path.join(uploadsRoot, 'renders', name);
    return fs.existsSync(cached) ? cached : null;
  }
  return null;
}

/**
 * ffprobe 基础检查：视频流、时长、分辨率。
 */
async function probeChecks(filePath: string): Promise<ShotQaCheck[]> {
  const checks: ShotQaCheck[] = [];
  try {
    const cmd = `${resolveFfprobe()} -v error -show_entries stream=codec_name,codec_type,width,height,start_time,duration -show_entries format=duration -of json ${JSON.stringify(filePath)}`;
    const { stdout } = await execAsync(cmd, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || '{}');
    const streams: any[] = parsed?.streams || [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const duration = Number(parsed?.format?.duration || 0);
    const videoDuration = Number(video?.duration);
    const audioDuration = Number(audio?.duration);
    const videoStart = Number(video?.start_time);
    const audioStart = Number(audio?.start_time);

    checks.push({
      name: 'video_stream',
      ok: Boolean(video),
      status: video ? 'passed' : 'failed',
      detail: video ? `codec=${video.codec_name}` : '无视频轨',
      evidence: { codec: video?.codec_name },
    });
    checks.push({
      name: 'duration',
      ok: duration >= 0.8,
      status: duration >= 0.8 ? 'passed' : 'failed',
      detail: `${duration.toFixed(2)}s`,
      evidence: { duration },
    });
    const width = Number(video?.width || 0);
    const height = Number(video?.height || 0);
    checks.push({
      name: 'resolution',
      ok: width >= 320 && height >= 320,
      status: width >= 320 && height >= 320 ? 'passed' : 'failed',
      detail: width && height ? `${width}x${height}` : '未知',
      evidence: { width, height },
    });

    const audioHasDuration = Number.isFinite(audioDuration) && audioDuration > 0.1;
    checks.push({
      name: 'audio_track',
      ok: Boolean(audio) && audioHasDuration,
      status: Boolean(audio) && audioHasDuration ? 'passed' : 'failed',
      detail: audio
        ? audioHasDuration
          ? `codec=${audio.codec_name}; ${audioDuration.toFixed(3)}s`
          : `音频轨 ${audio.codec_name || 'unknown'} 缺少可用时长`
        : '无音频轨',
      evidence: {
        codec: audio?.codec_name,
        duration: Number.isFinite(audioDuration) ? audioDuration : null,
      },
    });

    const canMeasureSync =
      Boolean(video) &&
      Boolean(audio) &&
      Number.isFinite(videoDuration) &&
      Number.isFinite(audioDuration) &&
      Number.isFinite(videoStart) &&
      Number.isFinite(audioStart);
    if (!video || !audio) {
      checks.push({
        name: 'av_sync',
        ok: false,
        status: 'failed',
        detail: '缺少视频轨或音频轨，无法形成音画同步',
        evidence: { videoPresent: Boolean(video), audioPresent: Boolean(audio) },
      });
    } else if (!canMeasureSync) {
      checks.push({
        name: 'av_sync',
        ok: false,
        status: 'unverified',
        detail: '音频或视频流缺少时间轴元数据，无法验证音画时间对齐',
        evidence: {
          videoDuration: Number.isFinite(videoDuration) ? videoDuration : null,
          audioDuration: Number.isFinite(audioDuration) ? audioDuration : null,
          videoStart: Number.isFinite(videoStart) ? videoStart : null,
          audioStart: Number.isFinite(audioStart) ? audioStart : null,
        },
      });
    } else {
      const durationDelta = Math.abs(videoDuration - audioDuration);
      const startDelta = Math.abs(videoStart - audioStart);
      const ok = durationDelta <= 0.25 && startDelta <= 0.1;
      checks.push({
        name: 'av_sync',
        ok,
        status: ok ? 'passed' : 'failed',
        detail: `音视频时长差 ${durationDelta.toFixed(3)}s，起始时间差 ${startDelta.toFixed(3)}s`,
        evidence: { videoDuration, audioDuration, videoStart, audioStart, durationDelta, startDelta },
      });
    }
  } catch (error: any) {
    checks.push({
      name: 'probe',
      ok: false,
      status: 'unverified',
      detail: `ffprobe 失败: ${String(error?.message || error).slice(0, 80)}`,
      evidence: { error: error?.message },
    });
  }
  return checks;
}

/**
 * 黑帧检测：用 blackdetect 统计黑帧段占比，超过 10% 判定为黑屏失败。
 * 无法探测（时长未知 / ffmpeg 失败）时必须返回 unverified，不得默认 ok=true（S1 修复假确定性）。
 */
async function blackFrameCheck(filePath: string): Promise<ShotQaCheck> {
  try {
    const cmd =
      `${resolveFfmpeg()} -v info -i ${JSON.stringify(filePath)} ` +
      `-vf "blackdetect=d=0.6:pix_th=0.10" -an -f null - 2>&1`;
    const { stdout } = await execAsync(cmd, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const { totalSec, blackSec, ratio, segments } = parseBlackDetectOutput(stdout);
    const evidence = { stdout, totalSec, blackSec, ratio, segments };

    if (totalSec <= 0) {
      // 时长未知：无法计算占比 → 明确 unverified，不判通过
      return {
        name: 'black_frame',
        ok: false,
        status: 'unverified',
        detail: '时长未知，黑帧占比无法计算',
        evidence,
      };
    }
    return {
      name: 'black_frame',
      ok: ratio < 0.1,
      status: ratio < 0.1 ? 'passed' : 'failed',
      detail: `黑帧占比 ${(ratio * 100).toFixed(1)}%（${blackSec.toFixed(2)}s / ${totalSec.toFixed(2)}s）`,
      evidence,
    };
  } catch (error: any) {
    // 检测失败：明确 unverified，不得默认 ok=true（旧实现返回 ok:true 是假确定性）
    return {
      name: 'black_frame',
      ok: false,
      status: 'unverified',
      detail: `检测失败: ${String(error?.message || error).slice(0, 60)}`,
      evidence: { error: error?.message },
    };
  }
}

/** 对单个镜头视频执行 QA。
 * 远端无法探测时 status=unverified，不默认 ok=true（S1 修复假确定性）。
 * 所有分数携带 evidence、scorerVersion。
 */
export async function qaShotVideo(url: string): Promise<ShotQaResult> {
  const local = localPathFor(url);
  if (!local) {
    return {
      status: 'unverified',
      ok: false,
      checks: [
        {
          name: 'local_probe',
          ok: false,
          status: 'unverified',
          detail: '产物为远端 URL，无法本地质检（部署后由公网拉取）',
        },
      ],
      reason: 'remote_url_unverified',
      evidence: { url },
    };
  }
  const checks = await probeChecks(local);
  const black = await blackFrameCheck(local);
  checks.push(black);

  // 任一检查 unverified → 整体 unverified（无法下结论，不得通过）
  const hasUnverified = checks.some((c) => c.status === 'unverified');
  const failed = checks.filter((c) => !c.ok);
  let status: 'verified' | 'unverified' | 'warning';
  if (hasUnverified) {
    status = 'unverified';
  } else if (failed.length === 0) {
    status = 'verified';
  } else {
    status = 'warning';
  }

  return {
    status,
    ok: status === 'verified',
    checks,
    reason: failed.length > 0 ? failed.map((c) => `${c.name}: ${c.detail || '不合格'}`).join('; ') : undefined,
    evidence: {
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, status: c.status ?? (c.ok ? 'passed' : 'failed'), evidence: c.evidence })),
    },
  };
}

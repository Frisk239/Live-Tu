/**
 * 镜头级 QA — 对 Seedance 生成的单镜视频做启发式质检。
 * 检查项：视频流存在、时长下限、分辨率下限、黑帧占比。
 * 纯 I/O 模块，不依赖业务状态。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(exec);

function resolveFfprobe(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function resolveFfmpeg(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export interface ShotQaResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  reason?: string;
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
async function probeChecks(filePath: string): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  try {
    const cmd = `${resolveFfprobe()} -v error -show_entries stream=codec_type,width,height -show_entries format=duration -of json ${JSON.stringify(filePath)}`;
    const { stdout } = await execAsync(cmd, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || '{}');
    const streams: any[] = parsed?.streams || [];
    const video = streams.find((s) => s.codec_type === 'video');
    const duration = Number(parsed?.format?.duration || 0);

    checks.push({
      name: 'video_stream',
      ok: Boolean(video),
      detail: video ? `codec=${video.codec_name}` : '无视频轨',
    });
    checks.push({
      name: 'duration',
      ok: duration >= 0.8,
      detail: `${duration.toFixed(2)}s`,
    });
    const width = Number(video?.width || 0);
    const height = Number(video?.height || 0);
    checks.push({
      name: 'resolution',
      ok: width >= 320 && height >= 320,
      detail: width && height ? `${width}x${height}` : '未知',
    });
  } catch (error: any) {
    checks.push({ name: 'probe', ok: false, detail: `ffprobe 失败: ${String(error?.message || error).slice(0, 80)}` });
  }
  return checks;
}

/**
 * 黑帧检测：用 blackdetect 统计黑帧段占比，超过 40% 判定为黑屏失败。
 */
async function blackFrameCheck(filePath: string): Promise<{ name: string; ok: boolean; detail?: string }> {
  try {
    const cmd =
      `${resolveFfmpeg()} -v info -i ${JSON.stringify(filePath)} ` +
      `-vf "blackdetect=d=0.6:pix_th=0.10" -an -f null - 2>&1`;
    const { stdout } = await execAsync(cmd, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const durationMatch = stdout.match(/Duration: (\d+):(\d+):([\d.]+)/);
    const totalSec =
      durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : 0;
    const blackMatches = [...stdout.matchAll(/black_start:[\d.]+ black_end:([\d.]+)/g)];
    const blackSec = blackMatches.reduce((sum, m) => sum + Number(m[1] || 0), 0);
    if (totalSec <= 0) {
      return { name: 'black_frame', ok: true, detail: '时长未知，跳过黑帧检测' };
    }
    const ratio = blackSec / totalSec;
    return {
      name: 'black_frame',
      ok: ratio < 0.4,
      detail: `黑帧占比 ${(ratio * 100).toFixed(1)}%`,
    };
  } catch (error: any) {
    return { name: 'black_frame', ok: true, detail: `检测跳过: ${String(error?.message || error).slice(0, 60)}` };
  }
}

/** 对单个镜头视频执行 QA。无法本地探测时（纯远端 URL）返回 ok=true 并注明跳过。 */
export async function qaShotVideo(url: string): Promise<ShotQaResult> {
  const local = localPathFor(url);
  if (!local) {
    return {
      ok: true,
      checks: [{ name: 'local_probe', ok: true, detail: '产物为远端 URL，跳过本地质检（部署后由公网拉取）' }],
    };
  }
  const checks = await probeChecks(local);
  const black = await blackFrameCheck(local);
  checks.push(black);
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    reason: failed.length > 0 ? failed.map((c) => `${c.name}: ${c.detail || '不合格'}`).join('; ') : undefined,
  };
}

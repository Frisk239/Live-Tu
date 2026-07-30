import { Router } from 'express';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { assertSafeRemoteUrl } from '../lib/safe-url';
import { canUseMediaReference, registerOwnedMedia } from '../lib/media-ownership';

export const renderRouter = Router();
const execAsync = promisify(exec);

// Ensure uploads/renders directory exists
const rendersDir = path.join(
  path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')),
  'renders'
);
const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
if (!fs.existsSync(rendersDir)) {
  fs.mkdirSync(rendersDir, { recursive: true });
}

let cachedFfmpegBin: string | null | undefined;

/** Resolve ffmpeg binary: PATH first, then common Windows install locations. */
export function resolveFfmpegBinary(): string {
  if (cachedFfmpegBin !== undefined && cachedFfmpegBin !== null) return cachedFfmpegBin;
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    cachedFfmpegBin = process.env.FFMPEG_PATH;
    return cachedFfmpegBin;
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const wingetRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  const candidates: string[] = ['ffmpeg'];
  if (fs.existsSync(wingetRoot)) {
    try {
      for (const dir of fs.readdirSync(wingetRoot)) {
        if (!/ffmpeg/i.test(dir)) continue;
        const pkg = path.join(wingetRoot, dir);
        const walk = (d: string, depth: number) => {
          if (depth > 4) return;
          let entries: string[] = [];
          try {
            entries = fs.readdirSync(d);
          } catch {
            return;
          }
          for (const name of entries) {
            const full = path.join(d, name);
            if (name.toLowerCase() === 'ffmpeg.exe') candidates.push(full);
            else if (depth < 4) {
              try {
                if (fs.statSync(full).isDirectory()) walk(full, depth + 1);
              } catch {
                /* skip */
              }
            }
          }
        };
        walk(pkg, 0);
      }
    } catch {
      /* ignore */
    }
  }
  candidates.push(
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe'
  );

  for (const c of candidates) {
    if (c === 'ffmpeg') continue;
    if (fs.existsSync(c)) {
      cachedFfmpegBin = c;
      return c;
    }
  }
  cachedFfmpegBin = 'ffmpeg';
  return 'ffmpeg';
}

let cachedFfprobeBin: string | null | undefined;

/** Resolve ffprobe binary using FFmpeg location */
export function resolveFfprobeBinary(): string {
  if (cachedFfprobeBin !== undefined && cachedFfprobeBin !== null) return cachedFfprobeBin;
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    cachedFfprobeBin = process.env.FFPROBE_PATH;
    return cachedFfprobeBin;
  }
  const ffmpegBin = resolveFfmpegBinary();
  if (ffmpegBin && ffmpegBin !== 'ffmpeg' && fs.existsSync(ffmpegBin)) {
    const probeCandidate = path.join(path.dirname(ffmpegBin), 'ffprobe.exe');
    if (fs.existsSync(probeCandidate)) {
      cachedFfprobeBin = probeCandidate;
      return cachedFfprobeBin;
    }
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const wingetRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetRoot)) {
    try {
      for (const dir of fs.readdirSync(wingetRoot)) {
        if (!/ffmpeg/i.test(dir)) continue;
        const pkg = path.join(wingetRoot, dir);
        const walk = (d: string, depth: number): string | null => {
          if (depth > 4) return null;
          let entries: string[] = [];
          try { entries = fs.readdirSync(d); } catch { return null; }
          for (const name of entries) {
            const full = path.join(d, name);
            if (name.toLowerCase() === 'ffprobe.exe') return full;
            if (depth < 4) {
              try {
                if (fs.statSync(full).isDirectory()) {
                  const res = walk(full, depth + 1);
                  if (res) return res;
                }
              } catch {}
            }
          }
          return null;
        };
        const found = walk(pkg, 0);
        if (found) {
          cachedFfprobeBin = found;
          return found;
        }
      }
    } catch {}
  }

  for (const c of ['C:\\ffmpeg\\bin\\ffprobe.exe', 'C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe']) {
    if (fs.existsSync(c)) {
      cachedFfprobeBin = c;
      return c;
    }
  }

  cachedFfprobeBin = 'ffprobe';
  return 'ffprobe';
}

function quoteCmdPath(p: string): string {
  return `"${p}"`;
}

function assertShellSafePath(value: string): string {
  if (/["'`$%!?^&|;<>(){}[\]\r\n\u0000]/.test(value)) {
    throw new Error('媒体路径包含不安全字符');
  }
  return value;
}

export function createSafeRenderFilename(requested: unknown): string {
  const requestedStem = path.basename(String(requested || 'render'))
    .replace(/\.mp4$/i, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'render';
  return `${requestedStem}_${randomUUID().slice(0, 12)}.mp4`;
}

// Check if system has FFmpeg CLI installed
export function isFFmpegInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const bin = resolveFfmpegBinary();
    exec(`${quoteCmdPath(bin)} -version`, { timeout: 8000 }, (err) => {
      resolve(!err);
    });
  });
}

export interface FFmpegRenderOptions {
  videoSourceUrl?: string;
  videoSourceUrls?: string[];
  audioSourceUrl?: string;
  targetPath: string;
  aspectRatio?: string;
  subtitles?: Array<{ text: string; at?: string; startSec?: number; endSec?: number }>;
  brandStamp?: string;
}

/** Map /uploads/... or relative paths to absolute disk paths */
export function resolveMediaPath(urlOrPath: string): string {
  if (!urlOrPath) return '';
  if (path.isAbsolute(urlOrPath) && fs.existsSync(urlOrPath)) return urlOrPath;

  let rel = urlOrPath;
  if (rel.startsWith('http://') || rel.startsWith('https://')) return '';
  if (rel.startsWith('/uploads/')) {
    rel = rel.slice('/uploads/'.length);
    const normalized = path.resolve(uploadsRoot, rel);
    if (normalized !== uploadsRoot && !normalized.startsWith(`${uploadsRoot}${path.sep}`)) {
      console.warn(`[render] Upload path traversal blocked for: ${urlOrPath}`);
      return '';
    }
    return normalized;
  } else if (rel.startsWith('uploads/')) {
    rel = rel.slice('uploads/'.length);
    const normalized = path.resolve(uploadsRoot, rel);
    if (normalized !== uploadsRoot && !normalized.startsWith(`${uploadsRoot}${path.sep}`)) {
      console.warn(`[render] Upload path traversal blocked for: ${urlOrPath}`);
      return '';
    }
    return normalized;
  } else if (rel.startsWith('/')) {
    rel = rel.slice(1);
  }
  const abs = path.join(process.cwd(), rel);
  const normalized = path.resolve(abs);
  const root = path.resolve(process.cwd());
  if (!normalized.startsWith(root)) {
    console.warn(`[render] Path traversal blocked for: ${urlOrPath}`);
    return '';
  }
  return normalized;
}

const remoteMediaDownloads = new Map<string, Promise<string>>();

async function downloadRemoteMedia(
  url: string,
  expectedKind: 'media' | 'video' | 'image',
  cacheScope: string
): Promise<string> {
  let currentUrl = await assertSafeRemoteUrl(url);
  const cacheId = createHash('sha256')
    .update(`${cacheScope}\0${expectedKind}\0${currentUrl}`)
    .digest('hex')
    .slice(0, 40);
  for (const extension of ['.mp4', '.webm', '.audio', '.png', '.jpg', '.webp', '.gif']) {
    const existing = path.join(rendersDir, `remote_${cacheId}${extension}`);
    try {
      if (fs.statSync(existing).size >= 32) return existing;
    } catch {
      // Cache miss.
    }
  }
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
      headers: {
        Accept: expectedKind === 'image'
          ? 'image/png,image/jpeg,image/webp,image/gif'
          : 'video/*,audio/*,application/octet-stream',
      },
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location || redirectCount === 3) {
      throw new Error('远程媒体重定向无效或次数过多');
    }
    currentUrl = await assertSafeRemoteUrl(new URL(location, currentUrl).toString());
  }
  if (!response) throw new Error('远程媒体下载没有响应');
  if (!response.ok || !response.body) {
    throw new Error(`远程媒体下载失败: HTTP ${response.status}`);
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const normalizedContentType = contentType.split(';', 1)[0].trim();
  const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  if (expectedKind === 'image' && !supportedImageTypes.has(normalizedContentType)) {
    throw new Error(`远程内容不是图片: ${contentType || 'missing content-type'}`);
  }
  if (
    expectedKind !== 'image' &&
    contentType &&
    !contentType.startsWith('video/') &&
    !contentType.startsWith('audio/') &&
    !contentType.startsWith('application/octet-stream')
  ) {
    throw new Error(`远程媒体类型不受支持: ${contentType}`);
  }
  if (
    expectedKind === 'video' &&
    contentType &&
    !contentType.startsWith('video/') &&
    !contentType.startsWith('application/octet-stream')
  ) {
    throw new Error(`远程内容不是视频: ${contentType}`);
  }
  const maximumBytes = expectedKind === 'image'
    ? Number(process.env.MAX_REMOTE_IMAGE_BYTES || 20 * 1024 * 1024)
    : Number(process.env.MAX_REMOTE_MEDIA_BYTES || 200 * 1024 * 1024);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maximumBytes) {
    throw new Error(`远程媒体超过大小限制: ${declaredLength} bytes`);
  }

  const extension = contentType.includes('image/png')
    ? '.png'
    : contentType.includes('image/jpeg')
      ? '.jpg'
      : contentType.includes('image/webp')
        ? '.webp'
        : contentType.includes('image/gif')
          ? '.gif'
          : contentType.includes('audio/')
    ? '.audio'
    : contentType.includes('webm')
      ? '.webm'
      : '.mp4';
  const targetPath = path.join(rendersDir, `remote_${cacheId}${extension}`);
  const temporaryPath = `${targetPath}.${randomUUID()}.part`;
  const writer = fs.createWriteStream(temporaryPath, { flags: 'wx' });
  let receivedBytes = 0;
  try {
    for await (const chunk of response.body as any) {
      const buffer = Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maximumBytes) {
        throw new Error(`远程媒体超过大小限制: ${maximumBytes} bytes`);
      }
      if (!writer.write(buffer)) await once(writer, 'drain');
    }
    writer.end();
    await once(writer, 'finish');
    if (receivedBytes < 32) throw new Error('远程媒体内容为空');
    try {
      fs.renameSync(temporaryPath, targetPath);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      fs.unlinkSync(temporaryPath);
    }
    return targetPath;
  } catch (error) {
    writer.destroy();
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

export function cacheRemoteMedia(
  url: string,
  expectedKind: 'media' | 'video' | 'image' = 'media',
  cacheScope = 'shared'
): Promise<string> {
  const key = `${cacheScope}\0${expectedKind}\0${url}`;
  const existing = remoteMediaDownloads.get(key);
  if (existing) return existing;
  const pending = downloadRemoteMedia(url, expectedKind, cacheScope)
    .finally(() => remoteMediaDownloads.delete(key));
  remoteMediaDownloads.set(key, pending);
  return pending;
}

async function prepareMediaPath(urlOrPath: string, ownerId?: string): Promise<string> {
  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    return cacheRemoteMedia(urlOrPath, 'media', ownerId || 'system');
  }
  return resolveMediaPath(urlOrPath);
}

/**
 * Windows FFmpeg often has no fontconfig; drawtext without fontfile crashes.
 * Prefer CJK-capable fonts for brand subtitles.
 */
export function resolveDrawtextFontFile(): string | null {
  const candidates = [
    process.env.FFMPEG_FONTFILE,
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\msyhbd.ttc',
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simsun.ttc',
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\segoeui.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/PingFang.ttc',
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Escape path for FFmpeg filter fontfile= (Windows backslashes → forward, colon escaped) */
function fontfileFilterArg(fontPath: string): string {
  // e.g. C:\Windows\Fonts\msyh.ttc → C\:/Windows/Fonts/msyh.ttc
  return fontPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
}

function drawtextFilter(opts: {
  text: string;
  fontsize: number;
  fontcolor: string;
  boxcolor?: string;
  x: string;
  y: string;
  fontPath?: string | null;
  startSec?: number;
  endSec?: number;
}): string {
  const cleanText = opts.text
    .slice(0, 500)
    .replace(/['":\\[\];,=\r\n]/g, ' ')
    .replace(/%/g, 'pct');
  const parts = [`text='${cleanText}'`, `fontsize=${opts.fontsize}`, `fontcolor=${opts.fontcolor}`];
  if (opts.fontPath) {
    parts.push(`fontfile='${fontfileFilterArg(opts.fontPath)}'`);
  }
  if (opts.boxcolor) {
    parts.push(`box=1:boxcolor=${opts.boxcolor}:boxborderw=10`);
  }
  parts.push(`x=${opts.x}`, `y=${opts.y}`);
  if (opts.startSec !== undefined && opts.endSec !== undefined) {
    parts.push(`enable='between(t\\,${opts.startSec.toFixed(2)}\\,${opts.endSec.toFixed(2)})'`);
  } else if (opts.startSec !== undefined) {
    parts.push(`enable='gte(t\\,${opts.startSec.toFixed(2)})'`);
  }
  return `drawtext=${parts.join(':')}`;
}

// 辅助方法：导出构建包含多轨 Filter Chain 的 FFmpeg 命令，方便单元测试与后端执行
export function buildFFmpegCommand(opts: FFmpegRenderOptions): string {
  const {
    videoSourceUrl = '',
    audioSourceUrl = '',
    targetPath,
    aspectRatio = '9:16',
    subtitles = [],
    brandStamp = '',
  } = opts;

  const resolution = aspectRatio === '9:16' ? '1080:1920' : aspectRatio === '3:4' ? '1080:1440' : '1080:1080';
  const fontPath = resolveDrawtextFontFile();
  const filterChains: string[] = [
    `scale=${resolution}:force_original_aspect_ratio=increase`,
    `crop=${resolution}`,
  ];

  if (Array.isArray(subtitles) && subtitles.length > 0) {
    subtitles.forEach((sub, idx) => {
      if (sub && sub.text) {
        const yOffset = 180 + idx * 45;
        filterChains.push(
          drawtextFilter({
            text: sub.text,
            fontsize: 38,
            fontcolor: 'yellow',
            boxcolor: 'black@0.6',
            x: '(w-tw)/2',
            y: `h-${yOffset}`,
            fontPath,
            startSec: sub.startSec,
            endSec: sub.endSec,
          })
        );
      }
    });
  }

  if (brandStamp) {
    filterChains.push(
      drawtextFilter({
        text: brandStamp,
        fontsize: 28,
        fontcolor: 'white',
        boxcolor: 'darkgreen@0.8',
        x: 'w-tw-40',
        y: '40',
        fontPath,
      })
    );
  }

  const vfStr = filterChains.join(',');

  const bin = quoteCmdPath(resolveFfmpegBinary());
  return `${bin} -y -i "${videoSourceUrl}" -i "${audioSourceUrl}" -vf "${vfStr}" -c:v libx264 -preset ultrafast -c:a aac -shortest "${targetPath}"`;
}

export interface RenderResult {
  success: boolean;
  error?: string;
  data?: {
    filename: string;
    resolution: string;
    format: string;
    duration_sec: number;
    videoUrl: string;
    downloadUrl: string;
    renderEngine: string;
  };
  source?: string;
}

/**
 * Synchronous (awaited) multi-track render & multi-clip concat. Used by /api/render/ffmpeg and pipeline step5.
 */
export async function runFfmpegRender(params: {
  aspectRatio?: string;
  videoSourceUrl?: string;
  videoSourceUrls?: string[];
  audioSourceUrl?: string;
  subtitles?: Array<{ text: string; at?: string; startSec?: number; endSec?: number }>;
  brandStamp?: string;
  outputFilename?: string;
  durationSec?: number;
  ownerId?: string;
  isAdmin?: boolean;
}): Promise<RenderResult> {
  const {
    aspectRatio = '9:16',
    videoSourceUrl = '',
    videoSourceUrls,
    audioSourceUrl = '',
    subtitles = [],
    brandStamp = '',
    outputFilename = `v_${Date.now()}.mp4`,
    durationSec = 4,
    ownerId,
    isAdmin = false,
  } = params;

  const rawUrls: string[] = (Array.isArray(videoSourceUrls) && videoSourceUrls.length > 0)
    ? videoSourceUrls
    : (videoSourceUrl ? [videoSourceUrl] : []);

  if (rawUrls.length === 0) {
    return { success: false, error: '缺少视频源 videoSourceUrl 或 videoSourceUrls' };
  }
  if (rawUrls.length > 20) {
    return { success: false, error: '单次合成最多支持 20 个视频片段' };
  }
  if (
    ownerId &&
    [...rawUrls, audioSourceUrl]
      .filter(Boolean)
      .some((value) => !canUseMediaReference(value, ownerId, isAdmin))
  ) {
    return { success: false, error: 'One or more media files are not accessible to this user' };
  }

  const filename = createSafeRenderFilename(outputFilename);
  const targetPath = path.join(rendersDir, filename);
  const relativeUrl = `/uploads/renders/${filename}`;
  const safeAspectRatio = ['9:16', '3:4', '1:1'].includes(aspectRatio) ? aspectRatio : '9:16';
  const safeDurationSec = Math.min(600, Math.max(1, Number(durationSec) || 4));
  const resolutionText = safeAspectRatio === '9:16' ? '1080x1920' : safeAspectRatio === '3:4' ? '1080x1440' : '1080x1080';
  const resolutionFilter = safeAspectRatio === '9:16' ? '1080:1920' : safeAspectRatio === '3:4' ? '1080:1440' : '1080:1080';

  const resolvedVideoPaths: string[] = [];
  for (const url of rawUrls) {
    let resolved = '';
    try {
      resolved = assertShellSafePath(await prepareMediaPath(url, ownerId));
    } catch (error: any) {
      return { success: false, error: `视频源准备失败: ${error.message || error}` };
    }
    if (!resolved || !fs.existsSync(resolved)) {
      return { success: false, error: `视频源文件不存在: ${url}` };
    }
    resolvedVideoPaths.push(resolved);
  }

  const ffmpegAvailable = await isFFmpegInstalled();
  if (!ffmpegAvailable) {
    return {
      success: false,
      error: '服务端未安装 FFmpeg，无法合成成片。请安装 ffmpeg 后重试。',
    };
  }

  const hasAudio = Boolean(audioSourceUrl);
  let audioPath = '';
  if (hasAudio) {
    try {
      audioPath = assertShellSafePath(await prepareMediaPath(audioSourceUrl!, ownerId));
      if (!audioPath || !fs.existsSync(audioPath)) audioPath = '';
    } catch (error: any) {
      console.warn(`[render] Audio source skipped: ${error.message || error}`);
      audioPath = '';
    }
  }

  const fontPath = resolveDrawtextFontFile();
  const bin = quoteCmdPath(resolveFfmpegBinary());

  try {
    if (resolvedVideoPaths.length > 1) {
      // ---------------- Multi-clip Concat Branch ----------------
      const inputArgs = resolvedVideoPaths.map((p) => `-i "${p}"`).join(' ');
      const audioInputIndex = resolvedVideoPaths.length;
      const fullInputArgs = audioPath
        ? `${inputArgs} -i "${audioPath}"`
        : inputArgs;

      const scaleFilters: string[] = [];
      const concatInputs: string[] = [];
      for (let i = 0; i < resolvedVideoPaths.length; i++) {
        scaleFilters.push(`[${i}:v]scale=${resolutionFilter}:force_original_aspect_ratio=increase,crop=${resolutionFilter},setsar=1[v${i}]`);
        concatInputs.push(`[v${i}]`);
      }

      const concatFilter = `${concatInputs.join('')}concat=n=${resolvedVideoPaths.length}:v=1:a=0[vconcat]`;
      const textFilters: string[] = [];

      (subtitles || []).forEach((sub, idx) => {
        if (sub?.text) {
          textFilters.push(
            drawtextFilter({
              text: sub.text,
              fontsize: 38,
              fontcolor: 'yellow',
              boxcolor: 'black@0.6',
              x: '(w-tw)/2',
              y: `h-${180 + idx * 45}`,
              fontPath,
              startSec: sub.startSec,
              endSec: sub.endSec,
            })
          );
        }
      });

      if (brandStamp) {
        textFilters.push(
          drawtextFilter({
            text: brandStamp,
            fontsize: 28,
            fontcolor: 'white',
            boxcolor: 'darkgreen@0.8',
            x: 'w-tw-40',
            y: '40',
            fontPath,
          })
        );
      }

      const postFilter = textFilters.length > 0 ? `,[vconcat]${textFilters.join(',')}[vout]` : `;[vconcat]null[vout]`;
      const filterComplex = `${scaleFilters.join(';')};${concatFilter}${postFilter}`;

      const audioMap = audioPath ? `-map ${audioInputIndex}:a -c:a aac -shortest` : '-an';
      const cmd = `${bin} -y ${fullInputArgs} -filter_complex "${filterComplex}" -map "[vout]" ${audioMap} -c:v libx264 -preset ultrafast "${targetPath}"`;

      await execAsync(cmd, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
    } else {
      // ---------------- Single Clip Branch ----------------
      const singleVideoPath = resolvedVideoPaths[0];
      if (audioPath) {
        const cmd = buildFFmpegCommand({
          videoSourceUrl: singleVideoPath,
          audioSourceUrl: audioPath,
          targetPath,
          aspectRatio: safeAspectRatio,
          subtitles,
          brandStamp,
        });
        await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
      } else {
        const filters = [
          `scale=${resolutionFilter}:force_original_aspect_ratio=increase`,
          `crop=${resolutionFilter}`,
        ];
        (subtitles || []).forEach((sub, idx) => {
          if (sub?.text) {
            filters.push(
              drawtextFilter({
                text: sub.text,
                fontsize: 38,
                fontcolor: 'yellow',
                boxcolor: 'black@0.6',
                x: '(w-tw)/2',
                y: `h-${180 + idx * 45}`,
                fontPath,
                startSec: sub.startSec,
                endSec: sub.endSec,
              })
            );
          }
        });
        if (brandStamp) {
          filters.push(
            drawtextFilter({
              text: brandStamp,
              fontsize: 28,
              fontcolor: 'white',
              boxcolor: 'darkgreen@0.8',
              x: 'w-tw-40',
              y: '40',
              fontPath,
            })
          );
        }
        const cmd = `${bin} -y -i "${singleVideoPath}" -vf "${filters.join(',')}" -c:v libx264 -preset ultrafast -an -t ${safeDurationSec} "${targetPath}"`;
        await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
      }
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size < 32) {
      return { success: false, error: 'FFmpeg 执行完成但未生成有效 MP4 文件' };
    }
    if (ownerId) registerOwnedMedia(relativeUrl, ownerId, 'render');

    return {
      success: true,
      source: 'ffmpeg',
      data: {
        filename,
        resolution: resolutionText,
        format: 'mp4_h264',
        duration_sec: safeDurationSec,
        videoUrl: relativeUrl,
        downloadUrl: relativeUrl,
        renderEngine: resolvedVideoPaths.length > 1
          ? `Native System FFmpeg (Multi-Shot Concat Filter Chain: ${resolvedVideoPaths.length} clips)`
          : 'Native System FFmpeg (Multi-track Filter Chain)',
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: `FFmpeg 合成失败: ${err.message || String(err)}`,
    };
  }
}

// POST /api/render/ffmpeg — 服务端 FFmpeg 真实视频合成与多片段拼接引擎
renderRouter.post('/ffmpeg', async (req, res) => {
  try {
    const videoSources = Array.isArray(req.body.videoSourceUrls || req.body.videoClips)
      ? (req.body.videoSourceUrls || req.body.videoClips)
      : [];
    const requestedMedia = [
      req.body.videoSourceUrl || '',
      ...videoSources,
      req.body.audioSourceUrl || '',
    ].filter(Boolean);
    const ownerId = req.authUser!.id;
    const isAdmin = req.authUser!.role === 'admin';
    if (requestedMedia.some((value) => !canUseMediaReference(String(value), ownerId, isAdmin))) {
      return res.status(403).json({
        success: false,
        error: 'One or more media files are not accessible to this user',
      });
    }
    const result = await runFfmpegRender({
      aspectRatio: req.body.aspectRatio,
      videoSourceUrl: req.body.videoSourceUrl || '',
      videoSourceUrls: req.body.videoSourceUrls || req.body.videoClips,
      audioSourceUrl: req.body.audioSourceUrl || '',
      subtitles: req.body.subtitles || [],
      brandStamp: req.body.brandStamp || '',
      outputFilename: req.body.outputFilename,
      durationSec: req.body.durationSec,
      ownerId,
      isAdmin,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    return res.json({
      success: true,
      message: 'FFmpeg 多轨字幕与多片段视频拼接完成',
      data: result.data,
      source: result.source,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

import { Router } from 'express';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

export const renderRouter = Router();
const execAsync = promisify(exec);

// Ensure uploads/renders directory exists
const rendersDir = path.join(process.cwd(), 'uploads', 'renders');
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

function quoteCmdPath(p: string): string {
  return `"${p}"`;
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
  videoSourceUrl: string;
  audioSourceUrl: string;
  targetPath: string;
  aspectRatio?: string;
  subtitles?: Array<{ text: string; at?: string }>;
  brandStamp?: string;
}

/** Map /uploads/... or relative paths to absolute disk paths */
export function resolveMediaPath(urlOrPath: string): string {
  if (!urlOrPath) return '';
  if (path.isAbsolute(urlOrPath) && fs.existsSync(urlOrPath)) return urlOrPath;

  let rel = urlOrPath;
  if (rel.startsWith('http://') || rel.startsWith('https://')) {
    // Remote URL — FFmpeg can sometimes fetch; return as-is
    return rel;
  }
  if (rel.startsWith('/uploads/')) {
    rel = rel.slice(1);
  } else if (rel.startsWith('uploads/')) {
    // ok
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
}): string {
  const cleanText = opts.text.replace(/['":\\]/g, ' ').replace(/%/g, 'pct');
  const parts = [`text='${cleanText}'`, `fontsize=${opts.fontsize}`, `fontcolor=${opts.fontcolor}`];
  if (opts.fontPath) {
    parts.push(`fontfile='${fontfileFilterArg(opts.fontPath)}'`);
  }
  if (opts.boxcolor) {
    parts.push(`box=1:boxcolor=${opts.boxcolor}:boxborderw=10`);
  }
  parts.push(`x=${opts.x}`, `y=${opts.y}`);
  return `drawtext=${parts.join(':')}`;
}

// 辅助方法：导出构建包含多轨 Filter Chain 的 FFmpeg 命令，方便单元测试与后端执行
export function buildFFmpegCommand(opts: FFmpegRenderOptions): string {
  const {
    videoSourceUrl,
    audioSourceUrl,
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

  // Keep caller-provided paths as-is so unit tests and dry-runs are stable;
  // runFfmpegRender resolves /uploads/* to absolute disk paths before exec.
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
 * Synchronous (awaited) multi-track render. Used by /api/render/ffmpeg and pipeline step5.
 */
export async function runFfmpegRender(params: {
  aspectRatio?: string;
  videoSourceUrl: string;
  audioSourceUrl?: string;
  subtitles?: Array<{ text: string; at?: string }>;
  brandStamp?: string;
  outputFilename?: string;
  durationSec?: number;
}): Promise<RenderResult> {
  const {
    aspectRatio = '9:16',
    videoSourceUrl = '',
    audioSourceUrl = '',
    subtitles = [],
    brandStamp = '',
    outputFilename = `v_${Date.now()}.mp4`,
    durationSec = 4,
  } = params;

  const filename = outputFilename.endsWith('.mp4') ? outputFilename : `${outputFilename}.mp4`;
  const targetPath = path.join(rendersDir, filename);
  const relativeUrl = `/uploads/renders/${filename}`;
  const resolutionText = aspectRatio === '9:16' ? '1080x1920' : aspectRatio === '3:4' ? '1080x1440' : '1080x1080';

  if (!videoSourceUrl) {
    return { success: false, error: '缺少视频源 videoSourceUrl（请先完成 Step2 图生视频）' };
  }

  const videoPath = resolveMediaPath(videoSourceUrl);
  const isRemoteVideo = videoSourceUrl.startsWith('http://') || videoSourceUrl.startsWith('https://');
  if (!isRemoteVideo && !fs.existsSync(videoPath)) {
    return { success: false, error: `视频源文件不存在: ${videoSourceUrl}` };
  }

  const ffmpegAvailable = await isFFmpegInstalled();
  if (!ffmpegAvailable) {
    return {
      success: false,
      error: '服务端未安装 FFmpeg，无法合成成片。请安装 ffmpeg 后重试。',
    };
  }

  // If no audio, still render video-only with subtitles
  const hasAudio = Boolean(audioSourceUrl);
  let audioPath = hasAudio ? resolveMediaPath(audioSourceUrl!) : '';
  const isRemoteAudio = Boolean(audioSourceUrl && (audioSourceUrl.startsWith('http://') || audioSourceUrl.startsWith('https://')));
  if (hasAudio && !isRemoteAudio && audioPath && !fs.existsSync(audioPath)) {
    // BGM missing on disk — continue video-only rather than hard fail
    audioPath = '';
  }

  try {
    if (audioPath || isRemoteAudio) {
      const resolvedVideoIn = isRemoteVideo ? videoSourceUrl : videoPath;
      const resolvedAudioIn = isRemoteAudio ? audioSourceUrl! : audioPath;
      const cmd = buildFFmpegCommand({
        videoSourceUrl: resolvedVideoIn,
        audioSourceUrl: resolvedAudioIn,
        targetPath,
        aspectRatio,
        subtitles,
        brandStamp,
      });
      await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    } else {
      // Video only + drawtext (must set fontfile on Windows)
      const resolution = aspectRatio === '9:16' ? '1080:1920' : aspectRatio === '3:4' ? '1080:1440' : '1080:1080';
      const fontPath = resolveDrawtextFontFile();
      const filters = [
        `scale=${resolution}:force_original_aspect_ratio=increase`,
        `crop=${resolution}`,
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
      const bin = quoteCmdPath(resolveFfmpegBinary());
      const cmd = `${bin} -y -i "${videoPath}" -vf "${filters.join(',')}" -c:v libx264 -preset ultrafast -an -t ${durationSec} "${targetPath}"`;
      await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size < 32) {
      return { success: false, error: 'FFmpeg 执行完成但未生成有效 MP4 文件' };
    }

    return {
      success: true,
      source: 'ffmpeg',
      data: {
        filename,
        resolution: resolutionText,
        format: 'mp4_h264',
        duration_sec: durationSec,
        videoUrl: relativeUrl,
        downloadUrl: relativeUrl,
        renderEngine: 'Native System FFmpeg (Multi-track Filter Chain)',
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: `FFmpeg 合成失败: ${err.message || String(err)}`,
    };
  }
}

// POST /api/render/ffmpeg — 服务端 FFmpeg 真实视频合成引擎
renderRouter.post('/ffmpeg', async (req, res) => {
  try {
    const result = await runFfmpegRender({
      aspectRatio: req.body.aspectRatio,
      videoSourceUrl: req.body.videoSourceUrl || '',
      audioSourceUrl: req.body.audioSourceUrl || '',
      subtitles: req.body.subtitles || [],
      brandStamp: req.body.brandStamp || '',
      outputFilename: req.body.outputFilename,
      durationSec: req.body.durationSec,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    return res.json({
      success: true,
      message: 'FFmpeg 多轨字幕与水印视频合成完成',
      data: result.data,
      source: result.source,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

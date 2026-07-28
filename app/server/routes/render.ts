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

// Check if system has FFmpeg CLI installed
export function isFFmpegInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('ffmpeg -version', (err) => {
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
  return abs;
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
  const filterChains: string[] = [
    `scale=${resolution}:force_original_aspect_ratio=increase`,
    `crop=${resolution}`,
  ];

  if (Array.isArray(subtitles) && subtitles.length > 0) {
    subtitles.forEach((sub, idx) => {
      if (sub && sub.text) {
        const cleanText = sub.text.replace(/['":\\]/g, ' ');
        const yOffset = 180 + idx * 45;
        filterChains.push(
          `drawtext=text='${cleanText}':fontsize=38:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=10:x=(w-tw)/2:y=h-${yOffset}`
        );
      }
    });
  }

  if (brandStamp) {
    const cleanStamp = brandStamp.replace(/['":\\]/g, ' ');
    filterChains.push(
      `drawtext=text='${cleanStamp}':fontsize=28:fontcolor=white:box=1:boxcolor=darkgreen@0.8:boxborderw=8:x=w-tw-40:y=40`
    );
  }

  const vfStr = filterChains.join(',');

  // Keep caller-provided paths as-is so unit tests and dry-runs are stable;
  // runFfmpegRender resolves /uploads/* to absolute disk paths before exec.
  return `ffmpeg -y -i "${videoSourceUrl}" -i "${audioSourceUrl}" -vf "${vfStr}" -c:v libx264 -preset ultrafast -c:a aac -shortest "${targetPath}"`;
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
      // Video only + drawtext
      const resolution = aspectRatio === '9:16' ? '1080:1920' : aspectRatio === '3:4' ? '1080:1440' : '1080:1080';
      const filters = [
        `scale=${resolution}:force_original_aspect_ratio=increase`,
        `crop=${resolution}`,
      ];
      (subtitles || []).forEach((sub, idx) => {
        if (sub?.text) {
          const cleanText = sub.text.replace(/['":\\]/g, ' ');
          filters.push(
            `drawtext=text='${cleanText}':fontsize=38:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=10:x=(w-tw)/2:y=h-${180 + idx * 45}`
          );
        }
      });
      if (brandStamp) {
        const cleanStamp = brandStamp.replace(/['":\\]/g, ' ');
        filters.push(
          `drawtext=text='${cleanStamp}':fontsize=28:fontcolor=white:box=1:boxcolor=darkgreen@0.8:boxborderw=8:x=w-tw-40:y=40`
        );
      }
      const cmd = `ffmpeg -y -i "${videoPath}" -vf "${filters.join(',')}" -c:v libx264 -preset ultrafast -an -t ${durationSec} "${targetPath}"`;
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

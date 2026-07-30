import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFfmpegBinary, resolveFfprobeBinary, resolveMediaPath } from '../routes/render';
import { db } from './db';

const execFileAsync = promisify(execFile);

export interface VideoPreprocessResult {
  videoId?: string;
  videoPath?: string;
  duration: number;
  resolution: string;
  fps: number;
  keyframeTimestamps: number[];
  keyframeUrls: string[];
  sceneChanges: number[];
  audioDuration?: number;
  format?: string;
}

const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
const keyframesDir = path.join(uploadsRoot, 'materials', 'keyframes');
if (!fs.existsSync(keyframesDir)) {
  fs.mkdirSync(keyframesDir, { recursive: true });
}

export async function preprocessVideo(videoPathInput: string, videoIdInput?: string): Promise<VideoPreprocessResult> {
  const mediaPath = resolveMediaPath(videoPathInput);
  const videoId = videoIdInput || `vid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const ffprobeBin = resolveFfprobeBinary();
  const ffmpegBin = resolveFfmpegBinary();

  if (!fs.existsSync(mediaPath)) {
    throw new Error(`Video file does not exist on disk: ${videoPathInput} -> ${mediaPath}`);
  }

  let duration = 0;
  let width = 0;
  let height = 0;
  let fps = 0;
  let formatName = 'mp4';

  try {
    // 1. Get metadata using ffprobe.exe
    const { stdout: probeOutput } = await execFileAsync(
      ffprobeBin,
      ['-v', 'error', '-show_entries', 'format=duration,format_name', '-show_streams', '-of', 'json', mediaPath],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );
    const probeData = JSON.parse(probeOutput);

    if (probeData.format) {
      duration = parseFloat(probeData.format.duration || '0');
      formatName = probeData.format.format_name || 'unknown';
    }

    if (Array.isArray(probeData.streams)) {
      const videoStream = probeData.streams.find((s: any) => s.codec_type === 'video') || probeData.streams[0];
      if (videoStream) {
        width = videoStream.width || videoStream.codec_width || 0;
        height = videoStream.height || videoStream.codec_height || 0;
        if (videoStream.r_frame_rate) {
          const parts = videoStream.r_frame_rate.split('/');
          if (parts.length === 2 && Number(parts[1]) > 0) {
            fps = Math.round((Number(parts[0]) / Number(parts[1])) * 100) / 100;
          } else {
            fps = parseFloat(videoStream.r_frame_rate) || 0;
          }
        }
      }
    }
  } catch (err: any) {
    console.warn(`[video-preprocessor] ffprobe metadata extraction failed for ${mediaPath}:`, err.message);
    duration = duration || 10;
  }

  if (duration <= 0) duration = 10;

  // 2. Extract keyframe timestamps (evenly distributed 3 to 6 keyframes)
  const numKeyframes = Math.min(6, Math.max(3, Math.floor(duration / 3)));
  const keyframeTimestamps: number[] = [];
  for (let i = 1; i <= numKeyframes; i++) {
    const t = Math.round((duration * i) / (numKeyframes + 1) * 100) / 100;
    keyframeTimestamps.push(t);
  }

  // 3. Extract actual keyframe image files to uploads/materials/keyframes/
  const keyframeUrls: string[] = [];
  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');

  for (let i = 0; i < keyframeTimestamps.length; i++) {
    const t = keyframeTimestamps[i];
    const filename = `kf_${safeId}_${i + 1}_${t.toFixed(1)}s.jpg`;
    const outputPath = path.join(keyframesDir, filename);
    const webUrl = `/uploads/materials/keyframes/${filename}`;

    try {
      await execFileAsync(
        ffmpegBin,
        ['-y', '-ss', String(t), '-i', mediaPath, '-vframes', '1', '-q:v', '2', outputPath],
        { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
      );
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        keyframeUrls.push(webUrl);
      }
    } catch (err: any) {
      console.warn(`[video-preprocessor] Failed to extract keyframe at t=${t}s:`, err.message);
    }
  }

  // 4. Scene change detection (approximate keyframe PTS times via ffprobe)
  const sceneChanges: number[] = [];
  try {
    const { stdout } = await execFileAsync(
      ffprobeBin,
      ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', mediaPath],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );
    const sceneOutput = stdout.trim();
    if (sceneOutput) {
      sceneOutput.split('\n').forEach((line) => {
        const pts = parseFloat(line.trim());
        if (!isNaN(pts) && pts > 0 && pts < duration) {
          sceneChanges.push(Math.round(pts * 100) / 100);
        }
      });
    }
  } catch (err: any) {
    console.warn(`[video-preprocessor] Scene change detection warning:`, err.message);
  }

  const result: VideoPreprocessResult = {
    videoId,
    videoPath: videoPathInput,
    duration: Math.round(duration * 100) / 100,
    resolution: width && height ? `${width}x${height}` : '1080x1920',
    fps: fps || 30,
    keyframeTimestamps,
    keyframeUrls,
    sceneChanges: Array.from(new Set(sceneChanges)).sort((a, b) => a - b),
    audioDuration: Math.round(duration * 100) / 100,
    format: formatName,
  };

  return result;
}

export async function getVideoPreprocessCache(videoIdOrPath: string): Promise<VideoPreprocessResult | null> {
  try {
    const stmt = db.prepare('SELECT * FROM video_preprocess_cache WHERE id = ? OR video_path = ?');
    const row = stmt.get(videoIdOrPath, videoIdOrPath) as any;
    if (!row) return null;

    return {
      videoId: row.id,
      videoPath: row.video_path,
      duration: Number(row.duration || 0),
      resolution: row.resolution || 'unknown',
      fps: Number(row.fps || 0),
      keyframeTimestamps: JSON.parse(row.keyframe_timestamps || '[]'),
      keyframeUrls: JSON.parse(row.keyframe_urls || '[]'),
      sceneChanges: JSON.parse(row.scene_changes || '[]'),
      audioDuration: Number(row.duration || 0),
    };
  } catch (err: any) {
    console.warn('[video-preprocessor] Cache query error:', err.message);
    return null;
  }
}

export async function saveVideoPreprocessResult(videoIdOrPath: string, result: VideoPreprocessResult): Promise<void> {
  try {
    const id = result.videoId || videoIdOrPath;
    const videoPath = result.videoPath || videoIdOrPath;
    const stmt = db.prepare(`
      INSERT INTO video_preprocess_cache (
        id, video_path, duration, resolution, fps, keyframe_timestamps, keyframe_urls, scene_changes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        video_path = excluded.video_path,
        duration = excluded.duration,
        resolution = excluded.resolution,
        fps = excluded.fps,
        keyframe_timestamps = excluded.keyframe_timestamps,
        keyframe_urls = excluded.keyframe_urls,
        scene_changes = excluded.scene_changes,
        created_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      id,
      videoPath,
      result.duration,
      result.resolution,
      result.fps,
      JSON.stringify(result.keyframeTimestamps || []),
      JSON.stringify(result.keyframeUrls || []),
      JSON.stringify(result.sceneChanges || [])
    );
  } catch (err: any) {
    console.error('[video-preprocessor] Cache save failed:', err.message);
  }
}

/**
 * viral-audio-probe — P0 音轨存在性与 ASR 验证（深模块）。
 *
 * 职责：
 * - hasAudioTrack：ffprobe 判定结果视频是否含音轨（generateAudio 语义验证）；
 * - extractAudioWav：ffmpeg 抽取音轨为 16k wav（ASR 输入）；
 * - transcribeAudio：探测云雾 /audio/transcriptions（whisper 类）完成中文转写。
 *   不可用 → 如实返回 { ok:false, reason }，绝不伪造可懂性结论
 *   （P0 验收：ASR 不可用即把 mandarinSpeechIntelligibility 标为 unverified）。
 *
 * ASR 请求经注入的 AsrClient 接口执行（测试 Fake；真实实现走云雾 OpenAI 兼容
 * 音频转写端点），本模块不直接持有密钥。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFfmpegBinary, resolveFfprobeBinary } from '../routes/render';

const execFileAsync = promisify(execFile);

export const ASR_PROBE_VERSION = 'v1';

export interface AudioTrackInfo {
  hasAudio: boolean;
  /** ffprobe -select_streams a:0 的时长（秒；无音轨为 0） */
  audioDurationSec: number;
  /** 音轨编码（aac / opus / ...；无音轨为 null） */
  codec: string | null;
  /** ffprobe 失败时的原因（true 表示有音轨但探测失败） */
  error?: string;
}

export interface TranscriptionResult {
  ok: boolean;
  /** 转写文本（ok=false 时为 null） */
  text: string | null;
  /** 语义是否与给定 spokenLine 相符（由调用方或 scorer 判定） */
  semanticMatch: boolean | null;
  reason: string;
  provider: string;
  modelUsed: string | null;
}

/** ASR 客户端端口（真实实现走云雾 /audio/transcriptions；测试用 Fake） */
export interface AsrClient {
  readonly name: string;
  readonly available: boolean;
  transcribeWav(localWavPath: string): Promise<{
    ok: boolean;
    text: string | null;
    reason: string;
    modelUsed?: string | null;
  }>;
}

/** 云雾 OpenAI 兼容音频转写实现（whisper 类端点） */
export class YunwuAsrClient implements AsrClient {
  readonly name = 'yunwu-asr';
  constructor(
    private readonly config: {
      baseUrl?: string;
      apiKey?: string;
    } = {}
  ) {}

  get available(): boolean {
    const baseUrl = (this.config.baseUrl || process.env.YUNWU_BASE_URL || '').replace(/\/$/, '');
    const apiKey = this.config.apiKey || process.env.YUNWU_API_KEY || '';
    return Boolean(baseUrl && apiKey && apiKey !== 'your_yunwu_api_key');
  }

  async transcribeWav(localWavPath: string): Promise<{
    ok: boolean;
    text: string | null;
    reason: string;
    modelUsed?: string | null;
  }> {
    if (!fs.existsSync(localWavPath)) {
      return { ok: false, text: null, reason: 'wav 文件不存在，无法转写' };
    }
    const baseUrl = (this.config.baseUrl || process.env.YUNWU_BASE_URL || '').replace(/\/$/, '');
    const apiKey = this.config.apiKey || process.env.YUNWU_API_KEY || '';
    if (!this.available) {
      return { ok: false, text: null, reason: 'ASR 未配置（缺少 baseUrl/apiKey），如实标记 unverified' };
    }
    try {
      const buffer = fs.readFileSync(localWavPath);
      const fd = new FormData();
      fd.append('file', new Blob([buffer], { type: 'audio/wav' }), path.basename(localWavPath));
      fd.append('model', process.env.ASR_MODEL || 'whisper-1');
      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fd,
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          text: null,
          reason: `ASR HTTP ${res.status}: ${text.slice(0, 300)}（如实标记 unverified）`,
        };
      }
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const transcript = json?.text || (json && typeof json === 'string' ? json : null);
      if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
        return { ok: false, text: null, reason: 'ASR 返回空转写（无有效语音内容）' };
      }
      return {
        ok: true,
        text: transcript.trim(),
        reason: 'ASR 转写成功',
        modelUsed: json?.model || 'whisper-1',
      };
    } catch (err: any) {
      return {
        ok: false,
        text: null,
        reason: `ASR 调用失败：${err?.message || String(err)}（如实标记 unverified）`,
      };
    }
  }
}

/** 测试用确定性 Fake（可用/不可用两种形态） */
export class FakeAsrClient implements AsrClient {
  readonly name = 'fake-asr';
  constructor(
    private readonly opts: {
      available?: boolean;
      transcript?: string;
      fail?: boolean;
    } = {}
  ) {}

  get available(): boolean {
    return this.opts.available ?? true;
  }

  async transcribeWav(_localWavPath: string): Promise<{
    ok: boolean;
    text: string | null;
    reason: string;
    modelUsed?: string | null;
  }> {
    if (this.opts.fail || !this.available) {
      return { ok: false, text: null, reason: 'Fake ASR 不可用（测试注入）' };
    }
    return {
      ok: true,
      text: this.opts.transcript ?? '这是测试转写文本',
      reason: 'Fake ASR 转写成功（测试注入）',
      modelUsed: 'fake-whisper',
    };
  }
}

/** 语义相符判定：normalize 后 spokenLine 的关键字是否出现在转写中（≥1 命中即相符） */
export function semanticMatchesSpokenLine(transcript: string | null, spokenLine: string): boolean {
  if (!transcript || !spokenLine) return false;
  const norm = (s: string) => s.replace(/[，。！？、,.!?：:；;\s]/g, '');
  const t = norm(transcript);
  const line = norm(spokenLine);
  if (!line) return false;
  if (t.includes(line)) return true;
  // 拆关键字：中文 2 字词级匹配（≥1 命中即认为语义相关；避免整句逐字比对过严）
  const keys = Array.from(line).filter((ch) => /[\u4e00-\u9fa5]/.test(ch));
  const windows: string[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    windows.push(keys[i] + keys[i + 1]);
  }
  return windows.some((w) => t.includes(w));
}

/** ffprobe 判定音轨存在性与时长 */
export async function hasAudioTrack(localVideoPath: string): Promise<AudioTrackInfo> {
  const ffprobeBin = resolveFfprobeBinary();
  try {
    const { stdout } = await execFileAsync(
      ffprobeBin,
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,duration', '-of', 'json', localVideoPath],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const probe = JSON.parse(stdout);
    const stream = (probe.streams || [])[0];
    if (!stream) {
      return { hasAudio: false, audioDurationSec: 0, codec: null };
    }
    return {
      hasAudio: true,
      audioDurationSec: Number(stream.duration || 0),
      codec: String(stream.codec_name || 'unknown'),
    };
  } catch (err: any) {
    return { hasAudio: false, audioDurationSec: 0, codec: null, error: err?.message || String(err) };
  }
}

/** ffmpeg 抽取音轨为 16k mono wav（ASR 输入），返回本地路径 */
export async function extractAudioWav(
  localVideoPath: string,
  outDir?: string
): Promise<string | null> {
  const ffmpegBin = resolveFfmpegBinary();
  const dir = outDir || path.join(path.dirname(localVideoPath), 'asr');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `asr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.wav`);
  try {
    await execFileAsync(
      ffmpegBin,
      ['-y', '-i', localVideoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;
    return null;
  } catch (err: any) {
    console.warn('[viral-audio-probe] 音轨抽取失败:', err?.message || String(err));
    return null;
  }
}

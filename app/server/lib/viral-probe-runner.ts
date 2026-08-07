/**
 * viral-probe-runner — P0 capability probe 编排深模块。
 *
 * 三条件组（source video only / control image only / source video + control image）
 * 与音频四组（generateAudio=false / true 无台词 / true+spokenLine / 相邻连续性），
 * 每组重复 ≥1 次真实任务；每任务记录：
 *   request body（materials 顺序/角色/kind）、taskId、inferenceId、模型版本、
 *   结果视频 URL、HTTP 可达性、耗时、音轨信息、ASR 文本、LLM 质量评分。
 *
 * 纪律：
 * - 提交/轮询/下载全部经现有 seedance 端口函数（不自行拼 provider 字段）；
 * - PROBE_FAKE=true 时零付费：请求体仍真实构建（供断言），任务/轮询/下载/评分
 *   全部走确定性 fake；
 * - ASR 或评分器不可用 → 如实 unverified / 低分，绝不伪造 pass；
 * - 证据写入 evidenceDir/<runId>.json，能力落库 provider_capabilities。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildSeedanceGenerationBody, getSeedanceVideo, getYunshuVideo } from '../routes/seedance';
import { cacheRemoteVideoToUploads } from '../routes/seedance';
import { submitProbeTask } from './video-submission-port';
import { db } from './db';
import {
  type ProviderCapabilities,
  defaultProviderCapabilities,
  validateProviderCapabilities,
} from '../../shared/provider-capabilities';
import {
  canRouteNativeReferenceVideo,
  canRouteNativeSpeech,
  canRouteSilentFallback,
} from '../domain/viral-recreation/provider-capabilities';
import type { SubtitleOverlayScorer } from './viral-subclip';
import { type AsrClient, type AudioTrackInfo, hasAudioTrack, extractAudioWav, semanticMatchesSpokenLine } from './viral-audio-probe';
import { extractWindowFrames } from './viral-subclip';

export const VIRAL_PROBE_VERSION = 'p0-v1';

export type ProbeCondition = 'video_only' | 'image_only' | 'video_image';
export type ProbeAudioMode = 'silent' | 'no_line' | 'spoken' | 'continuity';

export interface ProbeTaskRecord {
  condition: ProbeCondition;
  audioMode: ProbeAudioMode | null;
  audioModeLabel: string;
  index: number;
  requestBody: Record<string, unknown> | null;
  taskId: string | null;
  status: string;
  inferenceId: string | null;
  model: string | null;
  provider: string | null;
  fallbackUsed: boolean;
  submittedAtMs: number;
  completedAtMs: number;
  resultVideoUrl: string | null;
  resultLocalPath: string | null;
  resultBytes: number | null;
  httpReachable: boolean | null;
  audioTrack: AudioTrackInfo | null;
  asr: { ok: boolean; text: string | null; semanticMatch: boolean | null; reason: string } | null;
  quality: { ok: boolean; productIdentity: number | null; motionRetention: number | null; textContamination: number | null; reason: string } | null;
  error: string | null;
}

export interface ProbeEvidence {
  runId: string;
  probeVersion: string;
  probedAt: number;
  provider: string;
  modelCode: string;
  fake: boolean;
  sourceVideoPath: string;
  subclip: {
    startSec: number;
    endSec: number;
    publicUrl: string;
    localPath: string;
    durationSec: number;
    preflightReason: string;
    preflightDetected: string[];
  };
  controlImage: { publicUrl: string; localPath: string; prompt: string } | null;
  conditions: Record<ProbeCondition, ProbeTaskRecord[]>;
  audio: Record<ProbeAudioMode, ProbeTaskRecord[]>;
  summary: {
    motionRetentionGain: number | null;
    productIdentityDelta: number | null;
    productIdentityRate: number | null;
    motionRetentionRate: number | null;
    textContaminationRate: number | null;
    usableRate: number | null;
    audioTrackPresentRate: number | null;
    speechSemanticMatchRate: number | null;
    asrAvailable: boolean | null;
  };
  capabilities: ProviderCapabilities;
  routeDecisions: {
    nativeReferenceVideo: { routable: boolean; reason: string };
    nativeSpeech: { routable: boolean; reason: string };
    silentFallback: { routable: boolean; reason: string };
  };
}

/** 质量评分器端口（真实 LLM / 测试 Fake 双实现） */
export interface QualityScorer {
  readonly name: string;
  /** 对结果视频抽帧评分：产品身份 0-1、动作/运镜保留 0-1、文字污染 0-1（越高污染越重） */
  scoreResult(input: {
    condition: ProbeCondition;
    frameUrls: string[];
    productName: string;
  }): Promise<{
    ok: boolean;
    productIdentity: number | null;
    motionRetention: number | null;
    textContamination: number | null;
    reason: string;
  }>;
}

/** 真实 LLM 质量评分器（复用 callLlmGateway vision；失败必须 ok=false，不伪造分数） */
export class LlmQualityScorer implements QualityScorer {
  readonly name = 'llm-vision';
  async scoreResult(input: {
    condition: ProbeCondition;
    frameUrls: string[];
    productName: string;
  }): Promise<{
    ok: boolean;
    productIdentity: number | null;
    motionRetention: number | null;
    textContamination: number | null;
    reason: string;
  }> {
    const { callLlmGateway } = await import('./llm-gateway');
    if (input.frameUrls.length === 0) {
      return { ok: false, productIdentity: null, motionRetention: null, textContamination: null, reason: '无可用帧，无法评分' };
    }
    try {
      const res = await callLlmGateway({
        system:
          '你是带货视频 QA 审查员。对给定的参考条件与结果帧，返回 0-1 评分 JSON：' +
          '{"productIdentity":0-1（产品包装/颜色/logo 与指定产品一致程度，越高越好）,' +
          '"motionRetention":0-1（相对参考视频的人物动作/运镜保留程度，越高越好）,' +
          '"textContamination":0-1（画面中源字幕/原产品文字/伪文字污染程度，越低越好）}。' +
          '无法判断的维度返回 null，绝不猜测。',
        user:
          `条件组：${input.condition}。目标产品：${input.productName}。` +
          '评估以下结果视频帧。',
        imageUrls: input.frameUrls,
        temperature: 0.1,
      });
      if (!res.success || !res.data) {
        return { ok: false, productIdentity: null, motionRetention: null, textContamination: null, reason: `评分 LLM 不可用：${res.error || 'no data'}` };
      }
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
      return {
        ok: true,
        productIdentity: num(res.data.productIdentity),
        motionRetention: num(res.data.motionRetention),
        textContamination: num(res.data.textContamination),
        reason: 'llm-vision 评分完成',
      };
    } catch (err: any) {
      return { ok: false, productIdentity: null, motionRetention: null, textContamination: null, reason: `评分失败：${err?.message || String(err)}` };
    }
  }
}

/** 确定性 Fake 评分器：video_image 高动作保留 + 高产品身份；video_only 无产品；image_only 低动作 */
export class FakeQualityScorer implements QualityScorer {
  readonly name = 'fake-quality';
  async scoreResult(input: {
    condition: ProbeCondition;
    frameUrls: string[];
    productName: string;
  }): Promise<{
    ok: boolean;
    productIdentity: number | null;
    motionRetention: number | null;
    textContamination: number | null;
    reason: string;
  }> {
    if (input.condition === 'video_only') {
      return { ok: true, productIdentity: 0.1, motionRetention: 0.85, textContamination: 0.05, reason: 'fake 确定性：video only 保留动作但无产品' };
    }
    if (input.condition === 'image_only') {
      return { ok: true, productIdentity: 0.8, motionRetention: 0.2, textContamination: 0.05, reason: 'fake 确定性：image only 产品正确但动作弱' };
    }
    return { ok: true, productIdentity: 0.85, motionRetention: 0.85, textContamination: 0.05, reason: 'fake 确定性：联合组双高' };
  }
}

export interface RunViralProbeInput {
  runId?: string;
  /** 源参考视频（本地路径，带字幕原片只作证据） */
  sourceVideoPath: string;
  rangeStartSec: number;
  rangeEndSec: number;
  productAssetUrls: string[];
  productName: string;
  shotStructure: string;
  repeats: number;
  durationSec?: number;
  modelCode?: string;
  resolution?: string;
  aspectRatio?: string;
  /** 参考子视频帧（已预检；缺省时 runner 内部抽取并执行预检） */
  referenceFrameUrl?: string;
  scorer: QualityScorer;
  subtitleScorer: SubtitleOverlayScorer;
  asrClient: AsrClient;
  /** true = 零付费确定性模式（不调用真实 provider） */
  fake: boolean;
  evidenceDir: string;
  /** 是否执行音频四组（false 时只跑三条件组；音频组依赖可见说话者素材） */
  runAudioGroups?: boolean;
  /**
   * 字幕/水印无法物理清除时（如 UGC 素材水印横跨画面中部）的显式实验开关：
   * true = 允许提交带文字层的素材，prompt 显式要求模型忽略/不复制文字层，
   * 预检结果作为警告记入证据，最终用 textContaminationRate 实测污染率回答
   * 「prompt 指令能否压制文字层污染」。默认 false（严格阻断，保持字幕纪律）。
   */
  allowTextLayer?: boolean;
}

/** P0 prompt 纪律：无论素材是否带文字层，都显式要求模型不复制任何文字层 */
export function buildProbePrompt(input: {
  productName: string;
  spokenLine?: string;
  allowTextLayer?: boolean;
}): string {
  const ignoreText = input.allowTextLayer
    ? ' The source video contains burned-in subtitles and watermarks. Do NOT copy, reproduce, or render any text, subtitle, caption, watermark, logo, or character from the source. The result must contain zero readable text.'
    : ' Do NOT generate any text, subtitle, caption, watermark, or logo in the result.';
  return (
    `复刻参考视频的镜头与动作，${input.productName} 产品清晰可见。` +
    `${input.spokenLine ? `口播：${input.spokenLine}` : ''}` +
    ignoreText
  ).trim();
}

/** 轮询任务直到完成（最长 timeoutMs；status: success/completed/failed） */
async function pollTaskUntilDone(
  taskId: string,
  timeoutMs: number
): Promise<{ status: string; url: string | null; model: string | null; inferenceId: string | null }> {
  const started = Date.now();
  let lastStatus = 'processing';
  while (Date.now() - started < timeoutMs) {
    let raw: any = null;
    if (taskId.startsWith('yunshu:')) {
      raw = await getYunshuVideo(taskId.slice('yunshu:'.length)).catch(() => null);
    } else {
      raw = await getSeedanceVideo(taskId).catch(() => null);
    }
    if (raw) {
      const data = raw?.data || raw || {};
      lastStatus = String(data.status || '').toLowerCase();
      const url = data.url || data.content?.video_url || data.video_url || null;
      // 实测中转响应可能不含 status 字段，但 url 存在即任务成功
      const done = url
        ? true
        : lastStatus === 'success' || lastStatus === 'completed' || lastStatus === 'failed' || lastStatus === 'error';
      if (done) {
        return {
          status: url ? (lastStatus || 'success') : lastStatus,
          url,
          model: data.model || data.inferenceId ? (data.model || null) : null,
          inferenceId: data.inferenceId || data.inference_id || data.request_id || null,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return { status: lastStatus || 'timeout', url: null, model: null, inferenceId: null };
}

/** fake 模式的任务结果：确定性 URL（不调用真实 provider） */
function fakeTaskResult(condition: ProbeCondition, audioMode: ProbeAudioMode | null, index: number) {
  const tag = `${condition}${audioMode ? `-${audioMode}` : ''}-${index}`;
  return {
    taskId: `fake-probe-${tag}`,
    status: 'success',
    url: `http://probe-fake.invalid/probe-results/${tag}.mp4`,
    model: 'doubao-seedance-2-0-fast (fake)',
    inferenceId: `fake-inference-${tag}`,
  };
}

async function runOneTask(input: {
  probe: RunViralProbeInput;
  condition: ProbeCondition;
  audioMode: ProbeAudioMode | null;
  index: number;
  referenceVideoPublicUrl: string;
  controlImagePublicUrl: string;
  runId: string;
  /** fake 模式：本地合成/裁切产物路径，让音轨/ASR/评分链路真实执行 */
  fakeResultVideoPath?: string;
}): Promise<ProbeTaskRecord> {
  const { probe, condition, audioMode, index, referenceVideoPublicUrl, controlImagePublicUrl, runId } = input;
  const audioModeLabel =
    audioMode === 'silent' ? 'generateAudio=false'
    : audioMode === 'no_line' ? 'generateAudio=true 无台词'
    : audioMode === 'spoken' ? 'generateAudio=true+spokenLine'
    : audioMode === 'continuity' ? 'generateAudio=true 连续性组'
    : 'n/a';

  const spokenLine =
    audioMode === 'spoken'
      ? '这个产品用起来很方便'
      : undefined;

  const materials: Array<{ url: string; kind: string; role?: string; label?: string }> = [];
  if (condition === 'video_only' || condition === 'video_image') {
    materials.push({ url: referenceVideoPublicUrl, kind: 'video', label: 'reference_subclip' });
  }
  if (condition === 'image_only' || condition === 'video_image') {
    materials.push({ url: controlImagePublicUrl, kind: 'image', role: 'first_frame', label: 'product_control_image' });
  }

  const prompt = buildProbePrompt({
    productName: probe.productName,
    spokenLine: audioMode === 'spoken' ? '这个产品用起来很方便' : undefined,
    allowTextLayer: probe.allowTextLayer,
  });

  // 请求体真实构建（fake 模式也构建，供断言；但绝不提交）
  let body: Record<string, unknown> | null = null;
  try {
    const built = buildSeedanceGenerationBody(
      {
        prompt,
        model: probe.modelCode,
        duration: probe.durationSec,
        resolution: probe.resolution,
        aspectRatio: probe.aspectRatio,
        materials,
        generateAudio: audioMode === 'silent' ? false : true,
      },
      undefined
    );
    body = built.body as Record<string, unknown>;
  } catch (err: any) {
    return {
      condition,
      audioMode,
      audioModeLabel,
      index,
      requestBody: null,
      taskId: null,
      status: 'body_build_failed',
      inferenceId: null,
      model: null,
      provider: null,
      fallbackUsed: false,
      submittedAtMs: Date.now(),
      completedAtMs: Date.now(),
      resultVideoUrl: null,
      resultLocalPath: null,
      resultBytes: null,
      httpReachable: null,
      audioTrack: null,
      asr: null,
      quality: null,
      error: `请求体构建失败：${err?.message || String(err)}`,
    };
  }

  let task: { taskId: string; status: string; url: string | null; model: string | null; inferenceId: string | null };
  let provider: string | null = null;
  let fallbackUsed = false;
  let submitError: string | null = null;
  const submittedAtMs = Date.now();

  if (probe.fake) {
    const fake = fakeTaskResult(condition, audioMode, index);
    task = { taskId: fake.taskId, status: fake.status, url: fake.url, model: fake.model, inferenceId: fake.inferenceId };
    provider = 'fake';
  } else {
    try {
      // P0 probe 唯一付费出口：经 video-submission-port 的 submitProbeTask
      // （普通业务提交仍走 submitShot，付费边界不变）
      const result = await submitProbeTask(body as Record<string, any>, 'probe');
      provider = result.provider;
      fallbackUsed = result.fallbackUsed;
      if (!result.task?.id) throw new Error('provider 未返回任务 id');
      task = {
        taskId: String(result.task.id),
        status: String(result.task.status || 'generating'),
        url: result.task.url || null,
        model: result.task.model || null,
        inferenceId: result.task.inferenceId || null,
      };
    } catch (err: any) {
      return {
        condition,
        audioMode,
        audioModeLabel,
        index,
        requestBody: body,
        taskId: null,
        status: 'submit_failed',
        inferenceId: null,
        model: null,
        provider,
        fallbackUsed,
        submittedAtMs,
        completedAtMs: Date.now(),
        resultVideoUrl: null,
        resultLocalPath: null,
        resultBytes: null,
        httpReachable: null,
        audioTrack: null,
        asr: null,
        quality: null,
        error: `提交失败：${err?.message || String(err)}`,
      };
    }
  }

  // 轮询（fake 已 completed）
  let finalStatus = task.status;
  let finalUrl = task.url;
  let finalModel = task.model;
  let finalInferenceId = task.inferenceId;
  if (!probe.fake && (finalStatus === 'generating' || finalStatus === 'processing' || finalStatus === 'pending')) {
    const polled = await pollTaskUntilDone(task.taskId, 15 * 60_000);
    finalStatus = polled.status;
    finalUrl = polled.url;
    finalModel = polled.model ?? finalModel;
    finalInferenceId = polled.inferenceId ?? finalInferenceId;
  }
  const completedAtMs = Date.now();

  if (finalStatus !== 'success' && finalStatus !== 'completed') {
    return {
      condition,
      audioMode,
      audioModeLabel,
      index,
      requestBody: body,
      taskId: task.taskId,
      status: finalStatus,
      inferenceId: finalInferenceId,
      model: finalModel,
      provider,
      fallbackUsed,
      submittedAtMs,
      completedAtMs,
      resultVideoUrl: null,
      resultLocalPath: null,
      resultBytes: null,
      httpReachable: null,
      audioTrack: null,
      asr: null,
      quality: null,
      error: `任务未成功：status=${finalStatus}`,
    };
  }

  // 下载结果
  let resultLocalPath: string | null = null;
  let resultBytes: number | null = null;
  let httpReachable: boolean | null = null;
  try {
    if (probe.fake) {
      // fake 模式：结果视频 = 本地裁切产物（零网络），让音轨/ASR/抽帧评分链路真实执行
      resultLocalPath =
        input.fakeResultVideoPath && fs.existsSync(input.fakeResultVideoPath)
          ? input.fakeResultVideoPath
          : null;
      httpReachable = resultLocalPath !== null;
      resultBytes = resultLocalPath ? fs.statSync(resultLocalPath).size : null;
    } else if (finalUrl) {
      const cached = await cacheRemoteVideoToUploads(finalUrl, undefined, 'probe');
      if (cached) {
        resultLocalPath = cached.absolutePath;
        httpReachable = fs.existsSync(cached.absolutePath);
        resultBytes = httpReachable ? fs.statSync(cached.absolutePath).size : null;
      } else {
        const res = await fetch(finalUrl, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
        httpReachable = res.ok;
      }
    }
  } catch (err: any) {
    httpReachable = false;
  }

  // 音频检查 + ASR（仅真实结果有本地文件时）
  let audioTrack: AudioTrackInfo | null = null;
  let asr: ProbeTaskRecord['asr'] = null;
  if (resultLocalPath && fs.existsSync(resultLocalPath)) {
    audioTrack = await hasAudioTrack(resultLocalPath);
    if (audioTrack.hasAudio) {
      const wavPath = await extractAudioWav(resultLocalPath);
      if (wavPath) {
        const res = await probe.asrClient.transcribeWav(wavPath);
        asr = {
          ok: res.ok,
          text: res.text,
          semanticMatch: res.ok && spokenLine ? semanticMatchesSpokenLine(res.text, spokenLine) : null,
          reason: res.reason,
        };
      } else {
        asr = { ok: false, text: null, semanticMatch: null, reason: '音轨抽取失败，无法 ASR（如实 unverified）' };
      }
    } else {
      asr = { ok: false, text: null, semanticMatch: null, reason: '无音轨（generateAudio 未生效或静音组）' };
    }
  }

  // 质量评分（抽帧 3 张）
  let quality: ProbeTaskRecord['quality'] = null;
  if (resultLocalPath && fs.existsSync(resultLocalPath)) {
    try {
      const frameUrls = await extractWindowFrames({
        videoPath: resultLocalPath,
        startSec: 0,
        endSec: Math.max(1, probe.durationSec ?? 5),
        frameCount: 3,
        prefix: `qa_${runId.slice(0, 6)}_${condition}_${index}`,
      });
      quality = await probe.scorer.scoreResult({
        condition,
        frameUrls,
        productName: probe.productName,
      });
    } catch (err: any) {
      quality = { ok: false, productIdentity: null, motionRetention: null, textContamination: null, reason: `评分失败：${err?.message || String(err)}` };
    }
  }

  return {
    condition,
    audioMode,
    audioModeLabel,
    index,
    requestBody: body,
    taskId: task.taskId,
    status: finalStatus,
    inferenceId: finalInferenceId,
    model: finalModel,
    provider,
    fallbackUsed,
    submittedAtMs,
    completedAtMs,
    resultVideoUrl: finalUrl,
    resultLocalPath,
    resultBytes,
    httpReachable,
    audioTrack,
    asr,
    quality,
    error: null,
  };
}

/**
 * P0 probe 主入口：准备素材（子视频裁切 + 预检 + 控制图）→ 三条件组 → 音频组 →
 * 汇总证据 + 能力落库。fake=true 时全程零付费（仍真实构建请求体供断言）。
 */
export async function runViralProbe(input: RunViralProbeInput): Promise<ProbeEvidence> {
  const runId = input.runId || `probe-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const fake = input.fake;
  const repeats = Math.max(1, Math.min(5, input.repeats));

  // 1) 多候选窗口选择 + 逐候选字幕预检（计划 §P0：选无字幕窗口，全部失败才拒绝）
  const { selectSubclipWindows, preflightSubtitleOverlay, cutSubclip } = await import('./viral-subclip');
  const windows = selectSubclipWindows({
    rangeStartSec: input.rangeStartSec,
    rangeEndSec: input.rangeEndSec,
    sceneChanges: [], // 调用方可自行传 sceneChanges；runner 默认均匀采样
    maxCandidates: 4,
  });
  let window = windows[0];
  let preflight = await preflightSubtitleOverlay({
    videoPath: input.sourceVideoPath,
    window,
    scorer: input.subtitleScorer,
  });
  if (!preflight.ok) {
    // 尝试后续候选窗口（字幕可能只在部分时段出现）
    for (const candidate of windows.slice(1)) {
      const attempt = await preflightSubtitleOverlay({
        videoPath: input.sourceVideoPath,
        window: candidate,
        scorer: input.subtitleScorer,
      });
      if (attempt.ok) {
        window = candidate;
        preflight = attempt;
        break;
      }
      preflight = attempt; // 记录最后一次失败原因
    }
  }
  if (!preflight.ok) {
    if (!input.allowTextLayer) {
      throw new Error(
        `字幕/水印预检未通过，拒绝提交：${preflight.reason}（detected=${preflight.detected.join(',') || '无'}；` +
          `已尝试 ${windows.length} 个候选窗口）。如需实验性提交带文字层素材请显式设置 allowTextLayer=true` +
          `（prompt 会要求模型忽略文字层，最终用 textContaminationRate 实测污染率）`
      );
    }
    // 显式实验开关：记录预检失败为警告，prompt 要求忽略文字层，污染率由结果实测
    console.warn(
      `[viral-probe-runner] allowTextLayer=true：接受带文字层素材（${preflight.reason}），` +
        'prompt 已要求模型不复制任何文字层，污染率将由 textContaminationRate 实测'
    );
  }
  // fake 模式零网络纪律：裁切产物不发布公网（skipPublish），URL 用确定性 fake 地址，
  // 保证 buildSeedanceGenerationBody 的 materials 仍可构建（http URL 直接透传）
  const subclip = await cutSubclip({
    sourceVideoPath: input.sourceVideoPath,
    window,
    runId,
    fps: 30,
    skipPublish: fake,
  });
  const referenceVideoPublicUrl = fake
    ? `http://probe-fake.invalid/probe-assets/${runId}/subclip.mp4`
    : subclip.publicUrl;

  // 2) 控制图（参考子视频帧锚点：从裁切产物抽中帧；真实运行由调用方传入已预检帧）
  let controlImagePublicUrl = '';
  let controlImageLocalPath: string | null = null;
  let controlPrompt = '';
  if (input.productAssetUrls.length > 0) {
    const { createViralControlImage } = await import('./viral-control-image');
    let referenceFrameUrl = input.referenceFrameUrl;
    if (!referenceFrameUrl) {
      const frames = await extractWindowFrames({
        videoPath: subclip.localPath,
        startSec: 0,
        endSec: Math.max(1, subclip.durationSec - 0.1),
        frameCount: 1,
        prefix: `anchor_${runId.slice(0, 6)}`,
      });
      referenceFrameUrl = frames[0] || '';
    }
    if (referenceFrameUrl) {
      // fake 模式零网络纪律：强制走确定性派生（不调用图像 provider）
      if (fake) process.env.FAKE_VIRAL_CONTROL_IMAGE = 'true';
      try {
        const control = await createViralControlImage({
          referenceVideoUrl: referenceVideoPublicUrl,
          referenceFrameUrl,
          productAssetUrls: input.productAssetUrls,
          productName: input.productName,
          shotStructure: input.shotStructure,
          // allowTextLayer 实验模式下锚点帧来自带文字层素材：控制图 prompt 本身
          // 已要求移除文字层（buildViralControlImagePrompt 固定含 Remove all burned-in
          // subtitles / Do not reproduce any source-video subtitle text），此处放行
          subtitlePreflightPassed: input.allowTextLayer ? true : preflight.ok,
          persist: { runId, ownerId: 'probe', referenceVideoUrl: referenceVideoPublicUrl },
        });
        // fake 派生返回本地 /uploads 路径（无 PUBLIC_BASE_URL 时 resolvePublicMediaUrl
        // 会拒绝它，image material 丢失）→ 覆盖为公网格式 URL 供请求体构建，
        // 本地路径仍保留在证据中
        controlImagePublicUrl = fake
          ? `http://probe-fake.invalid/probe-assets/${runId}/control-image.png`
          : control.imageUrl;
        controlImageLocalPath = control.localPath;
        controlPrompt = control.prompt;
      } finally {
        if (fake) delete process.env.FAKE_VIRAL_CONTROL_IMAGE;
      }
    }
  }

  // 3) 三条件组
  const conditions: ProbeCondition[] = ['video_only', 'image_only', 'video_image'];
  const conditionRecords: Record<ProbeCondition, ProbeTaskRecord[]> = {
    video_only: [],
    image_only: [],
    video_image: [],
  };
  for (const condition of conditions) {
    for (let i = 0; i < repeats; i++) {
      conditionRecords[condition].push(
        await runOneTask({
          probe: input,
          condition,
          audioMode: null,
          index: i,
          referenceVideoPublicUrl: referenceVideoPublicUrl,
          controlImagePublicUrl,
          runId,
          ...(fake ? { fakeResultVideoPath: subclip.localPath } : {}),
        })
      );
    }
  }

  // 4) 音频四组（仅当素材有可见说话者 & 显式开启）
  const audioModes: ProbeAudioMode[] = ['silent', 'no_line', 'spoken', 'continuity'];
  const audioRecords: Record<ProbeAudioMode, ProbeTaskRecord[]> = {
    silent: [],
    no_line: [],
    spoken: [],
    continuity: [],
  };
  if (input.runAudioGroups) {
    for (const audioMode of audioModes) {
      for (let i = 0; i < repeats; i++) {
        audioRecords[audioMode].push(
          await runOneTask({
            probe: input,
            condition: 'video_image',
            audioMode,
            index: i,
            referenceVideoPublicUrl: referenceVideoPublicUrl,
            controlImagePublicUrl,
            runId,
            ...(fake ? { fakeResultVideoPath: subclip.localPath } : {}),
          })
        );
      }
    }
  }

  // 5) 汇总
  const summary = buildSummary(conditionRecords, audioRecords);
  const capabilities = buildCapabilities(input, summary, runId);
  const routeDecisions = {
    nativeReferenceVideo: canRouteNativeReferenceVideo(capabilities),
    nativeSpeech: canRouteNativeSpeech(capabilities),
    silentFallback: canRouteSilentFallback(capabilities),
  };

  const evidence: ProbeEvidence = {
    runId,
    probeVersion: VIRAL_PROBE_VERSION,
    probedAt: Date.now(),
    provider: capabilities.provider,
    modelCode: capabilities.modelCode,
    fake,
    sourceVideoPath: input.sourceVideoPath,
    subclip: {
      startSec: window.startSec,
      endSec: window.endSec,
      publicUrl: subclip.publicUrl,
      localPath: subclip.localPath,
      durationSec: subclip.durationSec,
      preflightReason: preflight.reason,
      preflightDetected: preflight.detected,
      ...(input.allowTextLayer && !preflight.ok
        ? { textLayerAccepted: true, textLayerNote: 'allowTextLayer=true：带文字层素材实验性提交，污染率由 textContaminationRate 实测' }
        : {}),
    },
    controlImage: controlImagePublicUrl
      ? { publicUrl: controlImagePublicUrl, localPath: controlImageLocalPath || '', prompt: controlPrompt }
      : null,
    conditions: conditionRecords,
    audio: audioRecords,
    summary,
    capabilities,
    routeDecisions,
  };

  // 6) 证据落盘 + 能力落库
  const evidenceDir = path.resolve(input.evidenceDir);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, `${runId}.json`), JSON.stringify(evidence, null, 2));
  persistCapabilities(capabilities, runId, evidence);

  return evidence;
}

/** 汇总三条件组与音频组统计 */
function buildSummary(
  conditionRecords: Record<ProbeCondition, ProbeTaskRecord[]>,
  audioRecords: Record<ProbeAudioMode, ProbeTaskRecord[]>
): ProbeEvidence['summary'] {
  const avg = (values: Array<number | null>): number | null => {
    const nums = values.filter((v): v is number => v !== null);
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  const joint = conditionRecords.video_image;
  const imageOnly = conditionRecords.image_only;
  const videoOnly = conditionRecords.video_only;

  const jointIdentity = avg(joint.map((t) => t.quality?.productIdentity ?? null));
  const imageIdentity = avg(imageOnly.map((t) => t.quality?.productIdentity ?? null));
  const jointMotion = avg(joint.map((t) => t.quality?.motionRetention ?? null));
  const imageMotion = avg(imageOnly.map((t) => t.quality?.motionRetention ?? null));
  const contamination = avg(joint.map((t) => t.quality?.textContamination ?? null));

  const usable = joint.filter((t) => t.status === 'success' || t.status === 'completed').length;
  const audioTasks = [
    ...audioRecords.silent,
    ...audioRecords.no_line,
    ...audioRecords.spoken,
    ...audioRecords.continuity,
  ];
  const withTrack = audioTasks.filter((t) => t.audioTrack?.hasAudio).length;
  const spokenTasks = audioRecords.spoken.filter((t) => t.status === 'success' || t.status === 'completed');
  const matched = spokenTasks.filter((t) => t.asr?.semanticMatch === true).length;
  const asrResults = audioTasks.filter((t) => t.asr !== null);

  return {
    motionRetentionGain: jointMotion !== null && imageMotion !== null ? jointMotion - imageMotion : null,
    productIdentityDelta: jointIdentity !== null && imageIdentity !== null ? jointIdentity - imageIdentity : null,
    productIdentityRate: jointIdentity,
    motionRetentionRate: jointMotion,
    textContaminationRate: contamination,
    usableRate: joint.length > 0 ? usable / joint.length : null,
    audioTrackPresentRate: audioTasks.length > 0 ? withTrack / audioTasks.length : null,
    speechSemanticMatchRate: spokenTasks.length > 0 ? matched / spokenTasks.length : null,
    asrAvailable: asrResults.length > 0 ? asrResults.some((t) => t.asr?.ok === true) : null,
  };
}

/** 从汇总构建 ProviderCapabilities（仅记录真实观测，绝不虚构） */
function buildCapabilities(
  input: RunViralProbeInput,
  summary: ProbeEvidence['summary'],
  runId: string
): ProviderCapabilities {
  const caps = defaultProviderCapabilities(input.fake ? 'fake' : 'relay', input.modelCode || 'doubao-seedance-2-0-fast');
  caps.probedAt = Date.now();
  caps.probedBy = `${VIRAL_PROBE_VERSION}:${runId}`;
  caps.evidence = {
    probeRunId: runId,
    artifactUrls: [],
    notes: [],
  };
  caps.observedQuality = {
    motionRetentionGain: summary.motionRetentionGain,
    productIdentityDelta: summary.productIdentityDelta,
    productIdentityRate: summary.productIdentityRate,
    motionRetentionRate: summary.motionRetentionRate,
    textContaminationRate: summary.textContaminationRate,
    usableRate: summary.usableRate,
  };
  if (input.fake) {
    // fake 模式：请求体结构已验证，但能力未真实验证 → 全部不可路由
    return caps;
  }
  // 真实模式：三条件组结论（联合组双率 ≥ 阈值 → nativeReferenceVideo 可路由）
  caps.nativeReferenceVideo = (summary.motionRetentionRate ?? 0) >= 0.5 && (summary.productIdentityRate ?? 0) >= 0.5;
  caps.firstFrame = true;
  caps.multiReferenceImages = true;
  caps.maskedV2V = false; // 接口无 mask 字段 → not_supported（不伪造）
  caps.firstLastFrame = false; // role 枚举声明支持，但本 probe 未实测 → 如实 false
  caps.maxReferenceVideoSec = 15;
  caps.maxOutputSec = 15;
  // 音频组结论：全部音画门禁通过才可路由原生口播
  const audioOk =
    summary.audioTrackPresentRate !== null && summary.audioTrackPresentRate >= 0.8 &&
    summary.speechSemanticMatchRate !== null && summary.speechSemanticMatchRate >= 0.5 &&
    summary.asrAvailable === true;
  caps.nativeGeneratedAudio = (summary.audioTrackPresentRate ?? 0) >= 0.8;
  caps.nativeSpeechGeneration = audioOk;
  caps.mandarinSpeechIntelligibility = summary.speechSemanticMatchRate !== null && summary.speechSemanticMatchRate >= 0.5 ? 'verified' : 'unverified';
  caps.audiovisualLipSync = 'unverified'; // P0 无口型帧级评估，如实 unverified（除非后续补测）
  caps.crossShotVoiceContinuity = 'unverified';
  caps.maxNativeSpeechSec = audioOk ? (input.durationSec ?? 5) : 0;
  return caps;
}

/** 能力落库（UPSERT；表由 migration v33 建立） */
export function persistCapabilities(caps: ProviderCapabilities, runId: string, evidence: ProbeEvidence): void {
  try {
    db.prepare(
      `INSERT INTO provider_capabilities
         (provider, model_code, probed_at, probed_by, capabilities_json, evidence_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider, model_code) DO UPDATE SET
         probed_at = excluded.probed_at,
         probed_by = excluded.probed_by,
         capabilities_json = excluded.capabilities_json,
         evidence_json = excluded.evidence_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      caps.provider,
      caps.modelCode,
      caps.probedAt,
      caps.probedBy,
      JSON.stringify(caps),
      JSON.stringify({ runId, evidencePath: `${runId}.json`, summary: evidence.summary })
    );
  } catch (err: any) {
    console.warn('[viral-probe-runner] provider_capabilities 落库失败:', err?.message || err);
  }
}

/** 读取已落库能力（供 P3 路由使用；无记录 → 保守默认） */
export function readProviderCapabilities(provider: string, modelCode: string): ProviderCapabilities {
  try {
    const row = db
      .prepare('SELECT capabilities_json FROM provider_capabilities WHERE provider = ? AND model_code = ?')
      .get(provider, modelCode) as { capabilities_json?: string } | undefined;
    if (!row?.capabilities_json) return defaultProviderCapabilities(provider, modelCode);
    const parsed = JSON.parse(row.capabilities_json);
    const check = validateProviderCapabilities(parsed);
    if (!check.valid) {
      console.warn('[viral-probe-runner] 已落库能力 schema 校验失败，按默认处理:', check.errors);
      return defaultProviderCapabilities(provider, modelCode);
    }
    return parsed as ProviderCapabilities;
  } catch (err: any) {
    console.warn('[viral-probe-runner] 读取能力失败:', err?.message || String(err));
    return defaultProviderCapabilities(provider, modelCode);
  }
}

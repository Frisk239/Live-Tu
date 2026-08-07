/**
 * S2 视频提交端口（provider seam）
 *
 * 所有工作台发起的付费视频提交必须经过此端口：
 * - SeedanceVideoPort：生产实现（包装 server/routes/seedance.ts 现有能力）；
 * - FakeVideoPort：确定性 fake seam，捕获每一次调用（capturedCalls），
 *   测试用它断言「没有隐藏付费提交」；CI/E2E 用 FAKE_VIDEO_PROVIDER=true 激活，绝不触发真实付费。
 *
 * 端口边界 = 付费边界：任何调用方只能通过 submitShot / submitProbeTask 触发 provider 提交。
 */

import {
  buildSeedanceGenerationBody,
  getSeedanceVideo,
  hasSeedanceConfig,
  normalizeSeedanceTask,
  preflightMediaUrl,
  resolvePublicMediaUrl,
  submitSeedanceVideoWithFallback,
} from '../routes/seedance';
import { registerSeedanceTaskOwner } from './seedance-ownership';
import { db } from './db';
import {
  type DeclaredReferenceImage,
  assertReferenceImagesAllowed,
  sourceKeyframeDeclaration,
} from '../adapters/reference-policy-guard';
import {
  type ReferenceAssetKind,
  type ReferenceInputMode,
  ReferencePolicyViolationError,
} from '../domain/reference-policy/reference-input-policy';

export interface ShotSubmissionInput {
  shotId: string;
  runId: string;
  ownerId: string;
  sessionId: string;
  shotIndex: number;
  prompt: string;
  /** provider 模型 code（如 doubao-seedance-2-0-fast） */
  modelCode: string;
  /** catalog 模型 id（如 Seedance 2.0 Fast） */
  modelCatalogId: string;
  durationSec: number;
  resolution: string;
  aspectRatio: string;
  imageUrl: string;
  attempt: number;
  failureReason: string | null;
  /**
   * 首帧（first_frame）的可信来源声明——P5 修复后必须显式给出，且必须来自
   * ensureShotFirstFrame 的可信派生/复用路径（generated_frame / product_shot /
   * owned_scene_anchor），否则按 source_keyframe 拒绝。
   */
  firstFrameKind?: ReferenceAssetKind;
  /**
   * S3 参考素材（role=reference_image）——构图连续性引导。
   * P5 强制出口 2：进入 Seedance payload 前必须通过 ReferenceInputPolicy
   * （默认 semantic_recreation）。声明即发送：referencePolicy.images 与实际发送
   * 的 referenceImageUrls 必须是同一组 URL（错配 = 拒绝），未显式声明时每个 URL
   * 自动声明为 source_keyframe → 直接拒绝，确保原视频关键帧不可能混入。
   */
  referenceImageUrls?: string[];
  /** P5 参考输入策略（覆盖自动声明；仅策略放行的资产可进入 payload） */
  referencePolicy?: {
    mode?: ReferenceInputMode;
    images?: DeclaredReferenceImage[];
  };
}

export interface SubmittedShotTask {
  taskId: string;
  status: 'completed' | 'generating';
  url?: string;
  provider: string;
}

export interface VideoSubmissionPort {
  readonly name: string;
  hasConfig(): boolean;
  preflightImage(url: string): Promise<{ ok: boolean; error?: string }>;
  submitShot(input: ShotSubmissionInput): Promise<SubmittedShotTask>;
  getTask(taskId: string): Promise<{ status: string; url?: string; error?: string }>;
  supportsPaidAcceleration(): boolean;
  /** fake 端口专用：捕获的调用记录（断言无隐藏付费提交/编辑值真正进入 provider） */
  readonly capturedCalls?: ReadonlyArray<{
    shotId: string;
    runId: string;
    attempt: number;
    modelCode: string;
    provider: string;
    prompt?: string;
    imageUrl?: string;
    referenceImageUrls?: string[];
  }>;
}

/**
 * P5 强制出口 2：构建 Seedance reference materials（纯函数）。
 * 声明即发送：实际发送的 URL 必须与通过策略校验的声明是同一组——
 * 校验的是哪组，发送的就是哪组，杜绝「声明安全图、实际发送原视频帧」的错配。
 * 违规 → 抛 ReferencePolicyViolationError，绝不把原视频关键帧/含人脸资产拼进 provider body。
 */
export function buildSubmissionReferenceMaterials(input: {
  referenceImageUrls?: string[];
  referencePolicy?: ShotSubmissionInput['referencePolicy'];
}): Array<{ url: string; kind: string; role: string; label: string }> {
  const urls = (input.referenceImageUrls ?? []).filter((u) => u && u.trim().length > 0);
  const mode = input.referencePolicy?.mode ?? 'semantic_recreation';
  if (urls.length === 0) return [];

  let images = input.referencePolicy?.images;
  if (!images || images.length === 0) {
    // 无显式声明：每个 URL 自动声明为 source_keyframe → 原视频关键帧必被拒绝
    assertReferenceImagesAllowed(urls.map((url) => sourceKeyframeDeclaration(url)), { mode });
    throw new ReferencePolicyViolationError(
      'source_keyframe_to_provider',
      'referenceImageUrls 未提供 referencePolicy.images 声明，按原视频关键帧拒绝'
    );
  }

  // 声明即发送：声明的 URL 集合必须与实际发送集合完全一致（防错配注入）
  const declaredUrls = new Set(images.map((image) => image.url));
  const undeclared = urls.filter((url) => !declaredUrls.has(url));
  if (undeclared.length > 0) {
    throw new ReferencePolicyViolationError(
      'source_keyframe_to_provider',
      `referenceImageUrls 与 referencePolicy.images 不一致（错配）：未声明的 URL: ${undeclared.join(', ')}`
    );
  }
  const declaredOnly = images.filter((image) => urls.includes(image.url));
  if (declaredOnly.length !== images.length) {
    throw new ReferencePolicyViolationError(
      'source_keyframe_to_provider',
      'referencePolicy.images 包含未实际发送的声明，声明与发送必须一一对应'
    );
  }

  // 策略校验通过后，materials 从同一组声明构建
  assertReferenceImagesAllowed(images, { mode });
  const materials: Array<{ url: string; kind: string; role: string; label: string }> = [];
  for (const image of images) {
    const resolvedRef = resolvePublicMediaUrl(image.url);
    if (resolvedRef.url) {
      materials.push({
        url: resolvedRef.url,
        kind: 'image',
        role: 'reference_image',
        label: 'reference_keyframe',
      });
    }
  }
  return materials;
}

// ==================== 生产端口（Seedance 中转） ====================

export class SeedanceVideoPort implements VideoSubmissionPort {
  readonly name = 'seedance-relay';

  hasConfig(): boolean {
    return hasSeedanceConfig();
  }

  async preflightImage(url: string): Promise<{ ok: boolean; error?: string }> {
    const result = await preflightMediaUrl(url);
    return { ok: result.ok, error: result.error };
  }

  async submitShot(input: ShotSubmissionInput): Promise<SubmittedShotTask> {
    // P5 强制出口 2：参考素材（role=reference_image）在进入 provider body 前
    // 必须通过 ReferenceInputPolicy；违规抛错，不发起提交。
    const referenceMaterials = buildSubmissionReferenceMaterials({
      referenceImageUrls: input.referenceImageUrls,
      referencePolicy: input.referencePolicy,
    });
    // 首帧（first_frame）同样进策略：调用方必须给出可信来源声明（generated_frame/
    // product_shot/owned_scene_anchor，来自 ensureShotFirstFrame 的可信路径）；
    // 未声明或声明为 source_keyframe 的原视频帧 → 拒绝。
    if (input.imageUrl) {
      const firstFrameKind = input.firstFrameKind ?? 'source_keyframe';
      assertReferenceImagesAllowed(
        [{ id: 'first-frame', url: input.imageUrl, kind: firstFrameKind }],
        { mode: input.referencePolicy?.mode ?? 'semantic_recreation' }
      );
    }
    const prepared = buildSeedanceGenerationBody(
      {
        prompt: input.prompt,
        model: input.modelCode,
        duration: input.durationSec,
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
        imageUrl: input.imageUrl,
        materials: [
          ...(input.imageUrl
            ? [{ url: input.imageUrl, kind: 'image', role: 'first_frame', label: 'derived_first_frame' }]
            : []),
          ...referenceMaterials,
        ],
      },
      undefined
    );
    if (prepared.materials.length === 0) {
      throw new Error(prepared.warnings[0] || '缺少 Seedance 可下载的首帧图');
    }
    const { task, provider, fallbackUsed } = await submitSeedanceVideoWithFallback(
      prepared.body,
      undefined
    );
    if (!task.id) throw new Error('Seedance 未返回任务 ID');
    registerSeedanceTaskOwner(String(task.id), input.ownerId, 'workbench-shot');
    const status = task.status === 'success' || task.status === 'completed' ? 'completed' : 'generating';
    return {
      taskId: String(task.id),
      status,
      url: task.url || undefined,
      provider: fallbackUsed ? `${provider}+fallback` : provider,
    };
  }

  async getTask(taskId: string): Promise<{ status: string; url?: string; error?: string }> {
    const raw = await getSeedanceVideo(taskId).catch(() => null);
    if (!raw) return { status: 'unknown', error: '查询失败（任务可能不存在或中转未就绪）' };
    const normalized = normalizeSeedanceTask(raw);
    return { status: normalized.status, url: normalized.url || undefined, error: normalized.error || undefined };
  }

  supportsPaidAcceleration(): boolean {
    // 星河 Seedance 中转未提供付费加速通道
    return false;
  }
}

/**
 * P0 probe 专用提交出口：probe runner 的唯一付费提交路径。
 * 与 submitShot 的区别：允许直接提交预构建的 Seedance body（含 kind:'video'
 * 参考子视频 material——P0 capability probe 需要把参考视频作为条件输入）。
 * 仍经过 registerSeedanceTaskOwner 登记归属（可追溯）。
 * 仅允许 P0 probe 编排（viral-probe-runner）调用；普通业务提交一律走 submitShot。
 */
export async function submitProbeTask(
  body: Record<string, any>,
  ownerId = 'probe'
): Promise<{ task: any; provider: string; fallbackUsed: boolean; fallbackError?: Error }> {
  const result = await submitSeedanceVideoWithFallback(body, undefined);
  if (result.task?.id) {
    // probe 归属登记需要 users 外键存在；P0 probe 使用专用 system 账号（幂等注册）
    try {
      db.prepare(
        `INSERT OR IGNORE INTO users (id, username, password_hash, role, enabled)
         VALUES ('probe', 'probe', 'not-used', 'operator', 1)`
      ).run();
    } catch {
      // 表未初始化等异常：归属登记失败仅警告，不阻断 probe（证据仍完整记录）
    }
    try {
      registerSeedanceTaskOwner(String(result.task.id), ownerId, 'viral-probe');
    } catch (err: any) {
      console.warn('[video-submission-port] probe 任务归属登记失败（不影响 probe 证据）:', err?.message || String(err));
    }
  }
  return result;
}

// ==================== Fake 端口（确定性，测试/CI/E2E 专用） ====================

export interface FakePortOptions {
  /** 前 N 次提交模拟 provider_error（验证「2 次重试动作内可恢复」） */
  failNext?: number;
  /** 指定这些 shotId 的提交失败（确定性单镜失败场景） */
  failShotIds?: string[];
  /** 失败时写入的失败原因 */
  failureReason?: string;
  /** 每次提交的固定延迟 ms（默认 0，确定性） */
  delayMs?: number;
}

export class FakeVideoPort implements VideoSubmissionPort {
  readonly name = 'fake';
  readonly capturedCalls: Array<{
    shotId: string;
    runId: string;
    attempt: number;
    modelCode: string;
    provider: string;
    prompt?: string;
    imageUrl?: string;
    referenceImageUrls?: string[];
  }> = [];
  private pendingFails: number;
  private readonly failShotIds: Set<string>;
  private readonly failReason: string;
  private readonly delayMs: number;
  private taskSeq = 0;

  constructor(opts: FakePortOptions = {}) {
    this.pendingFails = opts.failNext ?? 0;
    this.failShotIds = new Set(opts.failShotIds ?? []);
    this.failReason = opts.failureReason ?? 'provider_error';
    this.delayMs = opts.delayMs ?? 0;
  }

  hasConfig(): boolean {
    return true;
  }

  async preflightImage(_url: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async submitShot(input: ShotSubmissionInput): Promise<SubmittedShotTask> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.capturedCalls.push({
      shotId: input.shotId,
      runId: input.runId,
      attempt: input.attempt,
      modelCode: input.modelCode,
      provider: 'fake',
      prompt: input.prompt,
      imageUrl: input.imageUrl,
      referenceImageUrls: [...(input.referenceImageUrls ?? [])],
    });
    if (this.pendingFails > 0) {
      this.pendingFails -= 1;
      console.warn(`[fake-port] failNext 生效：拒绝 shot=${input.shotId} attempt=${input.attempt}（剩余 ${this.pendingFails} 次）`);
      const error = new Error(this.failReason) as Error & { code?: string };
      error.code = this.failReason;
      throw error;
    }
    if (this.failShotIds.has(input.shotId)) {
      const error = new Error(this.failReason) as Error & { code?: string };
      error.code = this.failReason;
      throw error;
    }
    this.taskSeq += 1;
    return {
      taskId: `fake-${this.taskSeq}-${input.shotId.slice(0, 8)}`,
      status: 'completed',
      url: `http://fake.local/videos/fake-${this.taskSeq}.mp4`,
      provider: 'fake',
    };
  }

  async getTask(taskId: string): Promise<{ status: string; url?: string; error?: string }> {
    if (!taskId.startsWith('fake-')) return { status: 'unknown' };
    return { status: 'completed', url: `http://fake.local/videos/${taskId}.mp4` };
  }

  supportsPaidAcceleration(): boolean {
    return false;
  }
}

// ==================== 工厂（环境驱动） ====================

let cachedPort: VideoSubmissionPort | null = null;

/**
 * 全局端口：FAKE_VIDEO_PROVIDER=true（CI/E2E/测试服务器）→ FakeVideoPort；
 * 否则生产 SeedanceVideoPort。单例缓存，测试可调用 resetVideoPort() 重置。
 * FAKE_VIDEO_FAIL_NEXT=n：前 n 次提交模拟 provider_error（e2e 局部重试演示用，确定性）。
 */
export function createVideoSubmissionPort(): VideoSubmissionPort {
  if (process.env.FAKE_VIDEO_PROVIDER === 'true') {
    const failNext = Number(process.env.FAKE_VIDEO_FAIL_NEXT || 0);
    return new FakeVideoPort({
      failNext: Number.isFinite(failNext) && failNext > 0 ? failNext : 0,
      failureReason: process.env.FAKE_VIDEO_FAIL_REASON || 'provider_error',
    });
  }
  return new SeedanceVideoPort();
}

export function getVideoSubmissionPort(): VideoSubmissionPort {
  if (!cachedPort) cachedPort = createVideoSubmissionPort();
  return cachedPort;
}

export function resetVideoSubmissionPort(): void {
  cachedPort = null;
}

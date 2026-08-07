/**
 * S3 镜头首帧保障（派生 + 预检，付费提交前的最后一道闸）
 *
 * 语义：调用付费视频 provider 前，确保该镜存在「产品条件化首帧」且通过预检：
 * 1. 已有派生首帧（first_frame_url/derived_first_frame_url）→ 复用并预检；
 * 2. 没有 → 用 参考关键帧（构图基座）+ 产品图（包装参考）经 createProductConditionedFirstFrame 派生；
 * 3. 预检失败 → 重新生成（最多两次，把问题转成视觉约束），仍失败则明确抛错——
 *    绝不调用 Seedance，绝不静默使用随机图/纯文本生图/产品主图。
 * 4. 上下文缺失（无参考关键帧或无产品图）→ 显式失败 first_frame_derivation_context_missing。
 *
 * viral_recreation_v2（爆款复刻 v2）分支：ensureVirtualPersonShotFirstFrame——
 * P0 实测中转风控拦截 UGC 帧素材（copyright restrictions），纯生成虚构人物控制图可过；
 * 因此该模式派生首帧不读 UGC 帧，用「虚构人物 + 镜头语义 + 产品图」纯生成。
 */
import { createProductConditionedFirstFrame } from './product-conditioned-frame';
import {
  runFirstFramePreflight,
  generateFirstFrameWithPreflight,
  type FirstFramePreflightResult,
} from './first-frame-preflight';
import { db } from './db';
import { requireVisualSafetyPass } from './visual-safety';
import { createVirtualPersonControlFrame } from './viral-control-image';
import {
  type DeclaredReferenceImage,
  assertReferenceImagesAllowed,
  sourceKeyframeDeclaration,
} from '../adapters/reference-policy-guard';
import type { ReferenceInputMode } from '../domain/reference-policy/reference-input-policy';

export interface ShotFirstFrameContext {
  ownerId: string;
  runId?: string | null;
  sessionId?: string | null;
  shotId: string;
  shotIndex: number;
  /** 条件化锚点（构图基座；语义由 referencePolicy 决定） */
  referenceKeyframeUrl?: string | null;
  /** Planner policy used to select a de-identified conditioning anchor. */
  referencePolicy?: 'safe_keyframe' | 'semantic_replacement';
  continuityAnchorUrl?: string | null;
  continuityGroup?: string | null;
  /** 爆款参考视频 URL */
  referenceVideoUrl?: string | null;
  /** 产品图（包装/颜色/Logo 参考） */
  productAssetUrls: string[];
  productName: string;
  /** 镜头结构描述（景别/主体位置/动作意图） */
  shotStructure: string;
  /** 已有派生首帧（复用） */
  existingFirstFrameUrl?: string | null;
  /** 修复指导（预检失败后的视觉约束，重生成时追加） */
  fixGuidance?: string[];
  /** 图像模型 ID（默认目录默认） */
  imageModelId?: string;
  /**
   * P5 强制出口 3（fix/retry 共用派生漏斗）：派生前强制执行 ReferenceInputPolicy。
   * - policyMode：默认 semantic_recreation；
   * - 声明由服务端可信来源构建（conditioned_first_frames / product_assets /
   *   shot.derived_first_frame_url，owner 匹配），不接受草稿/调用方自报标签。
   */
  policyMode?: ReferenceInputMode;
  /** provenance 持久化上下文（透传给派生实现） */
  persist?: {
    runId?: string | null;
    sessionId?: string | null;
    shotId?: string | null;
    ownerId: string;
    referenceVideoUrl?: string | null;
  };
  /** 可注入 seam（测试用） */
  deriveFn?: typeof createProductConditionedFirstFrame;
  preflightFn?: (url: string) => Promise<FirstFramePreflightResult>;
  maxRegenerations?: number;
}

export interface ShotFirstFrameOutcome {
  firstFrameUrl: string;
  derived: boolean;
  attempts: number;
  preflight: FirstFramePreflightResult;
}

export class ShotFirstFrameError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 可信来源核验（P5 修复）：任意裸 URL 不得被当作「已派生首帧」或「自有锚点」。
 * 只有以下服务端持久化记录能证明资产来源：
 * - conditioned_first_frames（本系统生成链路，owner 匹配）；
 * - product_assets（我方产品资产，owner 匹配）；
 * - shot_generation_tasks.derived_first_frame_url（本 run 派生记录，owner 匹配）。
 */
export function resolveTrustedAssetKind(ownerId: string, url: string): 'generated_frame' | 'product_shot' | 'owned_scene_anchor' | null {
  if (!url || !ownerId) return null;
  const normalized = url.trim();
  if (!normalized) return null;
  const cff = db
    .prepare('SELECT 1 FROM conditioned_first_frames WHERE owner_id = ? AND conditioned_first_frame_url = ? LIMIT 1')
    .get(ownerId, normalized);
  if (cff) return 'generated_frame';
  const pa = db
    .prepare('SELECT 1 FROM product_assets WHERE owner_id = ? AND url = ? LIMIT 1')
    .get(ownerId, normalized);
  if (pa) return 'product_shot';
  const shot = db
    .prepare('SELECT 1 FROM shot_generation_tasks WHERE owner_id = ? AND derived_first_frame_url = ? LIMIT 1')
    .get(ownerId, normalized);
  if (shot) return 'generated_frame';
  // Step2 AI 生图选优产物：系统内通过 generate-image 生成并存入 materials 表的素材，
  // owner 匹配即为自有资产（generated_frame 语义：系统生成链路产出）。
  const mat = db
    .prepare('SELECT 1 FROM materials WHERE owner_id = ? AND url = ? LIMIT 1')
    .get(ownerId, normalized);
  if (mat) return 'generated_frame';
  return null;
}

/** 裸 URL 是否可复用为「已派生首帧」（必须在 conditioned_first_frames 有本 owner 的生成记录） */
export function isVerifiedDerivedFirstFrame(ownerId: string, url: string): boolean {
  return resolveTrustedAssetKind(ownerId, url) === 'generated_frame';
}

/**
 * A full-video plan is not merely a larger batch.  Its visual-continuity
 * package declares that adjacent shots have a shared world, so the first-frame
 * preparation order must be able to carry a verified frame from shot N to
 * shot N+1.  Legacy/ordinary workbench drafts retain their independent-shot
 * behaviour and their configured concurrency.
 */
export function hasRollingContinuityPlan(draft: any): boolean {
  const plan = draft?.fullVideoPlan;
  return Boolean(
    plan &&
      Array.isArray(plan.shots) &&
      plan.shots.length >= 6 &&
      plan.visualContinuity &&
      Array.isArray(plan.visualContinuity.seams) &&
      plan.visualContinuity.seams.length === plan.shots.length - 1
  );
}

/**
 * Resolve only a server-recorded predecessor frame.  A draft URL never gains
 * trust merely by claiming to be a continuity anchor.  If the predecessor is
 * not yet ready (or has failed), callers keep their ordinary product anchor;
 * the final visual gate will then report any real discontinuity rather than
 * manufacturing a false dependency.
 */
function resolvePrecedingGeneratedAnchor(input: {
  ownerId: string;
  sessionId: string;
  shotIndex: number;
  draft: any;
}): string | null {
  if (!hasRollingContinuityPlan(input.draft) || input.shotIndex <= 1) return null;
  const previous = db
    .prepare(
      `SELECT derived_first_frame_url, first_frame_url
         FROM shot_generation_tasks
        WHERE owner_id = ? AND session_id = ? AND shot_index = ?
        LIMIT 1`
    )
    .get(input.ownerId, input.sessionId, input.shotIndex - 1) as
    | { derived_first_frame_url?: string | null; first_frame_url?: string | null }
    | undefined;
  const url = previous?.derived_first_frame_url || previous?.first_frame_url || null;
  return url && isVerifiedDerivedFirstFrame(input.ownerId, url) ? url : null;
}

/** 自动构建策略声明（P5 修复：kind 来自服务端可信来源，不接受调用方/草稿自报标签） */
function policyDeclarationsFor(ctx: ShotFirstFrameContext): DeclaredReferenceImage[] {
  const ownerId = ctx.ownerId;
  const anchorKind = ctx.referenceKeyframeUrl
    ? resolveTrustedAssetKind(ownerId, ctx.referenceKeyframeUrl)
    : null;
  const declarations: DeclaredReferenceImage[] = [];
  if (ctx.referenceKeyframeUrl) {
    if (anchorKind) {
      declarations.push({
        id: 'conditioning-anchor',
        url: ctx.referenceKeyframeUrl,
        kind: anchorKind,
      });
    } else {
      // 无法证明来源的锚点 = 按原视频关键帧处理（拒绝）——「自报标签」不再生效
      declarations.push(sourceKeyframeDeclaration(ctx.referenceKeyframeUrl));
    }
  }
  for (const [index, productUrl] of ctx.productAssetUrls.entries()) {
    const kind = resolveTrustedAssetKind(ownerId, productUrl);
    if (kind) {
      declarations.push({ id: `product-${index}`, url: productUrl, kind });
    } else {
      // 不在我方资产表的「产品图」同样无法证明来源 → 拒绝（防任意公网 URL 冒充产品图）
      declarations.push(sourceKeyframeDeclaration(productUrl));
    }
  }
  return declarations;
}

/**
 * 主入口：返回可用于 Seedance 提交的派生首帧（公网 URL）。
 * P5 强制出口 3：派生前先执行 ReferenceInputPolicy（fix/retry 与首次提交
 * 共用本漏斗，因此修复路径同样被强制）。违规 → ReferencePolicyViolationError，
 * deriveFn 不被调用、provider 不被调用。
 * 失败抛 ShotFirstFrameError（code 可读，调用方把它写入镜头失败原因，不调用 provider）。
 */
export async function ensureShotFirstFrame(
  ctx: ShotFirstFrameContext
): Promise<ShotFirstFrameOutcome> {
  const maxRegenerations = ctx.maxRegenerations ?? 2;
  const deriveFn = ctx.deriveFn ?? createProductConditionedFirstFrame;
  const preflightFn =
    ctx.preflightFn ??
    ((url: string) =>
      runFirstFramePreflight({
        firstFrameUrl: url,
        referenceKeyframeUrl: ctx.referenceKeyframeUrl || '',
        productImageUrl: ctx.productAssetUrls[0] || '',
        productName: ctx.productName,
      }));

  // 已有派生首帧：先核验 provenance（必须是本系统生成的派生帧，裸 URL 不可复用），
  // 再预检，通过直接复用——策略检查在复用之前完成（P5 修复：旧数据中的原视频帧
  // 不能作为 first_frame 继续提交）。
  if (ctx.existingFirstFrameUrl) {
    if (!isVerifiedDerivedFirstFrame(ctx.ownerId, ctx.existingFirstFrameUrl)) {
      throw new ShotFirstFrameError(
        'first_frame_reuse_not_verifiable',
        `第 ${ctx.shotIndex} 镜的已有首帧（${ctx.existingFirstFrameUrl.slice(0, 120)}）无法核验为本系统派生的条件化首帧，` +
          '禁止作为 provider 首帧复用；请重新派生（或先录入可信资产 provenance）'
      );
    }
    requireVisualSafetyPass(ctx.ownerId, ctx.existingFirstFrameUrl, 'existing-first-frame');
    const preflight = await preflightFn(ctx.existingFirstFrameUrl);
    if (preflight.ok) {
      return {
        firstFrameUrl: ctx.existingFirstFrameUrl,
        derived: false,
        attempts: 1,
        preflight,
      };
    }
    // 已有首帧预检失败 → 走重新生成（最多 maxRegenerations 次）
  }

  // 上下文完整性（禁止静默降级）
  if (!ctx.referenceKeyframeUrl) {
    throw new ShotFirstFrameError(
      'first_frame_derivation_context_missing',
      `第 ${ctx.shotIndex} 镜缺少条件化锚点，无法派生产品条件化首帧；` +
        '请先完成爆款视频拆解/关键帧提取，再提交视频生成'
    );
  }
  if (!Array.isArray(ctx.productAssetUrls) || ctx.productAssetUrls.length === 0) {
    throw new ShotFirstFrameError(
      'first_frame_derivation_context_missing',
      `第 ${ctx.shotIndex} 镜缺少产品图（productAssetUrls），无法派生产品条件化首帧（禁止纯文本生图）`
    );
  }

  // P5 强制出口 3：策略先于任何派生/付费调用（默认 semantic_recreation——
  // 原视频关键帧不得作为 provider 的参考输入；违规抛 ReferencePolicyViolationError）
  const declarations = policyDeclarationsFor(ctx);
  assertReferenceImagesAllowed(declarations, {
    mode: ctx.policyMode ?? 'semantic_recreation',
  });
  // This is the image-provider boundary. Provenance alone is not enough: each
  // accepted product/anchor asset must have a hash-bound, server-side safety pass
  // before it can be sent to /images/edits.
  for (const declaration of declarations) {
    requireVisualSafetyPass(ctx.ownerId, declaration.url, declaration.id);
  }

  // 派生 + 预检 +（最多两次）重新生成
  const guidance = [...(ctx.fixGuidance ?? [])];
  const result = await generateFirstFrameWithPreflight({
    maxRegenerations,
    generate: async (fixGuidance) => {
      const derived = await deriveFn({
        referenceKeyframeUrl: ctx.referenceKeyframeUrl as string,
        productAssetUrls: ctx.productAssetUrls,
        productName: ctx.productName,
        shotStructure: ctx.shotStructure,
        visualConstraints: fixGuidance,
        modelId: ctx.imageModelId,
        persist: ctx.persist,
        referencePolicy: {
          mode: ctx.policyMode ?? 'semantic_recreation',
          images: declarations,
        },
      });
      return { imageUrl: derived.imageUrl, localPath: derived.localPath };
    },
    preflight: preflightFn,
  });

  if (!result.ok || !result.finalImageUrl || !result.preflight) {
    const issues = result.preflight?.issues ?? [];
    const detail = issues.length > 0 ? issues.map((i) => `${i.message}（修复：${i.fixAction}）`).join('；') : '未知原因';
    throw new ShotFirstFrameError(
      'first_frame_preflight_failed',
      `第 ${ctx.shotIndex} 镜首帧预检未通过（已重生成 ${Math.max(0, result.attempts - 1)} 次）：${detail}。未调用视频生成 provider`
    );
  }

  return {
    firstFrameUrl: result.finalImageUrl,
    derived: true,
    attempts: result.attempts,
    preflight: result.preflight,
  };
}

/** 把首帧派生/预检结果写回镜头任务（first_frame_url + 派生标记 + 预检状态） */
export function persistShotFirstFrame(
  shotId: string,
  outcome: { firstFrameUrl: string; derived: boolean; preflight: FirstFramePreflightResult }
): void {
  db.prepare(
    `UPDATE shot_generation_tasks
        SET first_frame_url = ?, derived_first_frame_url = CASE WHEN ? THEN ? ELSE derived_first_frame_url END,
            first_frame_preflight_status = ?, first_frame_preflight_issues = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(
    outcome.firstFrameUrl,
    outcome.derived ? 1 : 0,
    outcome.derived ? outcome.firstFrameUrl : null,
    outcome.preflight.ok ? 'passed' : 'failed',
    JSON.stringify(outcome.preflight.issues).slice(0, 2000),
    shotId
  );
}

/** 镜头级失败原因标记（预检失败/上下文缺失时写入，供 UI 展示可执行修复动作） */
export function markShotFirstFrameBlocked(
  shotId: string,
  error: ShotFirstFrameError
): void {
  db.prepare(
    `UPDATE shot_generation_tasks
        SET status = 'failed', error_message = ?, first_frame_preflight_status = 'failed',
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(`${error.code}: ${error.message}`.slice(0, 1500), shotId);
}

function boundedText(value: unknown, max = 1600): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Turn the approved semantic plan into the image-conditioning instruction.
 *
 * The safe anchor may deliberately be only a product asset (we cannot send a
 * viral source frame to a provider), so the text contract has to carry the
 * source's reconstructed shot purpose, action, continuity state, and camera
 * intent.  Keeping this adapter here means first generation, retry, and
 * fix-shot all receive exactly the same meaningful direction.
 */
export function buildConditioningShotStructure(draftShot: any, draft: any, fallback: string): string {
  const visualBible = draft?.fullVideoPlan?.visualContinuity?.visualBible;
  const seams = Array.isArray(draft?.fullVideoPlan?.visualContinuity?.seams)
    ? draft.fullVideoPlan.visualContinuity.seams
    : [];
  const shotIndex = Number(draftShot?.shotIndex);
  const incoming = seams.find((seam: any) => Number(seam?.toShotIndex) === shotIndex);
  const outgoing = seams.find((seam: any) => Number(seam?.fromShotIndex) === shotIndex);
  const parts = [
    draftShot?.semanticPurpose || draftShot?.visualIntent || draftShot?.description || fallback,
    // P3 稳定性修复：动作来源 = 安全代理（safeVisualProxy）；源动作审计文本绝不进首帧 prompt
    draftShot?.safeVisualProxy
      ? `Required visible action: ${boundedText(draftShot.safeVisualProxy, 700)}`
      : draftShot?.sourceAction
        ? `Required visible action: ${boundedText(draftShot.sourceAction, 700)}`
        : '',
    draftShot?.cameraMovement ? `Camera movement: ${boundedText(draftShot.cameraMovement, 400)}` : '',
    draftShot?.lighting ? `Lighting: ${boundedText(draftShot.lighting, 300)}` : '',
    draftShot?.preState ? `State entering: ${boundedText(draftShot.preState, 500)}` : '',
    draftShot?.postState ? `State leaving: ${boundedText(draftShot.postState, 500)}` : '',
    incoming
      ? `Incoming visual seam: inherit "${boundedText(incoming.outgoingVisualState, 360)}" as "${boundedText(incoming.incomingVisualState, 360)}"; anchors: ${(incoming.sharedAnchors || []).map((anchor: unknown) => boundedText(anchor, 220)).join('; ')}`
      : '',
    outgoing
      ? `Outgoing visual seam: finish with "${boundedText(outgoing.outgoingVisualState, 360)}" so the next shot begins with "${boundedText(outgoing.incomingVisualState, 360)}"; anchors: ${(outgoing.sharedAnchors || []).map((anchor: unknown) => boundedText(anchor, 220)).join('; ')}`
      : '',
    visualBible
      ? `Shared visual bible: product=${boundedText(visualBible.productIdentity, 380)}; set=${boundedText(visualBible.setAndProps, 380)}; light=${boundedText(visualBible.lighting, 280)}; palette=${boundedText(visualBible.palette, 280)}; camera=${boundedText(visualBible.cameraLanguage, 280)}; motion=${boundedText(visualBible.motionLanguage, 280)}`
      : '',
    draftShot?.promptOverride || draftShot?.motionPrompt
      ? `Approved semantic-recreation direction: ${boundedText(draftShot.promptOverride || draftShot.motionPrompt, 2200)}`
      : '',
    Array.isArray(draftShot?.negativeConstraints) && draftShot.negativeConstraints.length > 0
      ? `Negative constraints: ${draftShot.negativeConstraints.map((item: unknown) => boundedText(item, 180)).join('; ')}`
      : '',
  ].filter(Boolean);
  return boundedText(parts.join('\n'), 5600) || fallback;
}

/**
 * 从工作台草稿 + 镜头行构建首帧派生上下文（workflow-controller 与 fix-shot 路由共用，
 * 保证「提交」与「修复」走同一套派生/预检逻辑）。
 */
export function shotFirstFrameContextFromDraft(opts: {
  ownerId: string;
  runId?: string | null;
  shot: any;
  draft: any;
  fixGuidance?: string[];
}): ShotFirstFrameContext {
  const { ownerId, runId, shot, draft, fixGuidance } = opts;
  const draftShots = Array.isArray(draft?.shots) ? draft.shots : [];
  const shotIndex = Number(shot.shot_index);
  const draftShot = draftShots.find((d: any) => d.shotIndex === shotIndex);
  const refKeyframes = Array.isArray(draft?.referenceKeyframes) ? draft.referenceKeyframes : [];
  const rollingAnchorUrl = resolvePrecedingGeneratedAnchor({
    ownerId,
    sessionId: String(shot.session_id),
    shotIndex,
    draft,
  });
  // 剪辑点定向返修（seam-repair）：接收镜以「前一镜结束边界帧」为新锚点——
  // 它比 rolling anchor（前一镜的起始首帧）更接近承接状态，必须优先。
  const seamAnchorUrl = draftShot?.seamRepair?.anchorUrl || null;
  const continuityAnchorUrl = seamAnchorUrl || rollingAnchorUrl || draftShot?.continuityAnchorUrl || null;
  const referenceKeyframeUrl =
    // In a quality plan, the verified predecessor is the first conditioning
    // image for the receiving shot.  This makes set, light, camera placement,
    // and the already-achieved visual state concrete rather than only text in
    // the prompt.  It remains an owned/generated asset and is re-checked at
    // the image-provider boundary below.
    seamAnchorUrl ||
    rollingAnchorUrl ||
    draftShot?.referenceKeyframeUrl ||
    (draftShot?.referencePolicy === 'semantic_replacement'
      ? continuityAnchorUrl
      : refKeyframes[(shotIndex - 1) % Math.max(1, refKeyframes.length)] ||
        shot.reference_keyframe_url ||
        null);
  const productAssetUrls =
    Array.isArray(draft?.productAssetUrls) && draft.productAssetUrls.length > 0
      ? draft.productAssetUrls
      : [];
  const productName = draft?.productName || 'BUV 小绿泥洁面';
  const fallbackShotStructure = draftShot
    ? `${draftShot.shotSize} · ${draftShot.cameraMovement} · ${(draftShot.mustKeep ?? []).join('、') || '产品主体'}`
    : `shot ${shot.shot_index} (close-up)`;
  const shotStructure = buildConditioningShotStructure(draftShot, draft, fallbackShotStructure);
  // 兼容旧客户端：候选首帧只作「已有首帧」复用；预检不过则重新派生
  const legacyCandidate = draftShot?.candidates?.find(
    (c: any) => c.id === draftShot.selectedCandidateId
  )?.url;
  // P5 强制出口 3：policyMode 固定为 semantic_recreation。
  // 注意：不再从草稿字符串推导资产 kind（referencePolicy 只是计划元数据，
  // 不是合规标签）——声明由 ensureShotFirstFrame 基于服务端可信来源构建。
  return {
    ownerId,
    runId,
    sessionId: String(shot.session_id),
    shotId: String(shot.id),
    shotIndex,
    referenceKeyframeUrl,
    referencePolicy: draftShot?.referencePolicy,
    continuityAnchorUrl,
    continuityGroup: draftShot?.continuityGroup ?? null,
    referenceVideoUrl: draft?.referenceVideoUrl ?? shot.reference_video_url ?? null,
    productAssetUrls,
    productName,
    shotStructure,
    existingFirstFrameUrl: legacyCandidate || shot.first_frame_url || null,
    fixGuidance,
    policyMode: 'semantic_recreation',
    persist: {
      ownerId,
      runId,
      sessionId: String(shot.session_id),
      shotId: String(shot.id),
      referenceVideoUrl: draft?.referenceVideoUrl ?? shot.reference_video_url ?? null,
    },
  };
}

/**
 * viral_recreation_v2 首帧派生（爆款复刻 v2 专用分支）。
 *
 * 与 ensureShotFirstFrame 的差异：
 * - 不读 UGC 帧/参考关键帧（P0 实测中转风控拦截 UGC 帧素材 → copyright restrictions）；
 * - 派生用「虚构人物 + 镜头语义 + 产品图」纯生成（createVirtualPersonControlFrame）；
 * - policyMode 固定 viral_recreation_v2；safety 允许虚构人物、仍禁文字层；
 * - 仅用于 viral_recreation_v2 模式；旧模式一律走 ensureShotFirstFrame。
 *
 * 失败语义与 ensureShotFirstFrame 一致（ShotFirstFrameError；不调用视频 provider）。
 */
export async function ensureVirtualPersonShotFirstFrame(
  ctx: ShotFirstFrameContext
): Promise<ShotFirstFrameOutcome> {
  const maxRegenerations = ctx.maxRegenerations ?? 2;
  const preflightFn =
    ctx.preflightFn ??
    ((url: string) =>
      runFirstFramePreflight({
        firstFrameUrl: url,
        referenceKeyframeUrl: '',
        productImageUrl: ctx.productAssetUrls[0] || '',
        productName: ctx.productName,
      }));

  // 已有派生首帧复用（与 ensureShotFirstFrame 同纪律：可核验 + safety pass）
  if (ctx.existingFirstFrameUrl) {
    if (!isVerifiedDerivedFirstFrame(ctx.ownerId, ctx.existingFirstFrameUrl)) {
      throw new ShotFirstFrameError(
        'first_frame_reuse_not_verifiable',
        `第 ${ctx.shotIndex} 镜的已有首帧（${ctx.existingFirstFrameUrl.slice(0, 120)}）无法核验为本系统派生的条件化首帧，禁止复用`
      );
    }
    requireVisualSafetyPass(ctx.ownerId, ctx.existingFirstFrameUrl, 'existing-first-frame');
    const preflight = await preflightFn(ctx.existingFirstFrameUrl);
    if (preflight.ok) {
      return {
        firstFrameUrl: ctx.existingFirstFrameUrl,
        derived: false,
        attempts: 1,
        preflight,
      };
    }
  }

  // 上下文完整性（与 ensureShotFirstFrame 同纪律）
  if (!Array.isArray(ctx.productAssetUrls) || ctx.productAssetUrls.length === 0) {
    throw new ShotFirstFrameError(
      'first_frame_derivation_context_missing',
      `第 ${ctx.shotIndex} 镜缺少产品图（productAssetUrls），无法生成虚构人物控制图（禁止纯文本生图）`
    );
  }
  // 产品图必须已通过视觉安全核验（无人物路径评估；产品图本身无人物）
  for (const url of ctx.productAssetUrls) {
    requireVisualSafetyPass(ctx.ownerId, url, 'virtual-person-product');
  }

  const result = await generateFirstFrameWithPreflight({
    maxRegenerations,
    generate: async (fixGuidance) => {
      const derived = await createVirtualPersonControlFrame({
        ownerId: ctx.ownerId,
        runId: ctx.persist?.runId ?? ctx.runId ?? null,
        sessionId: ctx.persist?.sessionId ?? ctx.sessionId ?? null,
        shotId: ctx.persist?.shotId ?? ctx.shotId,
        shotIndex: ctx.shotIndex,
        productAssetUrls: ctx.productAssetUrls,
        productName: ctx.productName,
        shotStructure: ctx.shotStructure,
        visualConstraints: fixGuidance,
        modelId: ctx.imageModelId,
      });
      return { imageUrl: derived.imageUrl, localPath: derived.localPath };
    },
    preflight: preflightFn,
  });

  if (!result.ok || !result.finalImageUrl || !result.preflight) {
    const issues = result.preflight?.issues ?? [];
    const detail = issues.length > 0 ? issues.map((i) => `${i.message}（修复：${i.fixAction}）`).join('；') : '未知原因';
    throw new ShotFirstFrameError(
      'first_frame_preflight_failed',
      `第 ${ctx.shotIndex} 镜虚构人物首帧预检未通过（已重生成 ${Math.max(0, result.attempts - 1)} 次）：${detail}。未调用视频生成 provider`
    );
  }

  return {
    firstFrameUrl: result.finalImageUrl,
    derived: true,
    attempts: result.attempts,
    preflight: result.preflight,
  };
}

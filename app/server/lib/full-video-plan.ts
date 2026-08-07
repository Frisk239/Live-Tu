/**
 * Full-video visual IR for the semantic recreation pipeline.
 *
 * This module deliberately contains no provider or filesystem code.  It turns
 * a small amount of reference/product context into a deterministic 6-8 shot
 * visual plan.  The workbench can persist the plan in its draft JSON and the
 * provider adapters only receive the already de-identified conditioned frame.
 *
 * P5 修复：
 * - 镜头数量动态化：支持 6-8 镜，数量契约来自 domain/production-plan
 *   （BEAT_CHAINS / resolveShotCount），与 ReferenceAnalysis / SemanticStoryboard /
 *   SequenceGate 共用同一份动态契约；
 * - 每镜携带完整叙事职责（NarrativeShotContract 字段：purpose/preState/action/
 *   postState/transitionIn/transitionOut/stateIn/stateOut/productRole）；
 * - 没有计划的镜头不得进入生成或合成（plan.shots 是唯一镜头来源）。
 */

import type { SemanticStoryboard, SemanticStoryboardShot } from './semantic-storyboard';
import { validateSemanticStoryboard } from './semantic-storyboard';
import {
  type SemanticBeat,
  type SemanticProductRole,
  BEAT_CHAINS,
  validateNarrativeChain,
  resolveShotCount,
  toNarrativeContractShapes,
} from '../domain/production-plan/narrative-shot-contract';
import { buildTemplateContracts } from '../domain/production-plan/narrative-shot-contract';
import {
  appendVisualContinuityPrompt,
  createVisualContinuityPackage,
  validateVisualContinuityPackage,
  VISUAL_CONTINUITY_PROMPT_MARKER,
  type VisualContinuityPackage,
} from './visual-continuity';

export type NarrativeBeat = SemanticBeat;
export type ReferencePolicy = 'safe_keyframe' | 'semantic_replacement';
export type ProductExposure = 'none' | 'supporting' | 'hero';

export { resolveShotCount };

export interface FullVideoPlanInput {
  productName: string;
  targetDurationSec?: number;
  /** 6-8；缺省时用 semanticStoryboard 的镜头数，再缺省 6 */
  shotCount?: number;
  safeReferenceSegments?: Array<{ startSec: number; endSec: number }>;
  /** Optional source-video semantic analysis; absent keeps the deterministic fallback. */
  semanticStoryboard?: SemanticStoryboard | null;
}

export interface PlannedShot {
  shotId: string;
  shotIndex: number;
  beat: NarrativeBeat;
  targetStartMs: number;
  targetEndMs: number;
  referenceSegment: { startSec: number; endSec: number };
  referencePolicy: ReferencePolicy;
  visualIntent: string;
  cameraDirection: string;
  continuityGroup: string;
  productExposure: ProductExposure;
  semanticPurpose?: string;
  sourceAction?: string;
  /** 可生成的安全视觉替代动作（provider prompt 唯一动作来源） */
  safeVisualProxy?: string;
  /** QA 应检查的可见结果 */
  safeCoverageCriteria?: string[];
  /** 源动作审计（原视频动作/字幕/标签/时间段）——仅审计，绝不进入 provider prompt */
  sourceActionAudit?: string;
  audienceEffect?: string;
  preState?: string;
  postState?: string;
  stateIn?: string[];
  stateOut?: string[];
  transitionIn?: string;
  transitionOut?: string;
  replacementIntent?: string;
  prompt: string;
  negativeConstraints: string[];
}

export interface FullVideoPlan {
  version: 'v1';
  productName: string;
  targetDurationSec: number;
  /** 6-8 镜（与 semanticStoryboard/sequence gate 同一契约） */
  shotCount: number;
  aspectRatio: '9:16';
  audioMode: 'video_only';
  shots: PlannedShot[];
  beats: NarrativeBeat[];
  semanticStoryboard?: SemanticStoryboard;
  /**
   * A serializable visual bible plus a contract for every edit boundary.
   * Optional only to keep older saved drafts readable; every newly created
   * quality plan carries it and the final visual gate reports an old plan as
   * unverified rather than pretending it has continuity evidence.
   */
  visualContinuity?: VisualContinuityPackage;
  safety: {
    rawReferenceFramesToProvider: false;
    identifiableFacePolicy: 'remove';
    sourceWatermarkPolicy: 'remove';
  };
}

const DEFAULT_SAFE_SEGMENTS = [
  { startSec: 53.5, endSec: 54.9 },
  { startSec: 60.95, endSec: 62.75 },
];

const NEGATIVE_CONSTRAINTS = [
  'no face, hands, fingers, arms, skin, torso, or any human body part',
  'no human silhouette or person likeness; the product and surface carry the action',
  'no source subtitles, watermark, QR code, username, or logo',
  'no competitor packaging or copied brand marks',
  'no medical claims or before-and-after claims',
];

/** 每镜蓝图（按节拍；comparison/benefit 为 8 镜/7 镜扩展节拍） */
const BLUEPRINTS: Record<
  NarrativeBeat,
  { visualIntent: string; cameraDirection: string; productExposure: ProductExposure; promptLead: string }
> = {
  hook: {
    visualIntent: 'Immediate product-only hook: a single green BUV package makes a decisive reveal on a clean tabletop; no human contact.',
    cameraDirection: 'fast but smooth push-in, product lands in the center safe area',
    productExposure: 'hero',
    promptLead: 'Open with a strong visual hook, product appears in the first beat',
  },
  problem: {
    visualIntent: 'Show the cleaning problem through residue and foam on a neutral ceramic surface while the green BUV package stays visible as a supporting anchor; no human contact.',
    cameraDirection: 'short lateral slide followed by a controlled macro rack focus',
    productExposure: 'hero',
    promptLead: 'Make the cleaning pain immediately legible with texture and contrast',
  },
  product_intro: {
    visualIntent: 'Return to the same green package in a clean product-only hero, matching the hook palette and tabletop so the story feels continuous.',
    cameraDirection: 'slow clockwise orbit around the package, stable horizon and soft highlights',
    productExposure: 'hero',
    promptLead: 'Introduce the product as the clear solution and keep packaging readable',
  },
  demo: {
    visualIntent: 'Product-led usage demonstration with no humans: the green nozzle dispenses a controlled ribbon of foam onto a neutral ceramic surface; the product, nozzle, foam, and surface carry the action.',
    cameraDirection: 'overhead-to-close tracking move following the green nozzle and foam trail',
    productExposure: 'hero',
    promptLead: 'Show a simple, believable use action with a visible foam result',
  },
  proof: {
    visualIntent: 'A clean product-only contrast: residue clears on the ceramic surface while the same BUV package remains the anchor; no hands or body parts.',
    cameraDirection: 'gentle pull-back from macro detail to a tidy hero composition',
    productExposure: 'hero',
    promptLead: 'Give visual proof through surface contrast, not text or unsupported claims',
  },
  comparison: {
    visualIntent: 'A side-by-side product-only comparison on the same surface and light: cleaned and uncleaned zones are both legible, with the BUV package as the anchor; no hands or body parts.',
    cameraDirection: 'steady lateral pan or split-frame hold keeping both zones in the same composition',
    productExposure: 'hero',
    promptLead: 'Strengthen proof with a readable before/after contrast under identical light',
  },
  benefit: {
    visualIntent: 'Elevate the proven result into a take-away benefit: the clean surface and the product share a calm, breathable hero composition; no hands or body parts.',
    cameraDirection: 'slow pull-back to a wider tidy composition with generous negative space',
    productExposure: 'hero',
    promptLead: 'Turn the proven result into a benefit the viewer can take away',
  },
  cta: {
    visualIntent: 'Final product hero on the same set, with a subtle product rotation and clean negative space for a future CTA overlay; no human gesture or body part.',
    cameraDirection: 'slow elegant push-in and micro parallax, finish on a steady product hold',
    productExposure: 'hero',
    promptLead: 'End with a memorable product hero frame and clean space for a future CTA overlay',
  },
};

function clampTargetDuration(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(35, Math.max(25, Number(value)));
}

function safeSegmentAt(
  safeSegments: Array<{ startSec: number; endSec: number }>,
  index: number
): { startSec: number; endSec: number } {
  const candidate = safeSegments[index % safeSegments.length] ?? DEFAULT_SAFE_SEGMENTS[0];
  return {
    startSec: Number(candidate.startSec),
    endSec: Number(candidate.endSec),
  };
}

function mapSemanticBeat(shot: SemanticStoryboardShot | undefined, fallback: NarrativeBeat): NarrativeBeat {
  if (!shot) return fallback;
  // SemanticStoryboard 与 plan 已共用同一节拍词表；无额外映射
  return shot.beat;
}

/**
 * Build a deterministic 6-8 shot visual plan for a product-only demo.
 * shotCount 缺省时沿用 semanticStoryboard 的镜头数（同一份动态契约），
 * 再缺省为 6；超出 6-8 范围统一钳制。
 */
export function createFullVideoPlan(input: FullVideoPlanInput): FullVideoPlan {
  const productName = String(input.productName || 'the product').trim();
  const targetDurationSec = clampTargetDuration(input.targetDurationSec);
  const safeSegments =
    Array.isArray(input.safeReferenceSegments) && input.safeReferenceSegments.length > 0
      ? input.safeReferenceSegments
      : DEFAULT_SAFE_SEGMENTS;
  const storyboardCount = input.semanticStoryboard?.shots.length;
  // 同一份动态契约：semanticStoryboard 存在时其镜头数即最终计划镜头数
  // （选段→故事板→计划数量必须一致），否则用显式 shotCount/默认 6，并钳制 6-8。
  const shotCount = resolveShotCount(storyboardCount ?? input.shotCount, storyboardCount ?? 6);
  const beats: NarrativeBeat[] = [...(BEAT_CHAINS[shotCount] ?? BEAT_CHAINS[6])];
  const shotDurationMs = Math.round((targetDurationSec * 1000) / shotCount);

  // 叙事契约：semanticStoryboard 存在时以其镜头为契约源；否则用模板契约兜底，
  // 保证 6-8 镜的每一镜都有完整叙事职责（不会出现「未计划但被生成」的镜头）。
  const contracts = input.semanticStoryboard
    ? input.semanticStoryboard.shots.map((shot) => ({
        shotIndex: shot.shotIndex,
        beat: shot.beat,
        purpose: shot.purpose,
        preState: shot.preState,
        action: shot.safeVisualProxy || shot.sourceAction,
        postState: shot.postState,
        transitionIn: shot.transitionIn,
        transitionOut: shot.transitionOut,
        productRole: shot.productRole,
        stateIn: shot.stateIn,
        stateOut: shot.stateOut,
        replacementIntent: shot.replacementIntent,
        sourceActionAudit: shot.sourceActionAudit,
        safeVisualProxy: shot.safeVisualProxy || shot.sourceAction,
        safeCoverageCriteria: shot.safeCoverageCriteria,
      }))
    : buildTemplateContracts({
        productName,
        segments: safeSegments.slice(0, shotCount),
      });

  const baseShots: PlannedShot[] = beats.map((beat, index) => {
    const blueprint = BLUEPRINTS[beat] ?? BLUEPRINTS.demo;
    const contract = contracts[index];
    const targetStartMs = index * shotDurationMs;
    const targetEndMs = index === shotCount - 1
      ? Math.round(targetDurationSec * 1000)
      : (index + 1) * shotDurationMs;
    // P5 修复：所有镜头统一使用产品锚点（semantic_replacement）。原视频关键帧
    // 在 provider 出口一律被 ReferenceInputPolicy 拒绝（safe_keyframe 语义仅保留
    // 于类型中作历史兼容，不再由计划生成——否则首帧漏斗会拒绝计划镜头，与工作台
    // 路径产生契约冲突）。
    const referencePolicy: ReferencePolicy = 'semantic_replacement';
    const referenceSegment = safeSegmentAt(safeSegments, index);
    const semanticShot = input.semanticStoryboard?.shots[index];
    // P3 稳定性修复：provider prompt 的动作来源 = 安全代理（safeVisualProxy），
    // 源动作（sourceAction/sourceActionAudit，可能含字幕文字）绝不进入生成指令。
    const safeProxy = contract?.safeVisualProxy || contract?.action || blueprint.visualIntent;
    const visualIntent = contract ? `${contract.purpose} ${safeProxy}` : blueprint.visualIntent;
    const cameraDirection = semanticShot?.visualTechnique || blueprint.cameraDirection;
    const prompt = [
      `${blueprint.promptLead}.`,
      `This is shot ${index + 1} of a coherent vertical social-commerce product film for ${productName}.`,
      `Narrative purpose: ${visualIntent}`,
      `Safe visual action to render: ${safeProxy}.`,
      `State in: ${contract?.preState || 'continue the established visual state'}. State out: ${contract?.postState || 'hand a clear result to the next shot'}.`,
      `Transition in: ${contract?.transitionIn || 'continue the established visual state'}. Transition out: ${contract?.transitionOut || 'hand a clear result to the next shot'}.`,
      `Camera: ${cameraDirection}.`,
      'Keep the same neutral warm tabletop, soft daylight, green-and-white product palette, lens language, and motion tempo across every shot.',
      'Use the supplied product image as the only brand identity source; preserve its exact green package shape and label layout.',
      'The reference frame is composition-only. Remove every visible person, hand, finger, arm, skin, face, and body part; do not invent anatomy or a hand-held product pose.',
      'Do not render any subtitle, caption, label text, number, fake character, UI element, QR code, or watermark. Only the verified product packaging may carry necessary brand information.',
      'Prefer a locked product, nozzle, foam, ceramic surface, and simple prop animation over any human interaction.',
      'Every shot must advance the narrative purpose; do not add a decorative product close-up that does not change the viewer state.',
      'Create a de-identified reconstruction of the reference pacing, not a literal copy of a person, face, voice, subtitle, or watermark.',
    ].join(' ');

    return {
      shotId: `p4-shot-${index + 1}`,
      shotIndex: index + 1,
      beat,
      targetStartMs,
      targetEndMs,
      referenceSegment,
      referencePolicy,
      visualIntent,
      cameraDirection,
      continuityGroup: 'buv-green-tabletop-v1',
      productExposure: contract?.productRole || blueprint.productExposure,
      semanticPurpose: contract?.purpose,
      // P3 稳定性修复：sourceAction 字段承载安全代理（下游 prompt/首帧构建共用）
      sourceAction: safeProxy,
      safeVisualProxy: safeProxy,
      safeCoverageCriteria: contract?.safeCoverageCriteria
        ? [...contract.safeCoverageCriteria]
        : undefined,
      sourceActionAudit: contract?.sourceActionAudit,
      audienceEffect: semanticShot?.audienceEffect,
      preState: contract?.preState,
      postState: contract?.postState,
      stateIn: contract?.stateIn ? [...contract.stateIn] : undefined,
      stateOut: contract?.stateOut ? [...contract.stateOut] : undefined,
      transitionIn: contract?.transitionIn,
      transitionOut: contract?.transitionOut,
      replacementIntent: contract?.replacementIntent,
      prompt,
      negativeConstraints: [...NEGATIVE_CONSTRAINTS],
    };
  });

  const visualContinuity = createVisualContinuityPackage({
    productName,
    shots: baseShots.map((shot) => ({
      shotId: shot.shotId,
      shotIndex: shot.shotIndex,
      beat: shot.beat,
      continuityGroup: shot.continuityGroup,
      preState: shot.preState,
      postState: shot.postState,
      cameraDirection: shot.cameraDirection,
    })),
    visualGrammar: input.semanticStoryboard?.visualGrammar,
  });
  const shots: PlannedShot[] = baseShots.map((shot) => ({
    ...shot,
    prompt: appendVisualContinuityPrompt({
      basePrompt: shot.prompt,
      package: visualContinuity,
      shot,
    }),
  }));

  return {
    version: 'v1',
    productName,
    targetDurationSec,
    shotCount,
    aspectRatio: '9:16',
    audioMode: 'video_only',
    shots,
    beats: shots.map((shot) => shot.beat),
    ...(input.semanticStoryboard ? { semanticStoryboard: input.semanticStoryboard } : {}),
    visualContinuity,
    safety: {
      rawReferenceFramesToProvider: false,
      identifiableFacePolicy: 'remove',
      sourceWatermarkPolicy: 'remove',
    },
  };
}

/** 最后一镜的时间落点（与镜头总数一致，保证时轴填满 target duration） */

export function validateFullVideoPlan(plan: FullVideoPlan): string[] {
  const errors: string[] = [];
  if (plan.version !== 'v1') errors.push('unsupported plan version');
  if (plan.aspectRatio !== '9:16') errors.push('full video plan must be vertical 9:16');
  if (plan.shots.length < 6 || plan.shots.length > 8) errors.push('plan must contain 6-8 shots');
  if (plan.shotCount !== plan.shots.length) errors.push(`plan.shotCount (${plan.shotCount}) differs from shots (${plan.shots.length})`);
  const expectedBeats: NarrativeBeat[] = ['hook', 'problem', 'product_intro', 'demo', 'proof', 'cta'];
  for (const beat of expectedBeats) {
    if (!plan.beats.includes(beat)) errors.push(`missing narrative beat: ${beat}`);
  }
  const last = plan.shots.at(-1);
  if (!last || last.targetEndMs !== Math.round(plan.targetDurationSec * 1000)) {
    errors.push('timeline does not end at target duration');
  }
  if (plan.safety.rawReferenceFramesToProvider) errors.push('raw reference frames cannot reach provider');
  if (plan.semanticStoryboard) {
    for (const error of validateSemanticStoryboard(plan.semanticStoryboard)) {
      errors.push(`semantic: ${error}`);
    }
    if (plan.semanticStoryboard.shots.length !== plan.shots.length) {
      errors.push('semantic storyboard and visual plan shot counts differ');
    }
  }
  if (plan.visualContinuity) {
    for (const error of validateVisualContinuityPackage(plan.visualContinuity, plan.shots)) {
      errors.push(`visual continuity: ${error}`);
    }
    for (const shot of plan.shots) {
      if (!shot.prompt.includes(VISUAL_CONTINUITY_PROMPT_MARKER)) {
        errors.push(`${shot.shotId} does not carry the visual continuity prompt contract`);
      }
    }
  }
  // 状态链：下一镜 stateIn ⊆ 上一镜 stateOut（确定性承接契约）
  // S4.1：先映射字段名（PlannedShot 的 purpose 在 semanticPurpose 上），
  // 否则链式校验读到空文本而误判。
  const chainErrors = validateNarrativeChain(toNarrativeContractShapes(plan.shots));
  for (const error of chainErrors) errors.push(`chain: ${error}`);
  for (const shot of plan.shots) {
    if (shot.targetEndMs <= shot.targetStartMs) errors.push(`${shot.shotId} has invalid timing`);
    if (shot.negativeConstraints.length === 0) errors.push(`${shot.shotId} has no negative constraints`);
    if (plan.semanticStoryboard && (!shot.semanticPurpose || !shot.transitionOut)) {
      errors.push(`${shot.shotId} is missing semantic purpose/transition metadata`);
    }
    if (!shot.preState || !shot.postState) {
      errors.push(`${shot.shotId} is missing state contract (preState/postState)`);
    }
  }
  return errors;
}

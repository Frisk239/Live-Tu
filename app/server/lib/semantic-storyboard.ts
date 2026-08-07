/**
 * Semantic storyboard IR for viral-video recreation.
 *
 * Scene detection answers “where did the pixels change?”. This module answers
 * “what did the source video mean at that moment, and why does the next shot
 * exist?”. It is deliberately pure: an LLM/API adapter can produce the raw
 * analysis, while this module normalizes it, maps it to a product-safe story,
 * and rejects decorative shots with no narrative job.
 *
 * P5 修复：
 * - 镜头数量契约统一来自 domain/production-plan（6-8 镜同一份动态节拍链）；
 * - 原始 LLM 返回先经 ReferenceAnalysis schema 校验：空对象/缺字段/无效分析
 *   只能标为 deterministic_fallback，不得记录为「已深度理解原视频」；
 * - 中间镜的 preState/transitionIn 由叙事契约模板提供（可追溯到上一镜的
 *   postState/stateOut），不再被与上一镜无关的模板文案覆盖；
 * - 状态链（stateIn ⊆ 上一镜 stateOut）由 deterministic gate 验证。
 */

import {
  type SemanticBeat,
  type SemanticProductRole,
  type NarrativeShotContract,
  BEAT_CHAINS,
  MIDDLE_BEAT_ORDER,
  REQUIRED_NARRATIVE_BEATS,
  buildTemplateContracts,
  resolveShotCount,
} from '../domain/production-plan/narrative-shot-contract';
import { validateReferenceAnalysis } from '../domain/reference-analysis/reference-analysis';

export type { SemanticBeat, SemanticProductRole };
export { MIDDLE_BEAT_ORDER, REQUIRED_NARRATIVE_BEATS, resolveShotCount };

export interface SemanticReferenceSegment {
  startSec: number;
  endSec: number;
  /** 候选段标识（P5 三轮：语义继承坐标，与 LLM 候选序号对应） */
  candidateId?: string;
  structure?: string;
}

export interface SemanticStoryboardShot {
  shotIndex: number;
  startSec: number;
  endSec: number;
  beat: SemanticBeat;
  /** Why this shot is needed for the story, not merely what is visible. */
  purpose: string;
  /** Observable source action that is safe to recreate as a technique. */
  sourceAction: string;
  /** Intended audience reaction or information gain. */
  audienceEffect: string;
  /** Camera/editing technique to preserve without copying identity. */
  visualTechnique: string;
  /** Narrative state this shot receives at entry (traceable to prev postState). */
  preState: string;
  /** Narrative state this shot produces by its end. */
  postState: string;
  /** Deterministic incoming state tokens (must be produced by previous shot). */
  stateIn: string[];
  /** Deterministic outgoing state tokens (must satisfy the next shot). */
  stateOut: string[];
  /** State this shot receives from the previous shot. */
  transitionIn: string;
  /** State/change this shot must hand to the next shot. */
  transitionOut: string;
  productRole: SemanticProductRole;
  /** Explicit replacement rule for source people/brands/claims. */
  replacementIntent: string;
  /** 源动作审计（原视频动作/字幕/标签/时间段）——仅审计追溯，绝不进入 provider prompt */
  sourceActionAudit?: string;
  /** 可生成的安全视觉替代动作（无人物/无字幕/无标签） */
  safeVisualProxy: string;
  /** QA 应检查的可见结果（safeCoverageCriteria），替代不可满足的源人物动作复刻 */
  safeCoverageCriteria: string[];
}

export interface SemanticStoryboard {
  version: 'v1';
  sourceIntent: string;
  coreMessage: string;
  audienceProblem: string;
  emotionalArc: string;
  sellingMechanism: string;
  visualGrammar: {
    pacing: string;
    cameraLanguage: string;
    composition: string;
    transitionLanguage: string;
  };
  shots: SemanticStoryboardShot[];
  evidence: {
    source: 'llm_vision' | 'deterministic_fallback' | 'hybrid';
    /** raw LLM 返回是否通过 schema 校验（false = 只按 fallback 使用） */
    schemaValid: boolean;
    analyzedKeyframeCount: number;
    referenceSegments: SemanticReferenceSegment[];
    rawAnalysisAvailable: boolean;
    validationErrors?: string[];
  };
}

export interface SemanticStoryboardBuildInput {
  productName: string;
  segments: SemanticReferenceSegment[];
  rawAnalysis?: unknown;
  analyzedKeyframeCount?: number;
}

/** 每镜的运镜技法（供 prompt/计划使用；契约不承载、本模块补齐） */
const VISUAL_TECHNIQUES: Record<SemanticBeat, string> = {
  hook: '短促推进、明确主体落点、第一秒完成信息建立。',
  problem: '宏观细节、浅景深、短横移或焦点转移。',
  product_intro: '稳定英雄构图、慢速拉近、包装信息保持可读。',
  demo: '跟随动作的俯拍到近景、动作方向连续、结果在镜尾出现。',
  proof: '从宏观结果拉回稳定构图，保持同一光线和色彩。',
  comparison: '同一光线下切换/并列展示差异，保持构图对称。',
  benefit: '节奏稍缓、主体更稳定、留出清晰视觉呼吸区。',
  cta: '稳态微推或微视差，干净负空间，避免新信息突入。',
};

/** 每镜的观众效果（prompt/QA 用；契约不承载、本模块补齐） */
const AUDIENCE_EFFECTS: Record<SemanticBeat, string> = {
  hook: '观众马上知道“这里有一个值得继续看的问题”。',
  problem: '观众认出自己的使用场景并形成解决期待。',
  product_intro: '观众知道接下来要看的具体产品是什么。',
  demo: '观众看到产品如何工作，而不是只听口号。',
  proof: '观众获得“确实发生了变化”的视觉确认。',
  comparison: '对比让效果边界清晰，观众不再怀疑有效性。',
  benefit: '观众理解产品适合什么场景、解决什么问题。',
  cta: '观众记住产品外观和下一步行动对象。',
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

function text(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBeat(value: unknown, fallback: SemanticBeat): SemanticBeat {
  const raw = String(value ?? '').toLowerCase().trim();
  if (raw.includes('hook') || raw.includes('开场') || raw.includes('吸睛')) return 'hook';
  if (raw.includes('pain') || raw.includes('problem') || raw.includes('痛点') || raw.includes('问题')) return 'problem';
  if (raw.includes('intro') || raw.includes('product') || raw.includes('产品')) return 'product_intro';
  if (raw.includes('demo') || raw.includes('使用') || raw.includes('动作')) return 'demo';
  if (raw.includes('proof') || raw.includes('效果') || raw.includes('对比') || raw.includes('证明')) return 'proof';
  if (raw.includes('comparison') || raw.includes('对比')) return 'comparison';
  if (raw.includes('benefit') || raw.includes('利益') || raw.includes('场景')) return 'benefit';
  if (raw.includes('cta') || raw.includes('转化') || raw.includes('收尾') || raw.includes('行动')) return 'cta';
  return fallback;
}

function roleForBeat(beat: SemanticBeat): SemanticProductRole {
  return beat === 'problem' ? 'supporting' : 'hero';
}

function fallbackIndexForBeat(index: number, count: number): number {
  if (index === 0) return 0;
  if (index === count - 1) return count >= 8 ? 7 : 6;
  if (index === 1) return 1;
  if (index === 2) return 2;
  if (index === 3) return 3;
  if (index === 4) return 4;
  if (count >= 8 && index === 5) return 5;
  if (count >= 7 && index === count - 2) return 6;
  return 5;
}

function findRawShot(rawShots: any[], segment: SemanticReferenceSegment, index: number): Record<string, any> {
  // P5 三轮：语义继承坐标——最终段的 candidateId（如 cand-7）对应 LLM 候选序号 7，
  // 直接按 raw shotList 的 shotIndex 取该候选的语义（不再按最终镜序错位读取）。
  if (segment.candidateId) {
    const seq = Number(segment.candidateId.replace(/^cand-/, ''));
    if (Number.isInteger(seq) && seq >= 1) {
      const byCandidate = rawShots.find((shot) => Number(shot?.shotIndex) === seq);
      if (byCandidate) return asRecord(byCandidate);
    }
  }
  const byIndex = rawShots.find((shot) => Number(shot?.shotIndex) === index + 1);
  if (byIndex) return asRecord(byIndex);
  const overlapping = rawShots.find((shot) => {
    const start = finiteNumber(shot?.startSec ?? shot?.startTime, NaN);
    const end = finiteNumber(shot?.endSec ?? shot?.endTime, NaN);
    return Number.isFinite(start) && Number.isFinite(end) && start <= segment.endSec && end >= segment.startSec;
  });
  return asRecord(overlapping);
}

function rawNarrativeBeat(raw: Record<string, any>, index: number, segment: SemanticReferenceSegment, count: number): SemanticBeat {
  const beats = Array.isArray(raw.narrativeBeats) ? raw.narrativeBeats : [];
  const match = beats.find((beat: any) => {
    const start = finiteNumber(beat?.startSec, -Infinity);
    const end = finiteNumber(beat?.endSec, Infinity);
    return start <= segment.endSec && end >= segment.startSec;
  }) || beats[index];
  return normalizeBeat(match?.beat, BEAT_CHAINS[count]?.[index] ?? 'benefit');
}

/**
 * 稳健 beat 解析（不依赖 LLM 时间戳精确性）：
 * - 第 1 镜硬性 hook、最后一镜硬性 cta；
 * - 中间镜优先采用 LLM 微调（仅限合法中间节拍），否则用确定性模板链；
 * - 后校验：必需节拍缺失时，把该节拍在模板链中的对应镜头回退为模板 beat——
 *   LLM 的 narrativeBeats 只是微调信息，绝不能让它破坏故事链的完整性。
 */
const LEGAL_MIDDLE_BEATS: SemanticBeat[] = MIDDLE_BEAT_ORDER as unknown as SemanticBeat[];

export function resolveShotBeats(
  raw: Record<string, any>,
  segments: SemanticReferenceSegment[],
  templateBeats: SemanticBeat[]
): SemanticBeat[] {
  const count = resolveShotCount(segments.length);
  const beats = segments.map((segment, index) => {
    const templateBeat = templateBeats[index] || 'proof';
    if (index === 0) return 'hook' as SemanticBeat;
    if (index === segments.length - 1) return 'cta' as SemanticBeat;
    const candidate = rawNarrativeBeat(raw, index, segment, count);
    return (LEGAL_MIDDLE_BEATS as SemanticBeat[]).includes(candidate) ? candidate : templateBeat;
  });
  // 完整性后校验：必需节拍缺失 → 回退模板对应镜头的 beat
  for (const required of REQUIRED_NARRATIVE_BEATS) {
    if (beats.includes(required)) continue;
    const templateIndex = templateBeats.indexOf(required);
    if (templateIndex >= 0 && templateIndex < beats.length && beats[templateIndex] !== required) {
      beats[templateIndex] = required;
    }
  }
  return beats;
}

/** Normalize LLM/source analysis into an actionable product-safe storyboard. */
export function buildSemanticStoryboard(input: SemanticStoryboardBuildInput): SemanticStoryboard {
  const raw = asRecord(input.rawAnalysis);
  const rawShots = Array.isArray(raw.shotList) ? raw.shotList : [];
  const segments = input.segments.length > 0 ? input.segments : [{ startSec: 0, endSec: 5 }];
  const productName = text(input.productName, 'the product');
  const count = resolveShotCount(segments.length);

  // P5：原始 LLM 返回必须先经 schema 校验。无效/空分析 → 明确 fallback，
  // 不得记录为「已深度理解原视频」。
  const schemaCheck = validateReferenceAnalysis(input.rawAnalysis);
  const rawValid = schemaCheck.valid;
  const templateBeats = [...(BEAT_CHAINS[count] ?? BEAT_CHAINS[6])];
  const resolvedBeats = resolveShotBeats(raw, segments, templateBeats);

  const contracts: NarrativeShotContract[] = buildTemplateContracts({
    productName,
    segments: segments.map(({ startSec, endSec, candidateId }) => ({ startSec, endSec, candidateId })),
    rawAnalysis: input.rawAnalysis,
    rawValid,
    rawShots,
  });

  // 把解析出的 beat 覆盖到契约上（模板契约的文本与状态链保持完整）
  const shots: SemanticStoryboardShot[] = contracts.map((contract, index) => {
    const segment = segments[index] ?? { startSec: index, endSec: index + 1 };
    const fallbackIndex = fallbackIndexForBeat(index, count);
    const source = findRawShot(rawShots, segment, index);
    const beat = resolvedBeats[index] ?? contract.beat;
    const prev = index > 0 ? contracts[index - 1] : null;
    return {
      shotIndex: index + 1,
      startSec: Number(segment.startSec),
      endSec: Number(segment.endSec),
      beat,
      purpose: contract.purpose,
      sourceAction: contract.action,
      audienceEffect: rawValid
        ? text(source.audienceEffect || source.mood, AUDIENCE_EFFECTS[beat] ?? AUDIENCE_EFFECTS.demo)
        : AUDIENCE_EFFECTS[beat] ?? AUDIENCE_EFFECTS.demo,
      visualTechnique: rawValid
        ? text([source.shotType, source.cameraMovement].filter(Boolean).join(' · '), VISUAL_TECHNIQUES[beat] ?? '')
        : VISUAL_TECHNIQUES[beat] ?? '',
      preState: contract.preState,
      postState: contract.postState,
      stateIn: [...contract.stateIn],
      stateOut: [...contract.stateOut],
      transitionIn: contract.transitionIn,
      transitionOut: contract.transitionOut,
      productRole: roleForBeat(beat),
      replacementIntent: contract.replacementIntent,
      // P3 稳定性修复：provider prompt 动作来源 = 安全代理；raw 原动作只作审计
      sourceActionAudit: contract.sourceActionAudit,
      safeVisualProxy: contract.safeVisualProxy || contract.action,
      safeCoverageCriteria: [...contract.safeCoverageCriteria],
    };
  });

  const visualGrammar = asRecord(raw.visualGrammar || raw.visualLanguage);
  const sourceStructure = asRecord(raw.videoStructure);
  const originalScript = asRecord(raw.originalScript);
  const sourceIntent = text(
    raw.sourceIntent || raw.coreMessage || raw.rationale,
    '通过痛点提出、产品进入、使用动作和结果证明，把观众从问题带到解决方案。'
  );

  return {
    version: 'v1',
    sourceIntent,
    coreMessage: text(raw.coreMessage || originalScript.estimatedScript, `${productName} 以可观察的使用动作解决明确清洁问题。`),
    audienceProblem: text(raw.audienceProblem || raw.problem, '观众需要先看见具体残留或使用痛点，才会相信产品有必要。'),
    emotionalArc: text(raw.emotionalArc || raw.mood, '好奇 → 发现问题 → 看到解决方案 → 观察结果 → 记住产品'),
    sellingMechanism: text(raw.sellingMechanism || raw.rationale, '用画面中的因果动作和结果对比代替空泛口号。'),
    visualGrammar: {
      pacing: text(visualGrammar.pacing || sourceStructure.pacing, '前快后稳，动作段保持连续方向。'),
      cameraLanguage: text(visualGrammar.cameraLanguage || raw.camera, '短促推进、宏观细节、稳定产品英雄镜头。'),
      composition: text(visualGrammar.composition || raw.composition, '主体明确、背景克制、产品在安全区内可读。'),
      transitionLanguage: text(visualGrammar.transitionLanguage, '用同一台面、光线和动作结果完成 match cut。'),
    },
    shots,
    evidence: {
      source: input.rawAnalysis ? (rawValid ? 'hybrid' : 'deterministic_fallback') : 'deterministic_fallback',
      schemaValid: rawValid,
      analyzedKeyframeCount: Math.max(0, Number(input.analyzedKeyframeCount || 0)),
      referenceSegments: segments.map((segment) => ({ ...segment })),
      rawAnalysisAvailable: Boolean(input.rawAnalysis && rawValid),
      ...(input.rawAnalysis && !rawValid ? { validationErrors: schemaCheck.errors } : {}),
    },
  };
}

export function validateSemanticStoryboard(storyboard: SemanticStoryboard): string[] {
  const errors: string[] = [];
  if (storyboard.version !== 'v1') errors.push('unsupported semantic storyboard version');
  if (storyboard.shots.length < 6 || storyboard.shots.length > 8) errors.push('semantic storyboard must contain 6-8 shots');
  const required: SemanticBeat[] = ['hook', 'problem', 'demo', 'proof', 'cta'];
  for (const beat of required) {
    if (!storyboard.shots.some((shot) => shot.beat === beat)) errors.push(`semantic storyboard missing beat: ${beat}`);
  }
  let previousEnd = -Infinity;
  storyboard.shots.forEach((shot, index) => {
    if (shot.shotIndex !== index + 1) errors.push(`semantic shot index ${index + 1} is not stable`);
    if (!(shot.endSec > shot.startSec)) errors.push(`semantic shot ${shot.shotIndex} has invalid timing`);
    if (shot.startSec < previousEnd) errors.push(`semantic shot ${shot.shotIndex} overlaps the previous shot`);
    previousEnd = shot.endSec;
    if (shot.purpose.trim().length < 6) errors.push(`semantic shot ${shot.shotIndex} has no meaningful purpose`);
    if (/^(产品特写|产品展示|镜头\s*\d+|close[- ]?up)$/i.test(shot.purpose.trim())) {
      errors.push(`semantic shot ${shot.shotIndex} is decorative rather than purposeful`);
    }
    if (!shot.sourceAction.trim()) errors.push(`semantic shot ${shot.shotIndex} has no source action`);
    if (!shot.preState.trim() || !shot.postState.trim()) errors.push(`semantic shot ${shot.shotIndex} has no state contract`);
    if (!shot.transitionIn.trim() || !shot.transitionOut.trim()) errors.push(`semantic shot ${shot.shotIndex} has no transition contract`);
    if (!shot.replacementIntent.includes('替换')) errors.push(`semantic shot ${shot.shotIndex} has no de-identification replacement rule`);
  });
  // 状态链：下一镜 stateIn ⊆ 上一镜 stateOut
  for (let i = 1; i < storyboard.shots.length; i++) {
    const prev = storyboard.shots[i - 1];
    const cur = storyboard.shots[i];
    const missing = cur.stateIn.filter((token) => !prev.stateOut.includes(token));
    if (missing.length > 0) {
      errors.push(`semantic shot ${cur.shotIndex} requires state [${missing.join(', ')}] not produced by shot ${prev.shotIndex}`);
    }
    if (cur.stateIn.length > 0 && !prev.postState.trim()) {
      errors.push(`semantic shot ${cur.shotIndex} transitionIn cannot trace to previous postState`);
    }
  }
  return errors;
}

/** Prompt for the one non-paid “understand the source” pass. */
export function buildSemanticStoryboardPrompt(input: {
  productName: string;
  segments: SemanticReferenceSegment[];
  /**
   * A single still is enough for composition, but not for an action or a
   * hand-off.  The runner can instead send one early/middle/late strip per
   * candidate segment so the non-paid source-analysis pass can see change.
   */
  frameEvidence?: 'single_keyframe' | 'early_mid_late_strip';
}): { system: string; user: string } {
  const frameEvidence = input.frameEvidence ?? 'single_keyframe';
  const segmentLines = input.segments
    .map((segment, index) => `${index + 1}. ${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}s`)
    .join('\n');
  const frameEvidenceInstruction = frameEvidence === 'early_mid_late_strip'
    ? 'Each candidate image is one chronological strip: LEFT = early, CENTRE = middle, RIGHT = late. Infer sourceAction, state change, camera movement, and the edit hand-off from the change across the three panels; do not describe only the centre panel.'
    : 'Each candidate image is a single representative keyframe. Only claim an action or hand-off when it is visually supported; otherwise mark the evidence as uncertain.';
  return {
    system: `你是短视频导演和广告叙事分析师。你要分析参考爆款视频的“表达逻辑”，不是复述画面物体。
回答必须说明：它先让观众看到什么问题，再用什么动作建立因果，最后如何把注意力交还给产品。
把人物、脸、竞品、字幕和品牌身份视为不可复制的源元素；只提取节奏、构图、动作、情绪推进和转场方法。
选段覆盖要求：必须覆盖原视频的开头（Hook）、中段（卖货机制）与结尾（CTA），
镜头候选按叙事价值标注（narrativeValue 0-1，与镜头时长无关；开头钩子/结果证明/收尾 CTA 价值最高）。
${frameEvidenceInstruction}
必须返回纯 JSON：
{"sourceIntent":"...","coreMessage":"...","audienceProblem":"...","emotionalArc":"...","sellingMechanism":"...","visualGrammar":{"pacing":"...","cameraLanguage":"...","composition":"...","transitionLanguage":"..."},"shotList":[{"shotIndex":1,"purpose":"...","sourceAction":"...","sourceActionAudit":"原视频动作/字幕/标签/时间段（仅审计）","safeVisualProxy":"可生成的安全替代动作：无人物、无手、无字幕、无标签，产品/喷嘴/泡沫/中性台面承担动作","safeCoverageCriteria":["QA 应检查的可见结果 1","QA 应检查的可见结果 2"],"audienceEffect":"...","visualTechnique":"...","transitionIn":"...","transitionOut":"...","preState":"...","postState":"...","beat":"hook|problem|product_intro|demo|proof|comparison|benefit|cta"}],"narrativeBeats":[{"beat":"...","startSec":0,"endSec":3,"intent":"..."}],"shotCandidates":[{"startSec":0,"endSec":3,"beat":"hook","narrativeValue":0.95}]}
说明：sourceActionAudit 原样记录源动作及其中的字幕/标签文字（如「粗大毛孔」），只用于审计；safeVisualProxy 是给生成模型的安全替代动作，必须不含人物/手/字幕/标签/原视频文字；safeCoverageCriteria 是后续 QA 检查该镜是否兑现的可见标准（3-4 条）。`,
    user: `目标产品：${input.productName}
参考视频已按以下顺序提供候选镜头证据，请按镜头顺序分析语义与承接：
${segmentLines}
不要照抄原视频文字或身份；请给每个镜头一个不可省略的叙事目的，以及它把什么状态交给下一镜。${frameEvidence === 'early_mid_late_strip' ? ' 对每个候选镜头，必须优先依据左→中→右的变化填写 sourceAction 和 transitionOut。' : ''}`,
  };
}

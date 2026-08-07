/**
 * ReferenceAnalysis — 原视频「语义理解」的领域契约（纯模块，无 I/O）。
 *
 * 职责边界：
 * - 定义原视频分析结果的结构化输出（全局意图 / 受众痛点 / 卖货机制 / 视觉语法 /
 *   节奏 / 时间轴 / 镜头候选 / 置信度）；
 * - 对 LLM/分析器原始返回做 schema 校验：空对象、缺字段、无效分析只能标为
 *   fallback/unverified，绝不能记录为「已深度理解原视频」；
 * - 叙事选段：选段必须覆盖开头/中段/结尾，按叙事价值而非镜头时长选取；
 * - 确定性回退：分析不足时明确标记 fallback。
 *
 * 本模块不依赖 Express / SQLite / 环境变量 / fetch；外部调用一律经调用方注入。
 */

import type { SemanticBeat } from '../production-plan/narrative-shot-contract';

export type AnalysisSource = 'llm_vision' | 'deterministic_fallback' | 'hybrid';
export type AnalysisConfidence = 'high' | 'medium' | 'low';
export type NarrativeZone = 'begin' | 'middle' | 'end';

/** 时间轴上的一个已选/候选镜头段 */
export interface ReferenceSegment {
  startSec: number;
  endSec: number;
  narrativeZone: NarrativeZone;
  /** 叙事价值评分（0-1）：按叙事职责打分，与时长无关 */
  narrativeValue: number;
  narrativeRole?: SemanticBeat;
  /** 候选段标识（P5 三轮：贯穿 LLM→选段→storyboard 的语义继承坐标） */
  candidateId?: string;
  structure?: string;
}

/** 原视频分析输出结构（结构化、可 schema 校验） */
export interface ReferenceAnalysis {
  version: 'v1';
  source: AnalysisSource;
  /** raw LLM 返回是否通过 schema 校验；false = 只能按 fallback 使用 */
  schemaValid: boolean;
  rawAnalysisAvailable: boolean;
  confidence: AnalysisConfidence;
  /** 全局意图：原视频想先让观众看到什么、最后把注意力交还给什么 */
  globalIntent: string;
  audiencePain: string;
  sellingMechanism: string;
  visualGrammar: {
    pacing: string;
    cameraLanguage: string;
    composition: string;
    transitionLanguage: string;
  };
  rhythm: string;
  /** 时间轴：开头/中段/结尾的叙事段（每个 zone 至少一段） */
  timeline: ReferenceSegment[];
  /** 镜头候选：供选段使用（含叙事职责与价值评分，不按时长） */
  shotCandidates: ReferenceSegment[];
  validationErrors?: string[];
}

/** 原始分析器（LLM）返回的最小可接受结构 */
export interface RawShotCandidate {
  shotIndex?: number;
  startSec?: number;
  endSec?: number;
  /** hook/problem/product_intro/demo/proof/benefit/comparison/cta */
  beat?: string;
  /** 0-1 叙事价值（非时长） */
  narrativeValue?: number;
  purpose?: string;
}

export interface RawReferenceAnalysis {
  sourceIntent?: string;
  globalIntent?: string;
  audiencePain?: string;
  problem?: string;
  sellingMechanism?: string;
  rationale?: string;
  visualGrammar?: Record<string, unknown>;
  visualLanguage?: Record<string, unknown>;
  rhythm?: string;
  pacing?: string;
  shotCandidates?: RawShotCandidate[];
  shotList?: RawShotCandidate[];
  narrativeBeats?: RawShotCandidate[];
  timeline?: RawShotCandidate[];
}

export const SHOT_COUNT_RANGE = { min: 6, max: 8 } as const;

/** 合法节拍集合（与 production-plan 的叙事链共用同一词表） */
export const LEGAL_BEATS: SemanticBeat[] = [
  'hook',
  'problem',
  'product_intro',
  'demo',
  'proof',
  'comparison',
  'benefit',
  'cta',
];

// ==================== Schema 校验 ====================

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 对 LLM 原始返回做 schema 校验。
 * 判定「可视为深度理解」的最低要求：
 * - 必须能解析为对象且非空；
 * - 全局意图（sourceIntent/globalIntent）非空；
 * - 至少提供 2 个带有效时间的镜头候选/节拍（时间戳可落在参考片长内）。
 * 缺任何一项 → invalid；调用方只能走确定性回退，不得记录为已理解。
 */
export function validateReferenceAnalysis(raw: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { valid: false, errors: ['raw analysis is not an object'] };
  }
  if (Object.keys(raw).length === 0) {
    return { valid: false, errors: ['raw analysis is an empty object'] };
  }
  const intent = raw.sourceIntent ?? raw.globalIntent ?? raw.coreMessage;
  if (!isValidText(intent)) {
    errors.push('missing globalIntent/sourceIntent');
  }
  const shots = Array.isArray(raw.shotCandidates)
    ? raw.shotCandidates
    : Array.isArray(raw.shotList)
      ? raw.shotList
      : Array.isArray(raw.timeline)
        ? raw.timeline
        : [];
  const beats = Array.isArray(raw.narrativeBeats) ? raw.narrativeBeats : [];
  const timed = [...shots, ...beats].filter(
    (s) =>
      isRecord(s) &&
      ((isFiniteNum(s.startSec) && isFiniteNum(s.endSec)) || isFiniteNum(s.shotIndex))
  );
  if (timed.length < 2) {
    errors.push('less than 2 timed shot candidates / narrative beats');
  }
  const anyBeat = [...shots, ...beats].some((s) => isRecord(s) && isValidText(s.beat));
  if (!anyBeat) {
    errors.push('no shot candidate declares a narrative beat');
  }
  return { valid: errors.length === 0, errors };
}

// ==================== 确定性回退分析 ====================

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(value: unknown, fallback: string): string {
  return isValidText(value) ? (value as string).trim() : fallback;
}

/**
 * 确定性回退分析：分析器不可用/校验失败时使用。
 * 明确标记 confidence='low' / source='deterministic_fallback' /
 * schemaValid=false——调用方不得把该结果描述为「已深度理解原视频」。
 */
export function buildFallbackReferenceAnalysis(input: {
  productName: string;
  durationSec: number;
  segments: ReferenceSegment[];
}): ReferenceAnalysis {
  const productName = text(input.productName, 'the product');
  return {
    version: 'v1',
    source: 'deterministic_fallback',
    schemaValid: false,
    rawAnalysisAvailable: false,
    confidence: 'low',
    globalIntent: `通过痛点提出、产品进入、使用动作和结果证明，把观众从问题带到 ${productName} 的解决方案。`,
    audiencePain: '观众需要先看见具体残留或使用痛点，才会相信产品有必要。',
    sellingMechanism: '用画面中的因果动作和结果对比代替空泛口号。',
    visualGrammar: {
      pacing: '前快后稳，动作段保持连续方向。',
      cameraLanguage: '短促推进、宏观细节、稳定产品英雄镜头。',
      composition: '主体明确、背景克制、产品在安全区内可读。',
      transitionLanguage: '用同一台面、光线和动作结果完成 match cut。',
    },
    rhythm: 'hook 快切 → 中段稳定动作 → 收尾产品留驻。',
    timeline: input.segments.map((segment, index) => ({
      ...segment,
      narrativeRole: fallbackRoleForIndex(index, input.segments.length),
    })),
    shotCandidates: input.segments.map((segment, index) => ({
      ...segment,
      narrativeRole: fallbackRoleForIndex(index, input.segments.length),
    })),
  };
}

/** 回退角色分配：第 1 镜 hook、最后一镜 cta、中间按模板节拍链 */
export function fallbackRoleForIndex(index: number, count: number): SemanticBeat {
  if (index === 0) return 'hook';
  if (index === count - 1) return 'cta';
  if (index === 1) return 'problem';
  if (index === 2) return 'product_intro';
  if (index === 3) return 'demo';
  if (index === 4) return 'proof';
  if (index === 5) return count >= 8 ? 'comparison' : 'benefit';
  return 'benefit';
}

// ==================== 叙事选段（开头/中段/结尾，按叙事价值） ====================

export interface SegmentSelectionInput {
  /** 场景检测切点（秒，升序；不含 0 与结尾） */
  sceneChanges: number[];
  durationSec: number;
  shotCount: number;
  /** 可选：已通过 schema 校验的原始分析（提供带叙事价值的镜头候选） */
  rawAnalysis?: unknown;
  /** 可选：人工审核段覆盖（直接返回，不做叙事挑选） */
  overrides?: Array<{ startSec: number; endSec: number }>;
  /**
   * 可选：候选段（与 LLM prompt 的候选帧顺序一致，P5 二轮坐标贯穿）。
   * 提供时作为候选池并支持 LLM shotCandidates.shotIndex（1-based）直接映射；
   * 缺省时用 sceneChanges 重建候选。
   */
  candidates?: Array<{ candidateId?: string; startSec: number; endSec: number }>;
}

const MIN_SEGMENT_SEC = 1.2;

/** 归一化节拍 → 叙事价值权重（hook/proof/cta 的叙事价值高于普通展示） */
export function narrativeValueForRole(role: string | undefined, fallback = 0.5): number {
  switch (String(role ?? '').toLowerCase()) {
    case 'hook':
      return 1.0;
    case 'cta':
      return 0.95;
    case 'proof':
      return 0.9;
    case 'comparison':
      return 0.85;
    case 'problem':
      return 0.8;
    case 'demo':
      return 0.75;
    case 'benefit':
      return 0.7;
    case 'product_intro':
      return 0.65;
    default:
      return fallback;
  }
}

function zonesOf(durationSec: number): Array<{ zone: NarrativeZone; start: number; end: number }> {
  const third = durationSec / 3;
  return [
    { zone: 'begin', start: 0, end: third },
    { zone: 'middle', start: third, end: 2 * third },
    { zone: 'end', start: 2 * third, end: durationSec },
  ];
}

/** 把场景切点转成候选镜头段（过滤过短段） */
export function sceneSegments(
  sceneChanges: number[],
  durationSec: number
): Array<{ startSec: number; endSec: number }> {
  const bounds = [0, ...sceneChanges.filter((t) => t > 0 && t < durationSec), durationSec];
  const segments: Array<{ startSec: number; endSec: number }> = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start >= MIN_SEGMENT_SEC) segments.push({ startSec: start, endSec: end });
  }
  return segments;
}

function zoneOf(seg: { startSec: number; endSec: number }, zones: Array<{ zone: NarrativeZone; start: number; end: number }>): NarrativeZone {
  const mid = (seg.startSec + seg.endSec) / 2;
  for (const z of zones) {
    if (mid >= z.start && mid < z.end) return z.zone;
  }
  return 'middle';
}

/**
 * 候选段 → LLM 价值映射（P5 二轮修复：坐标贯穿）。
 * LLM 的 shotCandidates/shotList/narrativeBeats 可携带：
 * - shotIndex（1-based 候选序号，对应 LLM prompt 的候选帧顺序）→ 直接映射到 candidates[i]；
 * - 或真实视频秒数（startSec/endSec）→ 与候选段秒数重叠匹配。
 * 两种坐标都匹配不上 → 该候选无 LLM 标注（走分区保底）。
 */
function candidateScores(
  raw: RawReferenceAnalysis | null,
  candidates: Array<{ candidateId?: string; startSec: number; endSec: number }>
): Map<number, { role?: SemanticBeat; value: number }> {
  const scores = new Map<number, { role?: SemanticBeat; value: number }>();
  if (!raw || candidates.length === 0) return scores;
  const annotated = [
    ...(Array.isArray(raw.shotCandidates) ? raw.shotCandidates : []),
    ...(Array.isArray(raw.shotList) ? raw.shotList : []),
    ...(Array.isArray(raw.narrativeBeats) ? raw.narrativeBeats : []),
  ];
  for (const c of annotated) {
    let target = -1;
    // 优先 shotIndex（候选序号，1-based）
    if (isFiniteNum(c.shotIndex) && (c.shotIndex as number) >= 1 && (c.shotIndex as number) <= candidates.length) {
      target = (c.shotIndex as number) - 1;
    } else {
      // 秒数重叠匹配
      const start = isFiniteNum(c.startSec) ? c.startSec : undefined;
      const end = isFiniteNum(c.endSec) ? c.endSec : undefined;
      if (start !== undefined && end !== undefined) {
        target = candidates.findIndex(
          (seg) => (start as number) <= seg.endSec && (end as number) >= seg.startSec
        );
      }
    }
    if (target < 0) continue;
    if (scores.has(target)) continue; // 首个标注优先（显式 narrativeValue 不被后续 role 推导覆盖）
    const role = normalizeRole(c.beat ?? '');
    const declared = isFiniteNum(c.narrativeValue) ? c.narrativeValue : undefined;
    scores.set(target, {
      ...(role ? { role } : {}),
      value: declared ?? narrativeValueForRole(role),
    });
  }
  return scores;
}

function normalizeRole(raw: string): SemanticBeat | undefined {
  const value = raw.toLowerCase();
  if (value.includes('hook') || value.includes('开场')) return 'hook';
  if (value.includes('problem') || value.includes('痛点')) return 'problem';
  if (value.includes('intro') || value.includes('产品')) return 'product_intro';
  if (value.includes('demo') || value.includes('使用')) return 'demo';
  if (value.includes('proof') || value.includes('效果') || value.includes('证明')) return 'proof';
  if (value.includes('comparison') || value.includes('对比')) return 'comparison';
  if (value.includes('benefit') || value.includes('利益')) return 'benefit';
  if (value.includes('cta') || value.includes('收尾')) return 'cta';
  return undefined;
}

/**
 * 叙事选段主入口：保证 开头/中段/结尾 全覆盖，按叙事价值选取。
 *
 * 规则：
 * 1. 三个 zone（开头/中段/结尾）各至少选 1 段（除非该 zone 无可用镜头）；
 * 2. 同一 zone 内按叙事价值降序取段（LLM 候选标注的 beat 决定价值；无标注时
 *    开头/结尾段的默认价值高于中段——Hook/CTA 优先），再按片内位置升序排布；
 * 3. 绝不按镜头时长排序挑选；
 * 4. 不足 shotCount 时在剩余段中按价值补齐；仍不足则均匀切分兜底。
 */
export function selectNarrativeSegments(input: SegmentSelectionInput): ReferenceSegment[] {
  const { durationSec, shotCount } = input;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const count = Math.max(SHOT_COUNT_RANGE.min, Math.min(SHOT_COUNT_RANGE.max, shotCount));

  if (input.overrides && input.overrides.length > 0) {
    return input.overrides.slice(0, count).map((seg, index) => {
      const zone = zoneOf(seg, zonesOf(durationSec));
      return {
        startSec: seg.startSec,
        endSec: seg.endSec,
        narrativeZone: zone,
        narrativeValue: narrativeValueForRole(fallbackRoleForIndex(index, count)),
        narrativeRole: fallbackRoleForIndex(index, count),
      };
    });
  }

  const zones = zonesOf(durationSec);
  // 候选池：显式 candidates（与 LLM prompt 同坐标，保留 candidateId）优先，否则由场景切点重建
  const candidatePool: Array<{ startSec: number; endSec: number; candidateId?: string }> =
    input.candidates && input.candidates.length > 0
      ? input.candidates
      : sceneSegments(input.sceneChanges, durationSec).map((seg) => ({
          ...seg,
          candidateId: undefined,
        }));
  const pool: Array<{ startSec: number; endSec: number; candidateId?: string }> = candidatePool.map((seg) => ({
    startSec: Number(seg.startSec),
    endSec: Number(seg.endSec),
    ...(seg.candidateId ? { candidateId: seg.candidateId } : {}),
  }));
  const raw: RawReferenceAnalysis | null = (() => {
    const check = validateReferenceAnalysis(input.rawAnalysis);
    return check.valid && isRecord(input.rawAnalysis)
      ? (input.rawAnalysis as unknown as RawReferenceAnalysis)
      : null;
  })();
  const scores = candidateScores(raw, pool);

  const decorated = pool.map((seg, index) => {
    const zone = zoneOf(seg, zones);
    const annotated = scores.get(index);
    const { role, value } = annotated ?? { role: undefined, value: 0.5 };
    // 叙事价值：LLM 标注优先；未标注时 zone 保底（begin/end 高价值，middle 居中）
    const baseValue = value !== 0.5 || role
      ? value
      : zone === 'begin'
        ? 0.8
        : zone === 'end'
          ? 0.75
          : 0.5;
    return {
      startSec: seg.startSec,
      endSec: seg.endSec,
      narrativeZone: zone,
      narrativeValue: baseValue,
      narrativeRole: role,
      // 候选段标识随选段输出（storyboard 层据此继承 LLM 语义，P5 三轮）
      ...(seg.candidateId ? { candidateId: seg.candidateId } : {}),
      structure: role ? `镜（${role}）：保留参考视频该段落的叙事职责与构图` : undefined,
    } satisfies ReferenceSegment;
  });

  if (decorated.length === 0) {
    // 兜底：均匀切分
    return Array.from({ length: count }, (_, index) => ({
      startSec: (durationSec / count) * index,
      endSec: (durationSec / count) * (index + 1),
      narrativeZone: zoneOf(
        { startSec: (durationSec / count) * index, endSec: (durationSec / count) * (index + 1) },
        zones
      ),
      narrativeValue: narrativeValueForRole(fallbackRoleForIndex(index, count)),
      narrativeRole: fallbackRoleForIndex(index, count),
    }));
  }

  // 1) 每个 zone 至少选 1 段（按价值降序取该 zone 内最高价值段）
  const picked: ReferenceSegment[] = [];
  for (const z of zones) {
    const zoneSegs = decorated.filter((s) => s.narrativeZone === z.zone);
    if (zoneSegs.length === 0) continue;
    zoneSegs.sort((a, b) => b.narrativeValue - a.narrativeValue);
    picked.push(zoneSegs[0]);
  }

  // 2) 剩余配额按叙事价值降序补齐（跨 zone），保证叙事价值优先而非时长
  const remaining = decorated.filter((s) => !picked.includes(s));
  remaining.sort((a, b) => b.narrativeValue - a.narrativeValue);
  for (const seg of remaining) {
    if (picked.length >= count) break;
    picked.push(seg);
  }

  // 3) 仍不足（zone 段过少）：均匀兜底段补齐（不选重复段）
  const usedKeys = new Set(picked.map((s) => `${s.startSec}-${s.endSec}`));
  const fallbackSegs = Array.from({ length: count }, (_, index) => ({
    startSec: (durationSec / count) * index,
    endSec: (durationSec / count) * (index + 1),
  })).filter((s) => !usedKeys.has(`${s.startSec}-${s.endSec}`));
  for (const seg of fallbackSegs) {
    if (picked.length >= count) break;
    picked.push({
      ...seg,
      narrativeZone: zoneOf(seg, zones),
      narrativeValue: 0.4,
    });
  }

  // 4) 排序并确保编号稳定：按时间升序；超过配额的截断
  picked.sort((a, b) => a.startSec - b.startSec);
  return picked.slice(0, count).map((seg, index) => ({
    ...seg,
    narrativeRole: seg.narrativeRole ?? fallbackRoleForIndex(index, count),
  }));
}

// ==================== 归一化（raw → ReferenceAnalysis） ====================

/**
 * 把原始分析归一化为结构化 ReferenceAnalysis。
 * raw 未通过 schema 校验时返回确定性回退（明确标记 fallback），
 * 调用方不得把它描述为「已深度理解原视频」。
 */
export function normalizeReferenceAnalysis(input: {
  productName: string;
  rawAnalysis?: unknown;
  durationSec: number;
  segments: ReferenceSegment[];
}): ReferenceAnalysis {
  const check = validateReferenceAnalysis(input.rawAnalysis);
  if (!check.valid) {
    return buildFallbackReferenceAnalysis({
      productName: input.productName,
      durationSec: input.durationSec,
      segments: input.segments,
    });
  }
  const raw = input.rawAnalysis as unknown as RawReferenceAnalysis;
  const grammar = asRecord(raw.visualGrammar ?? raw.visualLanguage);
  const candidates = (Array.isArray(raw.shotCandidates) ? raw.shotCandidates : [])
    .filter(
      (c): c is RawShotCandidate =>
        isRecord(c) && isFiniteNum(c.startSec) && isFiniteNum(c.endSec)
    )
    .map((c) => ({
      startSec: c.startSec as number,
      endSec: c.endSec as number,
      narrativeZone: zoneOf(
        { startSec: c.startSec as number, endSec: c.endSec as number },
        zonesOf(input.durationSec)
      ),
      narrativeValue: isFiniteNum(c.narrativeValue)
        ? (c.narrativeValue as number)
        : narrativeValueForRole(c.beat),
      narrativeRole: normalizeRole(c.beat ?? ''),
    }));
  return {
    version: 'v1',
    source: 'llm_vision',
    schemaValid: true,
    rawAnalysisAvailable: true,
    confidence: 'medium',
    globalIntent: text(raw.globalIntent ?? raw.sourceIntent, '通过痛点提出、产品进入、使用动作和结果证明，把观众从问题带到解决方案。'),
    audiencePain: text(raw.audiencePain ?? raw.problem, '观众需要先看见具体残留或使用痛点，才会相信产品有必要。'),
    sellingMechanism: text(raw.sellingMechanism ?? raw.rationale, '用画面中的因果动作和结果对比代替空泛口号。'),
    visualGrammar: {
      pacing: text(grammar.pacing ?? raw.pacing, '前快后稳，动作段保持连续方向。'),
      cameraLanguage: text(grammar.cameraLanguage, '短促推进、宏观细节、稳定产品英雄镜头。'),
      composition: text(grammar.composition, '主体明确、背景克制、产品在安全区内可读。'),
      transitionLanguage: text(grammar.transitionLanguage, '用同一台面、光线和动作结果完成 match cut。'),
    },
    rhythm: text(raw.rhythm, 'hook 快切 → 中段稳定动作 → 收尾产品留驻。'),
    timeline: input.segments.map((segment, index) => ({
      ...segment,
      narrativeRole: segment.narrativeRole ?? fallbackRoleForIndex(index, input.segments.length),
    })),
    shotCandidates: candidates,
  };
}

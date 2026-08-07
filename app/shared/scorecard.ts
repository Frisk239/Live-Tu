/**
 * 质量评分卡契约 v1 (S1)
 *
 * 分层、typed、可解释的评分卡：
 * - 技术质量：可播放性、黑帧、时长、分辨率、字幕安全区、音轨有效性；
 * - 语义质量：产品/包装一致性、竞品残留、镜头结构覆盖、Hook 质量、
 *   主体形变、跨镜连续性、音画同步、合规风险。
 *
 * 约束（与 NEXT_PHASE_ROADMAP.md S1 一致）：
 * - 每个分数必须携带 evidence、confidence、scorer/scorerVersion；
 * - 自动评分（auto）只用于筛选，不得冒充最终质量结论 —— unverified 状态必须显式；
 * - 支持人工评分（manual）与自动评分并存；
 * - 明确区分 hard gate（硬门禁）、weighted score（加权分）、warning、unverified。
 */

export const SCORECARD_VERSION = 'v1.0.0';

export type DimensionLayer = 'technical' | 'semantic';

export type ScoreDimensionId =
  // --- 技术质量 ---
  | 'playability' // 视频可播放性
  | 'black_frame' // 黑帧
  | 'duration' // 时长
  | 'resolution' // 分辨率
  | 'subtitle_safe_area' // 字幕安全区
  | 'audio_track' // 音轨有效性
  // --- 语义质量 ---
  | 'product_consistency' // 产品/包装一致性
  | 'competitor_residue' // 竞品残留
  | 'shot_structure_coverage' // 镜头结构覆盖
  | 'hook_quality' // Hook 质量
  | 'subject_deformation' // 主体形变
  | 'cross_shot_continuity' // 跨镜连续性
  | 'av_sync' // 音画同步
  | 'compliance_risk'; // 合规风险

/** 评分状态：measured=真实测得；unverified=未能验证（不许当通过）；warning=有降级/警示 */
export type ScoreStatus = 'measured' | 'unverified' | 'warning';

/** 评分来源：auto=自动评分；manual=人工评分 */
export type ScoreKind = 'auto' | 'manual';

export interface ScoreEvidenceItem {
  /** 证据来源，例如 'ffprobe'、'blackdetect'、'synthetic-fixture'、'human-blind' */
  source: string;
  /** 证据细节（机器可读/可复现） */
  detail: string;
  /** 关联产物 URL（可选） */
  artifact?: string;
}

export interface ScoreEntry {
  id: ScoreDimensionId;
  layer: DimensionLayer;
  kind: ScoreKind;
  /** 0-1，越高越好 */
  value: number;
  status: ScoreStatus;
  evidence: ScoreEvidenceItem[];
  /** 0-1 */
  confidence: number;
  scorer: string;
  scorerVersion: string;
}

/** 维度权重：技术 0.30 + 语义 0.70 = 1.00（加权分只对 measured 维度有意义） */
export const DIMENSION_WEIGHTS: Record<ScoreDimensionId, number> = {
  playability: 0.06,
  black_frame: 0.06,
  duration: 0.04,
  resolution: 0.04,
  subtitle_safe_area: 0.05,
  audio_track: 0.05,
  product_consistency: 0.12,
  competitor_residue: 0.12,
  shot_structure_coverage: 0.1,
  hook_quality: 0.08,
  subject_deformation: 0.08,
  cross_shot_continuity: 0.08,
  av_sync: 0.06,
  compliance_risk: 0.06,
};

export const DIMENSION_LABELS: Record<ScoreDimensionId, string> = {
  playability: '视频可播放性',
  black_frame: '黑帧',
  duration: '时长',
  resolution: '分辨率',
  subtitle_safe_area: '字幕安全区',
  audio_track: '音轨有效性',
  product_consistency: '产品/包装一致性',
  competitor_residue: '竞品残留',
  shot_structure_coverage: '镜头结构覆盖',
  hook_quality: 'Hook 质量',
  subject_deformation: '主体形变',
  cross_shot_continuity: '跨镜连续性',
  av_sync: '音画同步',
  compliance_risk: '合规风险',
};

const DIMENSION_LAYERS: Record<ScoreDimensionId, DimensionLayer> = {
  playability: 'technical',
  black_frame: 'technical',
  duration: 'technical',
  resolution: 'technical',
  subtitle_safe_area: 'technical',
  audio_track: 'technical',
  product_consistency: 'semantic',
  competitor_residue: 'semantic',
  shot_structure_coverage: 'semantic',
  hook_quality: 'semantic',
  subject_deformation: 'semantic',
  cross_shot_continuity: 'semantic',
  av_sync: 'semantic',
  compliance_risk: 'semantic',
};

export function dimensionLayer(id: ScoreDimensionId): DimensionLayer {
  return DIMENSION_LAYERS[id];
}

/** 硬门禁：measured 且 value >= min 才算 passed；unverified 一律不算通过 */
export interface HardGateRule {
  dimension: ScoreDimensionId;
  /** 阈值（0-1） */
  min: number;
  /** 用途说明（在报告中展示） */
  purpose: string;
}

export const HARD_GATE_RULES: HardGateRule[] = [
  { dimension: 'playability', min: 1, purpose: '视频必须可播放（有可解码的视频轨）' },
  { dimension: 'black_frame', min: 0.9, purpose: '黑帧占比不得超过 10%' },
  { dimension: 'audio_track', min: 1, purpose: '音轨必须有效（否则成片无声音）' },
  { dimension: 'product_consistency', min: 0.8, purpose: '产品/包装必须一致（替换目标达成）' },
  { dimension: 'competitor_residue', min: 1, purpose: '不得残留竞品标识/包装' },
  { dimension: 'compliance_risk', min: 1, purpose: '不得有合规风险（违禁词/侵权内容）' },
];

export interface HardGateResult {
  dimension: ScoreDimensionId;
  label: string;
  status: 'passed' | 'failed' | 'unverified';
  actual: number | null;
  min: number;
  purpose: string;
}

export interface WeightedScoreResult {
  /** 加权总分 0-1 */
  value: number;
  /** 参与加权的 measured 维度数 */
  measuredCount: number;
  /** 未验证维度数（加权分含其名义值，不能当结论） */
  unverifiedCount: number;
}

export interface Scorecard {
  version: string;
  generatedBy: string;
  sampleId: string;
  runId: string;
  dimensions: ScoreEntry[];
  weighted: WeightedScoreResult;
  hardGates: HardGateResult[];
  /** 所有硬门禁均 measured 且通过 */
  hardGatesPassed: boolean;
  /** 人工评分记录（可选，与自动评分并存） */
  manualReview?: {
    reviewer: string;
    comment?: string;
    submittedAt: number;
  };
}

export function computeWeightedScore(entries: ScoreEntry[]): WeightedScoreResult {
  let sum = 0;
  let measuredCount = 0;
  let unverifiedCount = 0;
  for (const entry of entries) {
    const weight = DIMENSION_WEIGHTS[entry.id] ?? 0;
    sum += weight * entry.value;
    if (entry.status === 'measured') measuredCount += 1;
    else if (entry.status === 'unverified') unverifiedCount += 1;
  }
  return { value: sum, measuredCount, unverifiedCount };
}

export function evaluateHardGates(entries: ScoreEntry[]): HardGateResult[] {
  return HARD_GATE_RULES.map((rule) => {
    const entry = entries.find((e) => e.id === rule.dimension);
    const actual = entry ? entry.value : null;
    let status: HardGateResult['status'] = 'unverified';
    if (entry) {
      if (actual !== null && actual < rule.min) {
        // 观测值低于阈值 → 无论 measured/unverified 都判 failed（不能靠未验证逃脱门禁）
        status = 'failed';
      } else if (entry.status === 'measured') {
        status = 'passed';
      }
    }
    return {
      dimension: rule.dimension,
      label: DIMENSION_LABELS[rule.dimension],
      status,
      actual,
      min: rule.min,
      purpose: rule.purpose,
    };
  });
}

export function hardGatesPassed(results: HardGateResult[]): boolean {
  return results.length > 0 && results.every((r) => r.status === 'passed');
}

/** 校验权重总和为 1（防止有人改权重后加权分不可比） */
export function assertScorecardIntegrity(): void {
  const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`评分卡权重断言失败：权重总和为 ${sum}，必须等于 1。`);
  }
  const ids = Object.keys(DIMENSION_WEIGHTS) as ScoreDimensionId[];
  const uniq = new Set(ids);
  if (uniq.size !== ids.length) {
    throw new Error('评分卡权重断言失败：维度 ID 重复。');
  }
  for (const rule of HARD_GATE_RULES) {
    if (!(rule.dimension in DIMENSION_WEIGHTS)) {
      throw new Error(`评分卡硬门禁断言失败：未知维度 ${rule.dimension}。`);
    }
  }
}

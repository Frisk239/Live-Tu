/**
 * 评分卡引擎 (S1) — 纯函数、确定性、可测试。
 *
 * - 把「技术/语义维度原始观测」转换为 typed Scorecard（evidence/confidence/scorer/status）；
 * - 提供 synthetic-fixture scorer：不触发真实付费调用，seed 化 PRNG 保证跨机器可复现；
 * - 支持人工评分（manual）合并：manual 覆盖同名 auto 维度，且状态为 measured；
 * - hard gate / weighted score / warning / unverified 的区分由 shared/scorecard 定义。
 *
 * 重要：synthetic scorer 的输出永远标记 status='unverified'（只做筛选，
 * 不冒充最终质量结论）；只有人工评分或真实 ffprobe/质检工具的结果才可能为 measured。
 */
import {
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  SCORECARD_VERSION,
  computeWeightedScore,
  dimensionLayer,
  evaluateHardGates,
  hardGatesPassed,
  type ScoreDimensionId,
  type ScoreEntry,
  type Scorecard,
  type ScoreStatus,
} from '../../shared/scorecard';

/** 确定性 PRNG（mulberry32）：同一 seed 在任何平台上产生相同序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DimensionObservation {
  id: ScoreDimensionId;
  value: number;
  status: ScoreStatus;
  confidence: number;
  scorer: string;
  scorerVersion: string;
  evidence: Array<{ source: string; detail: string; artifact?: string }>;
}

export interface BuildScorecardInput {
  sampleId: string;
  runId: string;
  observations: DimensionObservation[];
  manual?: Array<{ id: ScoreDimensionId; value: number; reviewer: string; comment?: string }>;
  generatedBy?: string;
  /** 人工评分提交时间（ms）。缺省 Date.now()；黄金集评测传固定值以保证结果确定性（审查 P2-4）。 */
  submittedAt?: number;
}

const ALL_DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as ScoreDimensionId[];

/** 生成缺省 unverified 观测（维度缺失时使用，绝不当真实测量） */
function fallbackObservation(id: ScoreDimensionId): DimensionObservation {
  return {
    id,
    value: 0.5,
    status: 'unverified',
    confidence: 0,
    scorer: 'missing',
    scorerVersion: SCORECARD_VERSION,
    evidence: [{ source: 'missing-observation', detail: `未提供 ${DIMENSION_LABELS[id]} 的观测，按 unverified 处理` }],
  };
}

export function buildScorecard(input: BuildScorecardInput): Scorecard {
  const byId = new Map<ScoreDimensionId, DimensionObservation>();
  for (const obs of input.observations) byId.set(obs.id, obs);
  for (const dim of ALL_DIMENSIONS) if (!byId.has(dim)) byId.set(dim, fallbackObservation(dim));

  const manualById = new Map<string, { value: number; reviewer: string; comment?: string }>();
  for (const m of input.manual ?? []) manualById.set(m.id, m);

  const entries: ScoreEntry[] = ALL_DIMENSIONS.map((id) => {
    const obs = byId.get(id)!;
    const manual = manualById.get(id);
    const layer = dimensionLayer(id);
    if (manual) {
      return {
        id,
        layer,
        kind: 'manual' as const,
        value: Math.max(0, Math.min(1, manual.value)),
        status: 'measured' as const,
        confidence: 1,
        // 诚实标签（审查 P2）：当前是评审人直接录入的人工评分合并，不是匿名/随机序盲测
        scorer: `manual-review:${manual.reviewer}`,
        scorerVersion: SCORECARD_VERSION,
        evidence: [
          ...obs.evidence,
          { source: 'manual-review', detail: `人工评分 ${manual.value}（评审人 ${manual.reviewer}，非匿名盲测）` },
        ],
      };
    }
    return {
      id,
      layer,
      kind: 'auto' as const,
      value: Math.max(0, Math.min(1, obs.value)),
      status: obs.status,
      confidence: Math.max(0, Math.min(1, obs.confidence)),
      scorer: obs.scorer,
      scorerVersion: obs.scorerVersion,
      evidence: obs.evidence,
    };
  });

  const hardGates = evaluateHardGates(entries);
  const weighted = computeWeightedScore(entries);
  const reviewers = new Set(input.manual?.map((m) => m.reviewer) ?? []);
  const manualReview = reviewers.size > 0
    ? {
        reviewer: [...reviewers].join(', '),
        comment: input.manual?.map((m) => m.comment).find(Boolean),
        submittedAt: input.submittedAt ?? Date.now(),
      }
    : undefined;

  return {
    version: SCORECARD_VERSION,
    generatedBy: input.generatedBy ?? 'scorecard-eval',
    sampleId: input.sampleId,
    runId: input.runId,
    dimensions: entries,
    weighted,
    hardGates,
    hardGatesPassed: hardGatesPassed(hardGates),
    manualReview,
  };
}

export interface SyntheticScorerInput {
  sampleId: string;
  runIndex: number;
  seed: number;
  artifactPresent: boolean;
  /** 失败注入（测试/演示用）：按比例压低加权分 */
  degradeWeightedBy?: number;
  /** 失败注入：指定维度硬门禁失败 */
  failHardGate?: ScoreDimensionId;
}

const SYNTHETIC_BASE: Record<ScoreDimensionId, number> = {
  playability: 1.0,
  black_frame: 0.98,
  duration: 0.92,
  resolution: 1.0,
  subtitle_safe_area: 0.94,
  audio_track: 1.0,
  product_consistency: 0.92,
  competitor_residue: 1.0,
  shot_structure_coverage: 0.88,
  hook_quality: 0.85,
  subject_deformation: 0.9,
  cross_shot_continuity: 0.87,
  av_sync: 0.93,
  compliance_risk: 1.0,
};

/**
 * synthetic-fixture scorer：用样本元数据 + seed 化 PRNG 生成确定性的筛选分。
 * - 状态恒为 unverified（不是真实测量，不得冒充质量结论）；
 * - 置信度恒为 0.25（低置信，仅供流程筛选/回归对比）；
 * - 同一 (sample, runIndex, seed, inject) 在任意机器上结果一致。
 */
export function syntheticScorecard(input: SyntheticScorerInput): Scorecard {
  const rand = mulberry32((input.seed * 1009 + input.runIndex * 7919) >>> 0);
  const observations: DimensionObservation[] = (Object.keys(SYNTHETIC_BASE) as ScoreDimensionId[]).map((id) => {
    const base = SYNTHETIC_BASE[id];
    // 小抖动（±0.02），同 seed 确定；base=1.0 的维度不加向下抖动，
    // 避免随机噪声把硬门禁（min=1.0）判失败
    const noise = base >= 1 ? 0 : (rand() - 0.5) * 0.04;
    let value = Math.max(0, Math.min(1, base + noise));
    if (input.degradeWeightedBy) {
      value = Math.max(0, value * (1 - input.degradeWeightedBy));
    }
    if (input.failHardGate && input.failHardGate === id) {
      value = 0.3;
    }
    return {
      id,
      value,
      status: 'unverified' as const,
      confidence: 0.25,
      scorer: 'synthetic-fixture-v1',
      scorerVersion: SCORECARD_VERSION,
      evidence: [
        {
          source: 'synthetic-fixture',
          detail:
            `synthetic scorer（seed=${input.seed}, run=${input.runIndex + 1}）：` +
            `非真实测量，仅用于流程筛选与回归对比；` +
            `产物 ${input.artifactPresent ? '存在' : '缺失'}。`,
        },
      ],
    };
  });

  return buildScorecard({
    sampleId: input.sampleId,
    runId: `${input.sampleId}-run-${input.runIndex + 1}`,
    observations,
    generatedBy: 'synthetic-fixture-v1',
  });
}

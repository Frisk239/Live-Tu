/**
 * P3 语义质量评分卡：镜头级语义检查契约
 *
 * 在 S1 技术 QA（shot-qa.ts：视频流/时长/分辨率/黑帧）之上，
 * 对每个生成镜头做语义维度检查：产品一致性、竞品残留、结构保留、Hook、
 * 形变、跨镜连续性、音画同步、合规。
 *
 * 约束（Phase 3 目标文档 §二）：
 * - 不把 LLM 自评分直接包装成「爆款分数」；
 * - 每项输出 pass/warning/fail/unverified + 问题证据 + 用户可理解原因 + 推荐修复动作；
 * - 有证据的 measured 维度才进硬门禁判定，unverified 不能逃脱门禁。
 */

import type { ScoreDimensionId, ScoreEvidenceItem, ScoreEntry, Scorecard } from './scorecard';
import {
  computeWeightedScore,
  evaluateHardGates,
  hardGatesPassed,
  SCORECARD_VERSION,
} from './scorecard';

// ==================== 判决（verdict） ====================

export type SemanticVerdict = 'pass' | 'warning' | 'fail' | 'unverified';

export const SEMANTIC_VERDICT_LABELS: Record<SemanticVerdict, string> = {
  pass: '通过',
  warning: '有风险',
  fail: '不合格',
  unverified: '未验证',
};

/** 语义维度 → 推荐修复动作（用户可执行） */
export interface SemanticFixSuggestion {
  /** 触发该修复的维度 ID */
  dimension: ScoreDimensionId;
  /** 用户可理解的操作描述 */
  action: string;
  /** 推荐的 prompt 修改片段（可直接拼接到生成 prompt） */
  promptFragment?: string;
  /** 参考资料 URL（产品图/参考视频关键帧等） */
  referenceUrl?: string;
  /**
   * S3：该维度的修复动作 = 重新生成产品条件化首帧（不是只追加 prompt）。
   * product_consistency 等维度必须重新派生首帧（参考关键帧构图 + 产品图包装）
   * 或更换参考输入后才能重拍。
   */
  regenerateFirstFrame?: boolean;
}

/**
 * 单个语义维度的检查结果（问题证据 + 原因 + 修复建议）
 */
export interface SemanticIssue {
  dimension: ScoreDimensionId;
  verdict: SemanticVerdict;
  /** 分数 0-1（verdict=unverified 时可为 null） */
  score: number | null;
  /** 问题证据列表（至少一条） */
  evidence: ScoreEvidenceItem[];
  /** 用户可理解的原因说明（产品语言，非技术术语） */
  reason: string;
  /** 推荐修复动作；verdict=pass 时为 null */
  fix: SemanticFixSuggestion | null;
}

/** 镜头级语义 QA 报告 */
export interface ShotSemanticQaReport {
  shotId: string;
  runId: string | null;
  /** 当前版本号（shot_versions.version） */
  version: number;
  /** 各维度检查结果 */
  issues: SemanticIssue[];
  /** 人工可读摘要（一句话总结） */
  summary: string;
  /** 与 shared/scorecard.ts 集成的评分卡（技术+语义） */
  scorecard: Scorecard;
  overallVerdict: SemanticVerdict;
  checkedAt: number;
  scorer: string;
  scorerVersion: string;
  /** 该镜头是否已有人工通过 */
  manualPassed: boolean;
  manualPassComment: string | null;
}

// ==================== 修复建议映射 ====================

/** 语义维度 ID（8 项，不含技术维度） */
export type SemanticScoreDimensionId =
  | 'product_consistency'
  | 'competitor_residue'
  | 'shot_structure_coverage'
  | 'hook_quality'
  | 'subject_deformation'
  | 'cross_shot_continuity'
  | 'av_sync'
  | 'compliance_risk';

export const SEMANTIC_DIMENSIONS: SemanticScoreDimensionId[] = [
  'product_consistency',
  'competitor_residue',
  'shot_structure_coverage',
  'hook_quality',
  'subject_deformation',
  'cross_shot_continuity',
  'av_sync',
  'compliance_risk',
];

/**
 * 语义维度 → 推荐 prompt 修改片段映射（产品语言）
 * 当某个维度 fail/warning 时，自动建议对应的 prompt 补充。
 */
export const SEMANTIC_FIX_MAP: Record<SemanticScoreDimensionId, (ctx?: string) => SemanticFixSuggestion> = {
  product_consistency: (ctx) => ({
    dimension: 'product_consistency',
    // S3：产品一致性的修复动作 = 重新生成产品条件化首帧（保持参考构图 + 产品包装），
    // 不能只追加 prompt——必须重新派生首帧后再重拍。
    action: '重新生成产品条件化首帧（保持参考关键帧构图，产品包装严格对齐产品图）后重拍该镜',
    promptFragment: 'Product appears as a light green tube with "BUV" branding and "小绿泥洁面" text on the packaging, green clay texture',
    referenceUrl: ctx,
    regenerateFirstFrame: true,
  }),
  competitor_residue: () => ({
    dimension: 'competitor_residue',
    action: '移除画面中任何非 BUV 品牌的标识、包装或文字',
    promptFragment: 'Only show BUV brand product, no other brand names or competitor products',
  }),
  shot_structure_coverage: () => ({
    dimension: 'shot_structure_coverage',
    action: '确保镜头保留参考视频的关键构图元素（景别、机位、运镜）',
  }),
  hook_quality: () => ({
    dimension: 'hook_quality',
    action: '增强开头吸引力：确保画面在前 1 秒即有视觉冲击力',
    promptFragment: 'Eye-catching opening shot with strong visual impact in the first second',
  }),
  subject_deformation: () => ({
    dimension: 'subject_deformation',
    action: '检查主体（人脸/产品）是否存在畸变或闪烁，必要时重新生成',
  }),
  cross_shot_continuity: () => ({
    dimension: 'cross_shot_continuity',
    action: '确保人物外观、场景、光线与前后镜头保持一致',
  }),
  av_sync: () => ({
    dimension: 'av_sync',
    action: '调整画面节奏与音轨/BGM 节奏对齐',
  }),
  compliance_risk: () => ({
    dimension: 'compliance_risk',
    action: '移除任何可能的违规内容（未备案文案、夸大功效、竞品对比）',
  }),
};

// ==================== 辅助函数 ====================

/** 从 issues 列表推导 overallVerdict（最严格维度决定整体：fail > unverified > warning > pass） */
export function deriveOverallVerdict(issues: SemanticIssue[]): SemanticVerdict {
  if (issues.some((i) => i.verdict === 'fail')) return 'fail';
  if (issues.some((i) => i.verdict === 'unverified')) return 'unverified';
  if (issues.some((i) => i.verdict === 'warning')) return 'warning';
  return 'pass';
}

/** 生成人工可读摘要（一句话） */
export function generateSummary(issues: SemanticIssue[]): string {
  const failCount = issues.filter((i) => i.verdict === 'fail').length;
  const warnCount = issues.filter((i) => i.verdict === 'warning').length;
  const unverCount = issues.filter((i) => i.verdict === 'unverified').length;
  const passCount = issues.filter((i) => i.verdict === 'pass').length;

  if (failCount === 0 && warnCount === 0 && unverCount === 0) {
    return `${passCount} 项全部通过`;
  }
  const parts: string[] = [];
  if (failCount > 0) {
    const failDims = issues.filter((i) => i.verdict === 'fail').map((i) => i.dimension);
    parts.push(`${failCount} 项不合格：${failDims.join('、')}`);
  }
  if (warnCount > 0) {
    const warnDims = issues.filter((i) => i.verdict === 'warning').map((i) => i.dimension);
    parts.push(`${warnCount} 项有风险：${warnDims.join('、')}`);
  }
  if (unverCount > 0) {
    parts.push(`${unverCount} 项未验证`);
  }
  return parts.join('；');
}

/** 从 SemanticIssue[] 构建 ScoreEntry[]（用于集成到 Scorecard） */
export function issuesToScoreEntries(issues: SemanticIssue[]): ScoreEntry[] {
  return issues.map((issue) => ({
    id: issue.dimension,
    layer: 'semantic' as const,
    kind: 'auto' as const,
    // unverified 维度无实测值：用名义值 1.0（与 S1 synthetic 语义一致——
    // 门禁按 status=unverified 判 unverified 而非 failed；加权分含其名义值但计入 unverifiedCount）
    value: issue.verdict === 'unverified' ? 1.0 : (issue.score ?? 0),
    status: issue.verdict === 'unverified'
      ? 'unverified'
      : issue.verdict === 'fail'
        ? 'measured' // fail 也算 measured（有证据）
        : issue.verdict === 'warning'
          ? 'warning'
          : 'measured',
    evidence: issue.evidence,
    confidence: issue.verdict === 'unverified' ? 0 : 0.7,
    scorer: 'semantic-qa-v1',
    scorerVersion: 'v1.0.0',
  }));
}

/** 将语义 issues 转为完整 Scorecard（与 shared/scorecard.ts 集成） */
export function buildSemanticScorecard(
  sampleId: string,
  runId: string,
  semanticIssues: ScoreEntry[],
  techEntries: ScoreEntry[] = []
): Scorecard {
  const allEntries = [...techEntries, ...semanticIssues];
  return {
    version: SCORECARD_VERSION,
    generatedBy: 'semantic-qa-engine',
    sampleId,
    runId,
    dimensions: allEntries,
    weighted: computeWeightedScore(allEntries),
    hardGates: evaluateHardGates(allEntries),
    hardGatesPassed: hardGatesPassed(evaluateHardGates(allEntries)),
  };
}

// ==================== LLM 语义检查 prompt 模板 ====================

/**
 * 构建发送给 LLM vision 的语义 QA prompt。
 * 生成镜头帧 + 参考视频关键帧 + 产品图 → LLM 评估 8 个语义维度。
 */
export function buildSemanticQaPrompt(opts: {
  shotIndex: number;
  product: string;
  productName: string;
  prohibitedItems: string[];
  allowedItems: string[];
  referenceStructure: string;
  shotPurpose?: string;
  sourceAction?: string;
  transitionIn?: string;
  transitionOut?: string;
}): { system: string; user: string } {
  const {
    product,
    productName,
    prohibitedItems,
    allowedItems,
    referenceStructure,
    shotPurpose,
    sourceAction,
    transitionIn,
    transitionOut,
  } = opts;

  const system = `你是短视频质量评审专家。任务：评估 AI 生成的视频镜头是否符合产品广告要求。

评估维度（8 项，每项必须返回 pass/warning/fail/unverified 之一）：

1. product_consistency（产品一致性）：生成镜头中出现的产品是否与参考产品图一致（包装颜色、形状、品牌标识）
2. competitor_residue（竞品残留）：是否残留竞品品牌标识、包装或文字
3. shot_structure_coverage（镜头结构覆盖）：是否保留了参考视频的关键构图元素（景别、机位、运镜）
4. hook_quality（Hook 质量）：开头是否具有视觉冲击力，能在前 1 秒吸引观众
5. subject_deformation（主体形变）：人脸、产品等主体是否存在 AI 生成的畸变、闪烁或不自然
6. cross_shot_continuity（跨镜连续性）：人物外观、场景、光线是否一致连贯
7. av_sync（音画同步）：画面节奏是否与音轨同步
8. compliance_risk（合规风险）：是否包含未备案文案、夸大功效、违禁词或侵权内容

评分规则：
- pass：该维度完全合格，有证据支持
- warning：基本合格但有潜在风险
- fail：明显不合格，需要修复
- unverified：无法从提供的素材中判断（如没有音频、没有参考帧等）
- 如果画面本身看起来漂亮，但没有完成该镜头的语义目的，shot_structure_coverage 必须判 warning 或 fail；不要把装饰性产品特写算作结构复刻通过。

返回严格 JSON 格式（不要额外文字、不要 Markdown 代码块）：
{
  "dimensions": [
    {
      "id": "product_consistency",
      "verdict": "pass|warning|fail|unverified",
      "score": 0.0-1.0,
      "evidence": ["具体观察到的证据"],
      "reason": "用户可理解的原因说明"
    }
  ]
}`;

  const user = `请评估以下 AI 生成的视频镜头（第 ${opts.shotIndex} 镜）。

**产品信息**：${product} — ${productName}
**允许出现的元素**：${allowedItems.join('、')}
**禁止出现的元素**：${prohibitedItems.join('、')}
**参考视频结构要求**：${referenceStructure}
**本镜语义目的**：${shotPurpose || '未提供（按传统镜头结构评估）'}
**本镜要复刻的源动作**：${sourceAction || '未提供'}
**入镜承接**：${transitionIn || '未提供'}
**出镜承接**：${transitionOut || '未提供'}

我已为你提供了三组图片：
- 图片组 1：AI 生成的视频镜头关键帧（评估对象）
- 图片组 2：参考视频的关键帧（对比结构）
- 图片组 3：产品图（对比产品一致性）

请逐一评估 8 个维度，返回 JSON。`;

  return { system, user };
}

export const SEMANTIC_QA_VERSION = 'v1.0.0';

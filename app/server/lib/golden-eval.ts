/**
 * 黄金集评测引擎 (S1) — 深模块接口：runGoldenEval / compareToBaseline / gateSnapshotFromScorecard。
 *
 * - 每条样本运行 >= runsRequired 次（默认 3），报告均值/方差/单次结果；
 * - 全部使用 synthetic scorer + fixture，不触发任何真实付费 provider 调用；
 * - 成本账本：估算成本来自样本元数据（source=estimate），实际成本一律 'unknown'，
 *   排队/生成时间在 synthetic 模式下为 'unknown'（没有真实队列/生成），durationMs 为实测耗时；
 * - 回归阻断：加权分下降 > 5% / hard gate 回归 / 样本缺失 / 评分缺失 → ok=false；
 *   unverified 样本显式列出（绝不静默），不自动阻断（v1 fixture 全部为 unverified）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  type ScoreDimensionId,
} from '../../shared/scorecard';
import { containsSecret, summarizeCosts, DEFAULT_PROMPT_VERSION, type CostEntry, type UsdAmount } from '../../shared/cost-ledger';
import {
  GOLDEN_SET_VERSION,
  loadGoldenSamples,
  type GoldenSample,
  type SampleRun,
  type SampleStats,
} from '../../shared/golden-sample';
import { syntheticScorecard, buildScorecard } from './scorecard-eval';
import type { Scorecard } from '../../shared/scorecard';

export const GOLDEN_EVAL_VERSION = 'v1.0.0';
export const WEIGHTED_DECLINE_THRESHOLD_PCT = 5;

export interface ManualScoreInput {
  sampleId: string;
  id: ScoreDimensionId;
  value: number;
  reviewer: string;
  comment?: string;
}

export interface GoldenEvalOptions {
  runsPerSample?: number;
  sampleIds?: string[];
  manualScores?: ManualScoreInput[];
  pipelineVersion?: string;
  /** prompt 模板版本；缺省取样本定义（S1 无模板时为 DEFAULT_PROMPT_VERSION） */
  promptVersion?: string;
  gitCommit?: string | 'unknown';
  uploadsRoot?: string;
  /**
   * 报告时间戳（ms）。缺省为 0 —— 评测结果默认完全确定性（可逐字节复现）；
   * 真实生成时间只出现在 MD/HTML 等人类可读格式与控制台，不进 JSON 评测结果。
   */
  timestamp?: number;
  /** 失败注入（测试/演示）：压低加权分 */
  degradeWeightedBy?: number;
  /** 失败注入：指定维度硬门禁失败 */
  failHardGate?: ScoreDimensionId;
  /** 失败注入：丢弃指定样本（模拟样本缺失） */
  dropSampleId?: string;
}

export interface GoldenSampleReport {
  id: string;
  name: string;
  product: string;
  synthetic: boolean;
  provenance: { source: string; note: string; lastUpdated: string };
  manualBaseline: string;
  productAssetUrl: string;
  referenceUrl: string;
  targetUrl?: string;
  allowedItems: string[];
  prohibitedItems: string[];
  provider: string;
  model: string;
  version: string;
  seed: number;
  runsRequired: number;
  /** prompt 模板版本（S1 无模板时为 DEFAULT_PROMPT_VERSION） */
  promptVersion: string;
  runs: SampleRun[];
  stats: SampleStats;
  warnings: string[];
  gateSummary: {
    hardGatesFailed: string[];
    hardGatesUnverified: string[];
    blockers: Array<{ code: string; detail: string }>;
    warnings: Array<{ code: string; detail: string }>;
  };
}

export interface GoldenReport {
  version: string;
  timestamp: number;
  generator: string;
  generatorVersion: string;
  note: string;
  pipelineVersion: string;
  /** prompt 模板版本（S1 无模板时为 DEFAULT_PROMPT_VERSION） */
  promptVersion: string;
  gitCommit: string | 'unknown';
  scorecardVersion: string;
  ledgerVersion: string;
  runsPerSample: number;
  samples: GoldenSampleReport[];
  stats: {
    sampleCount: number;
    runCount: number;
    measuredRuns: number;
    unverifiedRuns: number;
    failedRuns: number;
    overallMean: number | null;
    overallVariance: number | null;
  };
  costSummary: ReturnType<typeof summarizeCosts>;
  baseline?: BaselineComparison;
  warnings: string[];
}

export interface DimensionDecline {
  sampleId: string;
  dimension: ScoreDimensionId;
  label: string;
  baseline: number;
  current: number;
  deltaPct: number;
}

export interface BaselineComparison {
  compared: boolean;
  baselinePath: string;
  baselineVersion: string;
  baselineTimestamp: number;
  /** 总体加权分变化（current - baseline，占 baseline 的百分比）；无配对数据时为 null */
  weightedDeclinePct: number | null;
  /** 每个样本的加权均值变化 */
  sampleDeltas: Array<{
    sampleId: string;
    baselineMean: number | null;
    currentMean: number | null;
    deltaPct: number | null;
    status: 'ok' | 'declined' | 'unverified' | 'missing';
  }>;
  /** 逐维度下降超过阈值（paired runs 均值的差） */
  declines: DimensionDecline[];
  /** hard gate 回归：baseline 通过而 current 未通过（measured 对比） */
  hardGateRegressions: Array<{ sampleId: string; dimension: ScoreDimensionId; baseline: string; current: string }>;
  /** baseline 有而 current 缺失的样本 */
  missingSamples: string[];
  /** 存在运行但没有任何评分卡的样本 */
  scoreMissing: string[];
  /** 全部运行均为 unverified 的样本（显式列出，不静默） */
  unverifiedSamples: string[];
  /** 是否允许通过（false 时必须非零退出） */
  ok: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------- utils

export function currentGitCommit(): string | 'unknown' {
  try {
    const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out = (res.stdout || '').trim();
    return out || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 本地可探测的产物状态：/uploads 相对 uploadsRoot；其他本地路径相对 cwd；http 无法本地验证 */
export function artifactStatusFor(
  url: string | undefined | null,
  uploadsRoot: string
): SampleRun['artifactStatus'] {
  const trimmed = String(url || '').trim();
  if (!trimmed) return 'unverified';
  if (trimmed.startsWith('http')) return 'unverified';
  if (trimmed.startsWith('/uploads/')) {
    const candidate = path.join(uploadsRoot, trimmed.replace(/^\/uploads\//, ''));
    return fs.existsSync(candidate) ? 'present' : 'missing';
  }
  const local = path.join(process.cwd(), trimmed.replace(/^\/+/, ''));
  return fs.existsSync(local) ? 'present' : 'missing';
}

/** 由评分卡生成 gate 快照：hard gate failed → blocker；unverified → warning。 */
export function gateSnapshotFromScorecard(scorecard: Scorecard): SampleRun['gate'] {
  const blockers: Array<{ code: string; detail: string }> = [];
  const warnings: Array<{ code: string; detail: string }> = [];
  const blockerEvidence: Record<string, { code: string; source: string; detail: string }> = {};
  const warningEvidence: Record<string, { code: string; source: string; detail: string }> = {};
  for (const gate of scorecard.hardGates) {
    const entry = scorecard.dimensions.find((d) => d.id === gate.dimension);
    const evidenceText = entry?.evidence.map((e) => `${e.source}: ${e.detail}`).join('；') || '无证据';
    if (gate.status === 'failed') {
      blockers.push({ code: `hard_gate_failed:${gate.dimension}`, detail: `${gate.label} 未达硬门禁（实际 ${gate.actual}, 阈值 ${gate.min}）` });
      blockerEvidence[`hard_gate_failed:${gate.dimension}`] = {
        code: `hard_gate_failed:${gate.dimension}`,
        source: entry?.scorer || 'unknown',
        detail: evidenceText,
      };
    } else if (gate.status === 'unverified') {
      warnings.push({ code: `hard_gate_unverified:${gate.dimension}`, detail: `${gate.label} 未验证，不计为通过` });
      warningEvidence[`hard_gate_unverified:${gate.dimension}`] = {
        code: `hard_gate_unverified:${gate.dimension}`,
        source: entry?.scorer || 'unknown',
        detail: evidenceText,
      };
    }
  }
  const hasBlocker = blockers.length > 0;
  return {
    passed: !hasBlocker,
    status: hasBlocker ? 'needs_review' : 'unverified',
    blockers: blockers.map((b) => b.code),
    warnings: warnings.map((w) => w.code),
    blockerEvidence,
    warningEvidence,
    scorerVersion: scorecard.version,
  };
}

// ---------------------------------------------------------------- run

function runCostEntry(sample: GoldenSample, runId: string, runIndex: number, manualChoice: string | null, timestamp: number): CostEntry {
  const cost: CostEntry = {
    id: `cost-${sample.id}-run-${runIndex + 1}`,
    scope: 'run',
    runId,
    sampleId: sample.id,
    provider: sample.provider,
    model: sample.model,
    modelVersion: sample.version,
    seed: sample.seed + runIndex * 100,
    promptVersion: sample.promptVersion || DEFAULT_PROMPT_VERSION,
    queueMs: 'unknown',
    generationMs: 'unknown',
    retries: 0,
    failureReason: null,
    billing: [{ unit: 'videos', amount: 1 }],
    estimatedUsd: sample.cost.estimatedUsd as UsdAmount,
    actualUsd: 'unknown',
    currency: 'USD',
    source: 'estimate',
    manualChoice,
    scorecardVersion: sample.scorecardVersion,
    pipelineVersion: 'unknown',
    gitCommit: 'unknown',
    recordedAt: timestamp,
  };
  return cost;
}

function computeStats(runs: SampleRun[]): SampleStats {
  const weighted = runs.map((r) => r.scorecard.weighted.value);
  const mean = weighted.reduce((a, b) => a + b, 0) / Math.max(1, weighted.length);
  const variance = weighted.length > 1
    ? weighted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / weighted.length
    : 0;
  const perDimensionMean: Record<string, number> = {};
  for (const dim of runs[0]?.scorecard.dimensions ?? []) {
    const values = runs.map((r) => r.scorecard.dimensions.find((d) => d.id === dim.id)?.value ?? 0);
    perDimensionMean[dim.id] = values.reduce((a, b) => a + b, 0) / values.length;
  }
  return {
    runs: runs.length,
    mean,
    variance,
    min: Math.min(...weighted),
    max: Math.max(...weighted),
    perDimensionMean,
    measuredRuns: runs.filter((r) => r.status === 'measured').length,
    unverifiedRuns: runs.filter((r) => r.status === 'unverified').length,
    failedRuns: runs.filter((r) => r.status === 'failed').length,
  };
}

function buildSampleReport(
  sample: GoldenSample,
  runs: SampleRun[],
  pipelineVersion: string,
  gitCommit: string | 'unknown'
): GoldenSampleReport {
  const gateSummary: GoldenSampleReport['gateSummary'] = {
    hardGatesFailed: [],
    hardGatesUnverified: [],
    blockers: [],
    warnings: [],
  };
  const warnings: string[] = [];
  for (const run of runs) {
    for (const gate of run.scorecard.hardGates) {
      if (gate.status === 'failed' && !gateSummary.hardGatesFailed.includes(gate.dimension)) {
        gateSummary.hardGatesFailed.push(gate.dimension);
      }
      if (gate.status === 'unverified' && !gateSummary.hardGatesUnverified.includes(gate.dimension)) {
        gateSummary.hardGatesUnverified.push(gate.dimension);
      }
    }
    for (const b of run.gate?.blockers ?? []) {
      const ev = run.gate?.blockerEvidence?.[b];
      gateSummary.blockers.push({ code: b, detail: ev?.detail || b });
    }
    for (const w of run.gate?.warnings ?? []) {
      const ev = run.gate?.warningEvidence?.[w];
      gateSummary.warnings.push({ code: w, detail: ev?.detail || w });
    }
  }
  // 去重
  gateSummary.blockers = [...new Map(gateSummary.blockers.map((b) => [b.code, b])).values()];
  gateSummary.warnings = [...new Map(gateSummary.warnings.map((w) => [w.code, w])).values()];

  if (sample.synthetic) {
    warnings.push('synthetic/placeholder 样本：评分仅用于流程筛选与回归对比，不构成真实质量结论');
  }
  if (runs.length === 0) {
    warnings.push('样本没有任何运行记录');
  } else if (runs.every((r) => r.status === 'unverified')) {
    warnings.push('全部运行未验证（unverified）：不得把本样本评分当通过');
  }

  return {
    id: sample.id,
    name: sample.name,
    product: sample.product,
    synthetic: sample.synthetic,
    provenance: sample.provenance,
    manualBaseline: sample.manualBaseline,
    productAssetUrl: sample.productAssetUrl,
    referenceUrl: sample.referenceUrl,
    targetUrl: sample.targetUrl,
    allowedItems: sample.allowedItems,
    prohibitedItems: sample.prohibitedItems,
    provider: sample.provider,
    model: sample.model,
    version: sample.version,
    seed: sample.seed,
    runsRequired: sample.runsRequired,
    promptVersion: sample.promptVersion || DEFAULT_PROMPT_VERSION,
    runs,
    stats: computeStats(runs),
    warnings,
    gateSummary,
  };
}

/** 执行黄金集评测：确定性 synthetic scorer + 成本账本 + 统计。 */
export async function runGoldenEval(options: GoldenEvalOptions = {}): Promise<GoldenReport> {
  const runsPerSample = Math.max(1, options.runsPerSample ?? 3);
  const samples = loadGoldenSamples().filter(
    (s) => !options.sampleIds || options.sampleIds.includes(s.id)
  );
  const uploadsRoot = path.resolve(options.uploadsRoot ?? process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads'));
  const pipelineVersion = options.pipelineVersion ?? 'unknown';
  const promptVersion =
    options.promptVersion ?? samples[0]?.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const gitCommit = options.gitCommit ?? currentGitCommit();
  // 确定性：默认 timestamp=0（epoch 标记），真实生成时间只进人类可读格式（审查 P2-4）
  const timestamp = options.timestamp ?? 0;

  const reports: GoldenSampleReport[] = [];
  const allRuns: SampleRun[] = [];
  const warnings: string[] = [];

  for (const sample of samples) {
    if (options.dropSampleId && options.dropSampleId === sample.id) continue;
    const runs: SampleRun[] = [];
    for (let i = 0; i < runsPerSample; i++) {
      const runIndex = i;
      const seed = sample.seed + runIndex * 100;
      const artifactUrl = sample.targetUrl || sample.referenceUrl;
      const artifactStatus = artifactStatusFor(artifactUrl, uploadsRoot);

      const manual = options.manualScores
        ?.filter((m) => m.sampleId === sample.id)
        .map((m) => ({ id: m.id, value: m.value, reviewer: m.reviewer, comment: m.comment }));

      const scorecard = syntheticScorecard({
        sampleId: sample.id,
        runIndex,
        seed,
        artifactPresent: artifactStatus === 'present',
        degradeWeightedBy: options.degradeWeightedBy,
        failHardGate: options.failHardGate,
      });

      // 合并人工评分：重建 scorecard（manual 维度 → measured）
      const finalScorecard = manual && manual.length > 0
        ? buildScorecard({
            sampleId: sample.id,
            runId: `${sample.id}-run-${runIndex + 1}`,
            observations: scorecard.dimensions.map((d) => ({
              id: d.id,
              value: d.value,
              status: d.status,
              confidence: d.confidence,
              scorer: d.scorer,
              scorerVersion: d.scorerVersion,
              evidence: d.evidence,
            })),
            manual,
            generatedBy: 'golden-eval',
            // 确定性：人工评分提交时间不进入评测结果（审查 P2-4）
            submittedAt: timestamp,
          })
        : scorecard;

      // synthetic 评测无真实排队/生成耗时，durationMs 固定为 0（确定性；审查 P2-4）
      const durationMs = 0;
      // 人工选择结果（账本显式可查）：该样本存在人工评分时记录评审人引用
      const manualChoice =
        manual && manual.length > 0
          ? `manual-review:${[...new Set(manual.map((m) => m.reviewer))].join(',')}`
          : null;
      const cost = runCostEntry(sample, `${sample.id}-run-${runIndex + 1}`, runIndex, manualChoice, timestamp);
      // 排队/生成时间为真实 provider 语义；synthetic 模式没有真实队列/生成，保持 'unknown'
      cost.pipelineVersion = pipelineVersion;
      cost.gitCommit = gitCommit === 'unknown' ? 'unknown' : gitCommit;

      const run: SampleRun = {
        id: `${sample.id}-run-${runIndex + 1}`,
        sampleId: sample.id,
        runIndex: runIndex + 1,
        timestamp,
        provider: sample.provider,
        model: sample.model,
        version: sample.version,
        seed,
        artifactUrl,
        artifactStatus,
        scorecard: finalScorecard,
        cost,
        durationMs,
        promptVersion: sample.promptVersion || DEFAULT_PROMPT_VERSION,
        pipelineVersion,
        gitCommit,
        status: finalScorecard.weighted.measuredCount > 0 ? 'measured' : 'unverified',
        gate: gateSnapshotFromScorecard(finalScorecard),
      };
      runs.push(run);
      allRuns.push(run);
    }
    reports.push(buildSampleReport(sample, runs, pipelineVersion, gitCommit));
  }

  for (const report of reports) {
    for (const w of report.warnings) {
      if (!warnings.includes(w)) warnings.push(w);
    }
  }

  const weightedValues = allRuns.map((r) => r.scorecard.weighted.value);
  const overallMean = weightedValues.length > 0
    ? weightedValues.reduce((a, b) => a + b, 0) / weightedValues.length
    : null;
  const overallVariance = overallMean !== null && weightedValues.length > 1
    ? weightedValues.reduce((sum, v) => sum + (v - overallMean) ** 2, 0) / weightedValues.length
    : null;

  const costSummary = summarizeCosts(allRuns.map((r) => r.cost));

  const report: GoldenReport = {
    version: `${GOLDEN_SET_VERSION}+${GOLDEN_EVAL_VERSION}`,
    timestamp,
    generator: 'golden-eval',
    generatorVersion: GOLDEN_EVAL_VERSION,
    note:
      'v1 黄金集为 synthetic/placeholder fixture：全部评分为未验证（unverified）的筛选分，' +
      '不构成最终质量结论；真实素材由人工提供后，评分卡将切换到真实质检与人工盲测。',
    pipelineVersion,
    promptVersion,
    gitCommit,
    scorecardVersion: 'v1.0.0',
    ledgerVersion: 'v1.0.0',
    runsPerSample,
    samples: reports,
    stats: {
      sampleCount: reports.length,
      runCount: allRuns.length,
      measuredRuns: allRuns.filter((r) => r.status === 'measured').length,
      unverifiedRuns: allRuns.filter((r) => r.status === 'unverified').length,
      failedRuns: allRuns.filter((r) => r.status === 'failed').length,
      overallMean,
      overallVariance,
    },
    costSummary,
    warnings,
  };

  const secretHit = containsSecret(report);
  if (secretHit) {
    throw new Error(`黄金集报告包含疑似秘密（${secretHit}），已拒绝生成。`);
  }
  return report;
}

// ---------------------------------------------------------------- baseline comparison

function sampleMean(report: GoldenReport, sampleId: string): number | null {
  const sample = report.samples.find((s) => s.id === sampleId);
  if (!sample || sample.runs.length === 0) return null;
  return sample.stats.mean;
}

function sampleDimensionMean(report: GoldenReport, sampleId: string, dim: ScoreDimensionId): number | null {
  const sample = report.samples.find((s) => s.id === sampleId);
  if (!sample || sample.runs.length === 0) return null;
  const values = sample.runs.map((r) => r.scorecard.dimensions.find((d) => d.id === dim)?.value ?? null).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 读取样本全部运行的 hard gate 状态（不只看 runs[0]）。
 * 回归判定使用聚合规则：基线满足 = 全部运行满足；当前失败 = 任一运行失败。
 */
function hardGateStatus(report: GoldenReport, sampleId: string, dim: ScoreDimensionId): { statuses: string[]; values: (number | null)[]; min: number } {
  const sample = report.samples.find((s) => s.id === sampleId);
  const gates = sample?.runs
    .map((r) => r.scorecard.hardGates.find((g) => g.dimension === dim))
    .filter((g): g is NonNullable<typeof g> => Boolean(g));
  return {
    statuses: gates?.map((g) => g.status) ?? [],
    values: gates?.map((g) => g.actual) ?? [],
    min: gates?.[0]?.min ?? 0,
  };
}

/**
 * 与基线对比并给出阻断结论。
 * 阻断条件（ok=false）：零样本（零测试绿灯）、样本缺失、评分缺失、
 * 加权分下降 > 5%、hard gate 回归（baseline passed → current failed，measured 对比）。
 * unverified 样本显式列出（不静默），默认不阻断；strictUnverified=true 时阻断。
 */
export function compareToBaseline(
  current: GoldenReport,
  baseline: GoldenReport,
  options: { baselinePath?: string; strictUnverified?: boolean } = {}
): BaselineComparison {
  const reasons: string[] = [];
  const baselineSampleIds = new Set(baseline.samples.map((s) => s.id));
  const currentSampleIds = new Set(current.samples.map((s) => s.id));

  // 零测试绿灯保护
  if (current.samples.length === 0) {
    reasons.push('零测试绿灯：本次评测没有任何样本被评估，必须阻断');
  }
  if (baseline.samples.length === 0) {
    reasons.push('基线样本为空：无法对比，必须阻断');
  }

  // 样本缺失
  const missingSamples = [...baselineSampleIds].filter((id) => !currentSampleIds.has(id));
  if (missingSamples.length > 0) {
    reasons.push(`样本缺失：${missingSamples.join(', ')} 在本次评测中不存在，不得静默通过`);
  }

  // 评分缺失：按评分卡版本核对完整维度集合（14 维），而不是只检查数组非空（审查 P1-3）。
  // buildScorecard 会为缺失维度补 fallback，但外部构造/篡改的 JSON 可能缺维度，
  // 缺失即不得静默通过。
  const REQUIRED_DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as ScoreDimensionId[];
  const scoreMissing: string[] = [];
  for (const sample of current.samples) {
    if (sample.runs.length === 0) {
      scoreMissing.push(sample.id);
      continue;
    }
    for (const run of sample.runs) {
      const dims = new Set((run.scorecard?.dimensions ?? []).map((d) => d.id));
      const missing = REQUIRED_DIMENSIONS.filter((id) => !dims.has(id));
      if (missing.length > 0) {
        scoreMissing.push(`${sample.id}/${run.id}: 缺少维度 ${missing.join(', ')}`);
      }
    }
  }
  if (scoreMissing.length > 0) {
    reasons.push(`评分缺失：${scoreMissing.slice(0, 5).join('；')}${scoreMissing.length > 5 ? ` 等 ${scoreMissing.length} 处` : ''}，不得静默通过`);
  }

  // unverified 显式列出：任意运行或任意必需维度未验证，都不能被一次人工 measured 掩盖。
  // 每个样本只输出一项，保持报告紧凑，同时附带未验证 run/维度数量供定位。
  const unverifiedSamples = current.samples.flatMap((sample) => {
    const unverifiedRuns = sample.runs.filter(
      (run) =>
        run.status === 'unverified' ||
        run.scorecard.dimensions.some((dimension) => dimension.status === 'unverified')
    );
    if (unverifiedRuns.length === 0) return [];
    const unverifiedDimensionCount = unverifiedRuns.reduce(
      (count, run) =>
        count + run.scorecard.dimensions.filter((dimension) => dimension.status === 'unverified').length,
      0
    );
    return [
      `${sample.id}/${unverifiedRuns.length}runs:${unverifiedDimensionCount}dimensions`,
    ];
  });

  // 加权分下降（paired samples，均值对比）
  const sampleDeltas: BaselineComparison['sampleDeltas'] = [];
  let deltaSum = 0;
  let paired = 0;
  for (const id of baselineSampleIds) {
    const b = sampleMean(baseline, id);
    const c = sampleMean(current, id);
    if (b === null || c === null) {
      sampleDeltas.push({ sampleId: id, baselineMean: b, currentMean: c, deltaPct: null, status: 'missing' });
      continue;
    }
    const deltaPct = b === 0 ? 0 : ((c - b) / b) * 100;
    sampleDeltas.push({
      sampleId: id,
      baselineMean: b,
      currentMean: c,
      deltaPct,
      status: deltaPct < -WEIGHTED_DECLINE_THRESHOLD_PCT ? 'declined' : 'ok',
    });
    deltaSum += deltaPct;
    paired += 1;
  }
  const weightedDeclinePct = paired > 0 ? deltaSum / paired : null;
  if (weightedDeclinePct !== null && weightedDeclinePct < -WEIGHTED_DECLINE_THRESHOLD_PCT) {
    reasons.push(`加权质量下降 ${Math.abs(weightedDeclinePct).toFixed(2)}% > ${WEIGHTED_DECLINE_THRESHOLD_PCT}% 阈值，必须阻断`);
  }

  // 逐维度下降（paired）
  const declines: DimensionDecline[] = [];
  const dims = baseline.samples[0]?.runs[0]?.scorecard.dimensions.map((d) => d.id) ?? [];
  for (const sampleId of baselineSampleIds) {
    if (!currentSampleIds.has(sampleId)) continue;
    for (const dim of dims as ScoreDimensionId[]) {
      const b = sampleDimensionMean(baseline, sampleId, dim);
      const c = sampleDimensionMean(current, sampleId, dim);
      if (b === null || c === null) continue;
      const deltaPct = b === 0 ? 0 : ((c - b) / b) * 100;
      if (deltaPct < -WEIGHTED_DECLINE_THRESHOLD_PCT) {
        declines.push({ sampleId, dimension: dim, label: DIMENSION_LABELS[dim], baseline: b, current: c, deltaPct });
      }
    }
  }

  // hard gate 回归：聚合全部运行 —— 基线所有运行满足阈值（passed，或 unverified 但观测值达标），
  // 而当前任一运行跌破阈值（failed）→ 回归。不能只看 runs[0]（审查 P1-2：第二次/第三次
  // 运行的黑帧回归会被忽略）。
  const hardGateRegressions: BaselineComparison['hardGateRegressions'] = [];
  for (const sampleId of baselineSampleIds) {
    if (!currentSampleIds.has(sampleId)) continue;
    for (const gate of baseline.samples.find((s) => s.id === sampleId)?.runs[0]?.scorecard.hardGates ?? []) {
      const b = hardGateStatus(baseline, sampleId, gate.dimension);
      const c = hardGateStatus(current, sampleId, gate.dimension);
      const baselineAllSatisfied =
        b.statuses.length > 0 &&
        b.statuses.every((s, i) =>
          s === 'passed' || (s === 'unverified' && b.values[i] !== null && b.min > 0 && (b.values[i] as number) >= b.min)
        );
      const currentAnyFailed = c.statuses.some((s) => s === 'failed');
      if (baselineAllSatisfied && currentAnyFailed) {
        hardGateRegressions.push({
          sampleId,
          dimension: gate.dimension,
          baseline: b.statuses.join('/') || 'unverified',
          current: c.statuses.join('/') || 'unverified',
        });
      }
    }
  }
  if (hardGateRegressions.length > 0) {
    reasons.push(`hard gate 回归：${hardGateRegressions.map((r) => `${r.sampleId}/${r.dimension}`).join(', ')}`);
  }

  if (options.strictUnverified && unverifiedSamples.length > 0) {
    reasons.push(`strict 模式：以下样本未验证不得通过：${unverifiedSamples.join(', ')}`);
  }

  return {
    compared: true,
    baselinePath: options.baselinePath ?? '',
    baselineVersion: baseline.version,
    baselineTimestamp: baseline.timestamp,
    weightedDeclinePct,
    sampleDeltas,
    declines,
    hardGateRegressions,
    missingSamples,
    scoreMissing,
    unverifiedSamples,
    ok: reasons.length === 0,
    reasons,
  };
}

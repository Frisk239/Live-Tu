/**
 * 埋点与成本账本契约 v1 (S1)
 *
 * 记录 run/sample/shot 级别的：provider、model、model version、seed、
 * 排队时间、生成时间、重试次数、失败原因、计费单位（token/图片/视频）、
 * 估算成本与实际成本、人工选择结果、评分卡版本、pipeline/git 版本。
 *
 * 约束：
 * - 成本可追溯、可汇总；未知成本必须写成 'unknown'，绝不能写 0；
 * - 绝不允许记录 API Key、Cookie、Token 等秘密 —— 提供 containsSecret 守卫，
 *   评测与测试都会对序列化结果做扫描。
 */

export const LEDGER_VERSION = 'v1.0.0';

/**
 * S1 无托管 prompt 模板（roadmap 明示不新增 prompt 模板），
 * 但报告必须携带 prompt 版本维度 —— 记为显式占位，而非缺失字段。
 */
export const DEFAULT_PROMPT_VERSION = 'v1.0.0 (S1 无模板)';

export type BillingUnit = 'tokens' | 'images' | 'videos' | 'audio_seconds' | 'text_characters';

export interface BillingUsage {
  unit: BillingUnit;
  amount: number;
}

/** 金额：number=已确认，'unknown'=未知（不允许 0 冒充未知） */
export type UsdAmount = number | 'unknown';

export type CostScope = 'run' | 'sample' | 'shot';

export type FailureReason =
  | 'provider_error'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_artifact'
  | 'render_failed'
  | 'cancelled'
  | null;

export interface CostEntry {
  id: string;
  scope: CostScope;
  runId?: string;
  sampleId?: string;
  shotId?: string;
  provider: string;
  model: string;
  modelVersion: string;
  seed: number | null;
  /** prompt 模板版本；S1 无托管模板时为 DEFAULT_PROMPT_VERSION */
  promptVersion: string;
  /** 排队时间 ms；未知必须 'unknown' */
  queueMs: number | 'unknown';
  /** 生成时间 ms；未知必须 'unknown' */
  generationMs: number | 'unknown';
  retries: number;
  failureReason: FailureReason;
  billing: BillingUsage[];
  estimatedUsd: UsdAmount;
  actualUsd: UsdAmount;
  currency: 'USD';
  /** 成本来源：estimate=估算；provider_invoice=provider 账单；ledger=内部台账 */
  source: 'estimate' | 'provider_invoice' | 'ledger';
  /** 人工选择结果引用：'manual-review:<评审人>' 或 null（无人工选择） */
  manualChoice: string | null;
  scorecardVersion: string;
  pipelineVersion: string;
  gitCommit: string | 'unknown';
  recordedAt: number;
}

/** 汇总视图：可追溯、可聚合 */
export interface CostSummary {
  entries: number;
  estimatedUsd: number | 'unknown';
  actualUsd: number | 'unknown';
  byProvider: Array<{ provider: string; actualUsd: number | 'unknown'; estimatedUsd: number | 'unknown'; runs: number }>;
  byModel: Array<{ model: string; modelVersion: string; actualUsd: number | 'unknown'; runs: number }>;
  unknownCount: number;
}

export function summarizeCosts(entries: CostEntry[]): CostSummary {
  const byProvider = new Map<string, { provider: string; actualUsd: number | 'unknown'; estimatedUsd: number | 'unknown'; runs: number }>();
  const byModel = new Map<string, { model: string; modelVersion: string; actualUsd: number | 'unknown'; runs: number }>();
  let estimatedSum: number = 0;
  let actualSum: number = 0;
  let estimatedKnown = true;
  let actualKnown = true;
  let unknownCount = 0;

  for (const entry of entries) {
    if (entry.actualUsd === 'unknown') {
      actualKnown = false;
      unknownCount += 1;
    } else {
      actualSum += entry.actualUsd;
    }
    if (entry.estimatedUsd === 'unknown') {
      estimatedKnown = false;
    } else {
      estimatedSum += entry.estimatedUsd;
    }

    const p = byProvider.get(entry.provider) ?? {
      provider: entry.provider,
      actualUsd: 0 as number | 'unknown',
      estimatedUsd: 0 as number | 'unknown',
      runs: 0,
    };
    p.runs += 1;
    if (entry.actualUsd === 'unknown') p.actualUsd = 'unknown';
    else if (typeof p.actualUsd === 'number') p.actualUsd += entry.actualUsd;
    if (entry.estimatedUsd === 'unknown') p.estimatedUsd = 'unknown';
    else if (typeof p.estimatedUsd === 'number') p.estimatedUsd += entry.estimatedUsd;
    byProvider.set(entry.provider, p);

    const mKey = `${entry.model}/${entry.modelVersion}`;
    const m = byModel.get(mKey) ?? { model: entry.model, modelVersion: entry.modelVersion, actualUsd: 0 as number | 'unknown', runs: 0 };
    m.runs += 1;
    if (entry.actualUsd === 'unknown') m.actualUsd = 'unknown';
    else if (typeof m.actualUsd === 'number') m.actualUsd += entry.actualUsd;
    byModel.set(mKey, m);
  }

  return {
    entries: entries.length,
    estimatedUsd: estimatedKnown ? Math.round(estimatedSum * 1e6) / 1e6 : 'unknown',
    actualUsd: actualKnown ? Math.round(actualSum * 1e6) / 1e6 : 'unknown',
    byProvider: [...byProvider.values()].map((p) => ({
      ...p,
      actualUsd: typeof p.actualUsd === 'number' ? Math.round(p.actualUsd * 1e6) / 1e6 : p.actualUsd,
      estimatedUsd: typeof p.estimatedUsd === 'number' ? Math.round(p.estimatedUsd * 1e6) / 1e6 : p.estimatedUsd,
    })),
    byModel: [...byModel.values()].map((m) => ({
      ...m,
      actualUsd: typeof m.actualUsd === 'number' ? Math.round(m.actualUsd * 1e6) / 1e6 : m.actualUsd,
    })),
    unknownCount,
  };
}

/**
 * 秘密扫描守卫：检查任意（可序列化的）值是否包含疑似秘密。
 * 返回命中的模式名；无命中返回 null。
 * 评测管线在落账前必须对每条记录调用；序列化报告也会在测试中整体扫描。
 */
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'api_key_assignment', re: /\bapi[_-]?key\s*[=:]\s*['"]?[A-Za-z0-9]{16,}['"]?/i },
  { name: 'cookie_assignment', re: /\b(cookie|session[_-]?id|token)\s*[=:]\s*['"]?[A-Za-z0-9._-]{20,}['"]?/i },
];

export function containsSecret(value: unknown): string | null {
  const scan = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(v)) return name;
      }
      return null;
    }
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (/key|token|secret|password|cookie/i.test(key) && typeof obj[key] === 'string' && obj[key].length >= 8) {
          return `sensitive_field:${key}`;
        }
        const hit = scan(obj[key]);
        if (hit) return hit;
      }
      return null;
    }
    return null;
  };
  return scan(value);
}

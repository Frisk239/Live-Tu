/**
 * 生产成本账本 (S1) — 深模块接口：recordCostEntry / queryCostLedger。
 *
 * 生产流水线（step2 镜头提交/轮询/重试、step5 合成、发布决策）在此持续写入
 * 逐 run/shot 的成本与耗时记录，与黄金集评测共用 shared/cost-ledger 契约：
 * - 未知成本一律存 NULL（unknown），绝不写 0（可追溯、可汇总、不伪造）；
 * - 拒绝记录任何疑似秘密（API Key / Cookie / Token），命中即抛错（调用方需捕获）；
 * - 表结构由 db.ts migrations v23-v24 创建，SQLite CHECK 限定 scope 枚举并使用微美元精度。
 */
import { containsSecret, type BillingUnit, type CostEntry, type UsdAmount } from '../../shared/cost-ledger';
import { db } from './db';

export interface CostLedgerQuery {
  ownerId?: string;
  runId?: string;
  shotId?: string;
  sampleId?: string;
  scope?: CostEntry['scope'];
  limit?: number;
}

export interface ShotCostOutcome {
  ownerId: string;
  shotId: string;
  generationMs: number;
  retries: number;
  failureReason: CostEntry['failureReason'];
}

function usdToMicros(value: UsdAmount): number | null {
  if (value === 'unknown') return null; // 未知成本 → NULL，绝不写 0
  return Math.round(value * 1_000_000);
}

/**
 * 写一条成本账目。ownerId 必须来自服务端身份（绝不信任客户端）。
 * 未知成本存 NULL；含秘密的条目直接拒绝（返回 false，不落库）。
 */
export function recordCostEntry(entry: CostEntry, ownerId: string): boolean {
  const secretHit = containsSecret(entry);
  if (secretHit) {
    console.error(`[cost-ledger] 拒绝记录疑似秘密（${secretHit}），不落库`);
    return false;
  }

  const billing = new Map<BillingUnit, number>();
  for (const u of entry.billing ?? []) {
    billing.set(u.unit, (billing.get(u.unit) ?? 0) + u.amount);
  }

  try {
    db.prepare(
      `INSERT INTO cost_ledger (
         id, scope, run_id, sample_id, shot_id, provider, model, model_version, seed,
         prompt_version, queue_ms, generation_ms, retries, failure_reason,
         billing_tokens, billing_images, billing_videos, billing_audio_seconds,
         estimated_usd_micros, actual_usd_micros, currency, source, manual_choice,
         scorecard_version, pipeline_version, git_commit, recorded_at, owner_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id,
      entry.scope,
      entry.runId ?? null,
      entry.sampleId ?? null,
      entry.shotId ?? null,
      entry.provider,
      entry.model,
      entry.modelVersion,
      entry.seed,
      entry.promptVersion,
      entry.queueMs === 'unknown' ? null : entry.queueMs,
      entry.generationMs === 'unknown' ? null : entry.generationMs,
      entry.retries,
      entry.failureReason,
      billing.get('tokens') ?? null,
      billing.get('images') ?? null,
      billing.get('videos') ?? null,
      billing.get('audio_seconds') ?? null,
      usdToMicros(entry.estimatedUsd),
      usdToMicros(entry.actualUsd),
      entry.currency,
      entry.source,
      entry.manualChoice,
      entry.scorecardVersion,
      entry.pipelineVersion,
      entry.gitCommit === 'unknown' ? null : entry.gitCommit,
      entry.recordedAt,
      ownerId
    );
    return true;
  } catch (error: any) {
    // 账本写入失败不得破坏主流程（生产流水线容错）
    console.error(`[cost-ledger] 写入失败: ${String(error?.message || error).slice(0, 120)}`);
    return false;
  }
}

/** Provider 轮询结束后补全提交时尚未知的镜头结果；owner + shot 双重限定归属。 */
export function updateShotCostOutcome(outcome: ShotCostOutcome): boolean {
  const result = db.prepare(
    `UPDATE cost_ledger
        SET generation_ms = ?,
            retries = MAX(retries, ?),
            failure_reason = ?
      WHERE owner_id = ? AND shot_id = ? AND scope = 'shot'`
  ).run(
    Math.max(0, Math.round(outcome.generationMs)),
    Math.max(0, Math.round(outcome.retries)),
    outcome.failureReason,
    outcome.ownerId,
    outcome.shotId
  );
  return result.changes > 0;
}

function rowToCostEntry(row: any): CostEntry {
  return {
    id: row.id,
    scope: row.scope,
    runId: row.run_id ?? undefined,
    sampleId: row.sample_id ?? undefined,
    shotId: row.shot_id ?? undefined,
    provider: row.provider,
    model: row.model,
    modelVersion: row.model_version,
    seed: row.seed,
    promptVersion: row.prompt_version,
    queueMs: row.queue_ms === null ? 'unknown' : row.queue_ms,
    generationMs: row.generation_ms === null ? 'unknown' : row.generation_ms,
    retries: row.retries,
    failureReason: row.failure_reason ?? null,
    billing: [
      ...(row.billing_tokens !== null ? [{ unit: 'tokens' as const, amount: row.billing_tokens }] : []),
      ...(row.billing_images !== null ? [{ unit: 'images' as const, amount: row.billing_images }] : []),
      ...(row.billing_videos !== null ? [{ unit: 'videos' as const, amount: row.billing_videos }] : []),
      ...(row.billing_audio_seconds !== null ? [{ unit: 'audio_seconds' as const, amount: row.billing_audio_seconds }] : []),
    ],
    estimatedUsd: row.estimated_usd_micros === null ? 'unknown' : row.estimated_usd_micros / 1_000_000,
    actualUsd: row.actual_usd_micros === null ? 'unknown' : row.actual_usd_micros / 1_000_000,
    currency: row.currency,
    source: row.source,
    manualChoice: row.manual_choice ?? null,
    scorecardVersion: row.scorecard_version,
    pipelineVersion: row.pipeline_version,
    gitCommit: row.git_commit ?? 'unknown',
    recordedAt: row.recorded_at,
  };
}

/** 查询账本（可追溯）：按 run/shot/owner 过滤，按 recorded_at 倒序。 */
export function queryCostLedger(query: CostLedgerQuery = {}): CostEntry[] {
  const where: string[] = [];
  const params: Array<string | number | null> = [];
  if (query.ownerId) {
    where.push('owner_id = ?');
    params.push(query.ownerId);
  }
  if (query.runId) {
    where.push('run_id = ?');
    params.push(query.runId);
  }
  if (query.shotId) {
    where.push('shot_id = ?');
    params.push(query.shotId);
  }
  if (query.sampleId) {
    where.push('sample_id = ?');
    params.push(query.sampleId);
  }
  if (query.scope) {
    where.push('scope = ?');
    params.push(query.scope);
  }
  const sql = `SELECT * FROM cost_ledger
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY recorded_at DESC LIMIT ${Math.max(1, Math.min(1000, query.limit ?? 500))}`;
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToCostEntry);
}

/**
 * S1 生产成本账本测试（生产流水线埋点）：
 * - recordCostEntry 落库 → queryCostLedger 按 run/shot 可追溯查询；
 * - 未知成本存 NULL 而非 0（estimated/actual/queue/generation 均验证）；
 * - 含秘密的条目被拒绝，不落库；
 * - 账本可汇总（summarizeCosts 对查询结果聚合）。
 * 依赖 migrations v23-v24（cost_ledger 表与微美元精度）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-telemetry-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.PIPELINE_WORKER_DISABLED = 'true';

const { initDatabase } = await import('../lib/db');
initDatabase();

const { recordCostEntry, queryCostLedger, updateShotCostOutcome } = await import('../lib/telemetry');
const { summarizeCosts, DEFAULT_PROMPT_VERSION } = await import('../../shared/cost-ledger');
const { currentGitCommit } = await import('../lib/golden-eval');

before(() => {
  initDatabase();
});

test('成本账本：shot 级写入 → 按 shotId/runId 可追溯查询', () => {
  const ok = recordCostEntry(
    {
      id: 'cost-shot-test-1',
      scope: 'shot',
      runId: 'run-test-1',
      shotId: 'seedance-task-abc',
      provider: '星河中转/Seedance',
      model: 'doubao-seedance-2-0-fast',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: null,
      promptVersion: DEFAULT_PROMPT_VERSION,
      queueMs: 'unknown',
      generationMs: 'unknown',
      retries: 1,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 'unknown',
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: currentGitCommit(),
      recordedAt: 123456,
    },
    'test-admin'
  );
  assert.equal(ok, true);

  const byShot = queryCostLedger({ ownerId: 'test-admin', shotId: 'seedance-task-abc' });
  assert.equal(byShot.length, 1);
  assert.equal(byShot[0].scope, 'shot');
  assert.equal(byShot[0].shotId, 'seedance-task-abc');
  assert.equal(byShot[0].billing[0].unit, 'videos');
  assert.equal(byShot[0].billing[0].amount, 1);

  const byRun = queryCostLedger({ ownerId: 'test-admin', runId: 'run-test-1' });
  assert.equal(byRun.length, 1);
  assert.equal(byRun[0].retries, 1);
});

test('成本账本：未知成本必须存 NULL，绝不写 0', () => {
  recordCostEntry(
    {
      id: 'cost-shot-test-2',
      scope: 'shot',
      shotId: 'seedance-task-unknown',
      provider: '星河中转/Seedance',
      model: 'm',
      modelVersion: 'm',
      seed: null,
      promptVersion: DEFAULT_PROMPT_VERSION,
      queueMs: 'unknown',
      generationMs: 'unknown',
      retries: 0,
      failureReason: null,
      billing: [],
      estimatedUsd: 'unknown',
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 1,
    },
    'test-admin'
  );
  const row = queryCostLedger({ ownerId: 'test-admin', shotId: 'seedance-task-unknown' })[0];
  assert.equal(row.queueMs, 'unknown');
  assert.equal(row.generationMs, 'unknown');
  assert.equal(row.estimatedUsd, 'unknown');
  assert.equal(row.actualUsd, 'unknown');
});

test('成本账本：已知成本如实记录（micro-dollar 精度）', () => {
  recordCostEntry(
    {
      id: 'cost-shot-test-3',
      scope: 'shot',
      shotId: 'seedance-task-paid',
      provider: '星河中转/Seedance',
      model: 'm',
      modelVersion: 'm',
      seed: 42,
      promptVersion: DEFAULT_PROMPT_VERSION,
      queueMs: 1200,
      generationMs: 8900,
      retries: 2,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }, { unit: 'tokens', amount: 500 }],
      estimatedUsd: 0.15,
      actualUsd: 0.12,
      currency: 'USD',
      source: 'provider_invoice',
      manualChoice: 'manual-review:评审人A',
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'abc1234',
      recordedAt: 2,
    },
    'test-admin'
  );
  const row = queryCostLedger({ ownerId: 'test-admin', shotId: 'seedance-task-paid' })[0];
  assert.equal(row.queueMs, 1200);
  assert.equal(row.generationMs, 8900);
  assert.equal(row.retries, 2);
  assert.equal(row.estimatedUsd, 0.15);
  assert.equal(row.actualUsd, 0.12);
  assert.equal(row.manualChoice, 'manual-review:评审人A');
  assert.equal(row.billing.length, 2);
});

test('成本账本：亚分级 AI 成本不得被舍入为 0', () => {
  recordCostEntry(
    {
      id: 'cost-shot-sub-cent',
      scope: 'shot',
      shotId: 'seedance-task-sub-cent',
      provider: 'provider',
      model: 'm',
      modelVersion: 'm',
      seed: null,
      promptVersion: DEFAULT_PROMPT_VERSION,
      queueMs: 10,
      generationMs: 20,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'tokens', amount: 12 }],
      estimatedUsd: 0.004,
      actualUsd: 0.000123,
      currency: 'USD',
      source: 'provider_invoice',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'abc1234',
      recordedAt: 4,
    },
    'test-admin'
  );
  const row = queryCostLedger({ ownerId: 'test-admin', shotId: 'seedance-task-sub-cent' })[0];
  assert.equal(row.estimatedUsd, 0.004);
  assert.equal(row.actualUsd, 0.000123);
});

test('成本账本：正式镜头轮询结果可补全耗时、重试和失败原因', () => {
  recordCostEntry(
    {
      id: 'cost-shot-outcome',
      scope: 'shot',
      runId: 'run-outcome',
      shotId: 'provider-task-outcome',
      provider: 'provider',
      model: 'm',
      modelVersion: 'm',
      seed: null,
      promptVersion: DEFAULT_PROMPT_VERSION,
      queueMs: 'unknown',
      generationMs: 'unknown',
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 'unknown',
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'abc1234',
      recordedAt: 1000,
    },
    'test-admin'
  );
  assert.equal(
    updateShotCostOutcome({
      ownerId: 'test-admin',
      shotId: 'provider-task-outcome',
      generationMs: 2500,
      retries: 2,
      failureReason: 'provider_error',
    }),
    true
  );
  const row = queryCostLedger({ ownerId: 'test-admin', shotId: 'provider-task-outcome' })[0];
  assert.equal(row.generationMs, 2500);
  assert.equal(row.retries, 2);
  assert.equal(row.failureReason, 'provider_error');
});

test('成本账本：含秘密的条目被拒绝，不落库', () => {
  const ok = recordCostEntry(
    {
      id: 'cost-shot-secret',
      scope: 'shot',
      shotId: 'x',
      provider: 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890', // 模拟误写 API Key 到 provider
      model: 'm',
      modelVersion: 'm',
      seed: null,
      promptVersion: DEFAULT_PROMPT_VERSION,
      queueMs: 'unknown',
      generationMs: 'unknown',
      retries: 0,
      failureReason: null,
      billing: [],
      estimatedUsd: 'unknown',
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 3,
    },
    'test-admin'
  );
  assert.equal(ok, false, '含秘密的条目必须拒绝');
  const rows = queryCostLedger({ ownerId: 'test-admin', shotId: 'x' });
  assert.equal(rows.length, 0, '秘密条目不得落库');
});

test('成本账本：可汇总（summarizeCosts）', () => {
  const all = queryCostLedger({ ownerId: 'test-admin' });
  const summary = summarizeCosts(all);
  assert.equal(summary.entries, all.length);
  assert.equal(summary.unknownCount >= 2, true, '未知成本条目被计数');
  // 已知实际成本 0.12 存在，但含 unknown → 合计必须 unknown（可追溯、不伪造）
  assert.equal(summary.actualUsd, 'unknown');
});

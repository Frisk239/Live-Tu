/**
 * S1 黄金集确定性回归测试：
 * - 引擎确定性：同 seed 两次运行产出相同加权分；
 * - 评分卡完整性：14 维度、evidence/confidence/scorer、hard gate 语义；
 * - 成本账本：actualUsd/queueMs/generationMs 必须 'unknown'（不写 0），报告无秘密；
 * - 回归阻断：加权下降 >5%、hard gate 回归、样本缺失、零测试绿灯都必须 ok=false；
 * - 人工评分与自动评分并存；
 * - 未验证状态显式列出，绝不静默。
 * 全部 synthetic，不触发任何真实 provider 调用。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOLDEN_EVAL_VERSION,
  WEIGHTED_DECLINE_THRESHOLD_PCT,
  compareToBaseline,
  runGoldenEval,
  type GoldenReport,
} from '../lib/golden-eval';
import { containsSecret, summarizeCosts, DEFAULT_PROMPT_VERSION } from '../../shared/cost-ledger';
import { DIMENSION_WEIGHTS, HARD_GATE_RULES, assertScorecardIntegrity } from '../../shared/scorecard';
import { GOLDEN_SAMPLES, loadGoldenSamples } from '../../shared/golden-sample';

test('评分卡契约完整性：权重总和为 1，硬门禁维度都存在', () => {
  assert.doesNotThrow(() => assertScorecardIntegrity());
  const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重总和应为 1，实际 ${sum}`);
  assert.ok(HARD_GATE_RULES.length >= 5, '至少 5 项硬门禁');
});

test('黄金样本集：8 条 synthetic fixture + 3 条真实样本，显式标记，不冒充', () => {
  const samples = loadGoldenSamples();
  assert.equal(samples.length, 11);
  const synthetic = samples.filter((s) => s.synthetic);
  const real = samples.filter((s) => !s.synthetic);
  assert.equal(synthetic.length, 8, 'synthetic fixture 数量');
  assert.equal(real.length, 3, 'P3 真实黄金样例数量');
  for (const s of synthetic) {
    assert.equal(s.synthetic, true, `${s.id} 必须标记 synthetic`);
    assert.equal(s.provenance.source, 'synthetic-fixture');
    assert.equal(s.runsRequired >= 3, true, '运行次数 >= 3');
    assert.ok(s.productAssetUrl && s.referenceUrl && s.manualBaseline);
    assert.ok(s.allowedItems.length > 0 && s.prohibitedItems.length > 0);
    assert.equal(s.cost.actualUsd, 'unknown', 'synthetic 阶段实际成本必须 unknown，不得写 0');
  }
  for (const s of real) {
    assert.equal(s.synthetic, false, `${s.id} 必须标记非 synthetic`);
    assert.equal(s.provenance.source, 'real', `${s.id} provenance 必须为 real`);
    assert.ok(s.referenceSegment, `${s.id} 必须绑定参考视频段落（覆盖不同视频结构）`);
    assert.ok(s.productAssetUrl && s.manualBaseline);
  }
});

test('评测引擎：确定性（同 seed 两次运行加权分一致）', async () => {
  const a = await runGoldenEval({ runsPerSample: 3, gitCommit: 'test' });
  const b = await runGoldenEval({ runsPerSample: 3, gitCommit: 'test' });
  assert.equal(a.samples.length, 11);
  assert.equal(a.stats.runCount, 33);
  for (let i = 0; i < a.samples.length; i++) {
    assert.equal(a.samples[i].stats.mean, b.samples[i].stats.mean, '同 seed 运行必须完全一致');
    assert.equal(a.samples[i].stats.variance, b.samples[i].stats.variance);
  }
  assert.equal(a.stats.overallMean, b.stats.overallMean);
});

test('评测引擎：每次运行 >= 3 次，报告均值/方差/单次结果', async () => {
  const report = await runGoldenEval({ runsPerSample: 3, gitCommit: 'test' });
  for (const s of report.samples) {
    assert.ok(s.runs.length >= 3, `${s.id} 至少 3 次运行`);
    assert.ok(Number.isFinite(s.stats.mean));
    assert.ok(s.stats.variance >= 0);
    assert.ok(s.stats.min <= s.stats.max);
    // 单次结果在 run 里可见
    assert.ok(s.runs.every((r) => typeof r.scorecard.weighted.value === 'number'));
    // 逐维度均值存在
    assert.ok(Object.keys(s.stats.perDimensionMean).length >= 14, '14 个维度均值');
  }
});

test('评测引擎：每个分数携带 evidence/confidence/scorer/version；unverified 不冒充结论', async () => {
  const report = await runGoldenEval({ gitCommit: 'test' });
  for (const s of report.samples) {
    for (const r of s.runs) {
      assert.equal(r.status, 'unverified', 'synthetic 运行必须标记 unverified');
      assert.equal(r.scorecard.weighted.measuredCount, 0);
      assert.ok(r.scorecard.weighted.unverifiedCount > 0);
      for (const dim of r.scorecard.dimensions) {
        assert.ok(dim.evidence.length > 0, `${dim.id} 必须有 evidence`);
        assert.ok(dim.confidence >= 0 && dim.confidence <= 1);
        assert.ok(dim.scorer && dim.scorerVersion);
        assert.equal(dim.status, 'unverified');
      }
      // hard gate：未验证 → unverified，不得 passed
      for (const gate of r.scorecard.hardGates) {
        assert.equal(gate.status, 'unverified', 'synthetic 未验证硬门禁不得 passed');
      }
      assert.equal(r.scorecard.hardGatesPassed, false, '未验证不得硬门禁通过');
    }
  }
});

test('成本账本：可汇总、unknown 不写 0、无秘密', async () => {
  const report = await runGoldenEval({ gitCommit: 'test' });
  const costs = report.samples.flatMap((s) => s.runs.map((r) => r.cost));
  assert.equal(costs.length, 33);
  for (const c of costs) {
    assert.equal(c.actualUsd, 'unknown');
    assert.equal(c.queueMs, 'unknown');
    assert.equal(c.generationMs, 'unknown');
    assert.ok(c.estimatedUsd > 0, '估算成本存在（source=estimate）');
    assert.equal(c.currency, 'USD');
    assert.ok(c.provider && c.model && c.modelVersion);
    assert.ok(Number.isInteger(c.retries) && c.retries >= 0);
  }
  const summary = summarizeCosts(costs);
  assert.equal(summary.entries, 33);
  assert.equal(summary.actualUsd, 'unknown', '全部 unknown 时合计必须 unknown');
  assert.equal(summary.unknownCount, 33);
  // 序列化报告整体无秘密
  assert.equal(containsSecret(JSON.parse(JSON.stringify(report))), null, '报告不得包含任何秘密');
});

test('prompt 版本维度：报告/运行/成本账本均携带 promptVersion（S1 无模板记为显式占位）', async () => {
  const report = await runGoldenEval({ gitCommit: 'test' });
  assert.ok(report.promptVersion, '报告必须携带 promptVersion');
  for (const s of report.samples) {
    // synthetic 样本：S1 无模板显式占位；真实样本：携带自己的 promptVersion
    const expected = s.synthetic ? DEFAULT_PROMPT_VERSION : s.promptVersion;
    assert.equal(s.promptVersion, expected, '样本 promptVersion 与样本声明一致');
    for (const r of s.runs) {
      assert.equal(r.promptVersion, expected);
      assert.equal(r.cost.promptVersion, expected);
      assert.equal(r.cost.manualChoice, null, '无人工选择时 manualChoice 必须为 null');
    }
  }
});

test('人工选择结果：存在盲测评分时账本 manualChoice 显式记录评审人引用', async () => {
  const report = await runGoldenEval({
    gitCommit: 'test',
    manualScores: [
      { sampleId: 'skincare-hero-1', id: 'product_consistency', value: 0.95, reviewer: '评审人A' },
    ],
  });
  const runs1 = report.samples[0].runs;
  assert.equal(runs1.length, 3);
  for (const r of runs1) {
    assert.equal(r.cost.manualChoice, 'manual-review:评审人A', '账本必须显式可查人工选择结果');
  }
  // 未盲测样本 manualChoice 保持 null
  for (const r of report.samples[1].runs) {
    assert.equal(r.cost.manualChoice, null);
  }
});

test('gate 快照：unverified 硬门禁 → warning 且带证据；blocker 带 evidence', async () => {
  const normal = await runGoldenEval({ gitCommit: 'test' });
  const run0 = normal.samples[0].runs[0];
  assert.ok(run0.gate, '必须有 gate 快照');
  assert.ok(run0.gate!.warnings.some((w) => w.startsWith('hard_gate_unverified:')), '未验证硬门禁必须显式 warning');
  for (const w of run0.gate!.warnings) {
    assert.ok(run0.gate!.warningEvidence[w], `${w} 必须携带 evidence`);
  }

  const degraded = await runGoldenEval({ gitCommit: 'test', failHardGate: 'black_frame' });
  const runF = degraded.samples[0].runs[0];
  assert.ok(runF.gate!.blockers.some((b) => b.startsWith('hard_gate_failed:black_frame')), '注入的 hard gate 失败必须成为 blocker');
  for (const b of runF.gate!.blockers) {
    assert.ok(runF.gate!.blockerEvidence[b], `${b} 必须携带证据来源`);
    assert.ok(runF.gate!.blockerEvidence[b].detail.length > 0);
  }
});

test('回归阻断：加权下降 >5% → ok=false', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const degraded = await runGoldenEval({ gitCommit: 'test', degradeWeightedBy: 0.1 });
  const cmp = compareToBaseline(degraded, baseline);
  assert.equal(cmp.ok, false);
  assert.ok(cmp.weightedDeclinePct !== null && cmp.weightedDeclinePct < -WEIGHTED_DECLINE_THRESHOLD_PCT);
  assert.ok(cmp.reasons.some((r) => r.includes('加权质量下降')));
});

test('回归阻断：hard gate 回归 → ok=false（基线达标、当前跌破阈值）', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const degraded = await runGoldenEval({ gitCommit: 'test', failHardGate: 'black_frame' });
  const cmp = compareToBaseline(degraded, baseline);
  assert.equal(cmp.ok, false);
  assert.ok(cmp.hardGateRegressions.length >= 8, '全部样本 black_frame 回归');
  assert.ok(cmp.hardGateRegressions.every((r) => r.dimension === 'black_frame'));
  assert.ok(cmp.reasons.some((r) => r.includes('hard gate 回归')));
});

test('[审查 P1-2] hard gate 回归必须聚合全部运行：仅第二次运行注入失败也要阻断', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const current = await runGoldenEval({ gitCommit: 'test' });
  // 只篡改每个样本的第二次运行（runIndex=1）：black_frame 跌破阈值
  for (const s of current.samples) {
    const run = s.runs[1];
    const gate = run.scorecard.hardGates.find((g) => g.dimension === 'black_frame')!;
    gate.actual = 0.3;
    gate.status = 'failed';
    const dim = run.scorecard.dimensions.find((d) => d.id === 'black_frame')!;
    dim.value = 0.3;
    dim.status = 'unverified';
  }
  const cmp = compareToBaseline(current, baseline);
  assert.equal(cmp.ok, false, '第二次运行出现 hard gate 失败必须阻断（不能只看 runs[0]）');
  assert.ok(cmp.hardGateRegressions.length >= 8, '每个样本的 run2 回归都要被捕获');
});

test('[审查 P1-3] 单个评分维度缺失必须阻断：删除 duration 维度后不得静默通过', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const current = await runGoldenEval({ gitCommit: 'test' });
  for (const s of current.samples) {
    for (const r of s.runs) {
      r.scorecard.dimensions = r.scorecard.dimensions.filter((d) => d.id !== 'duration');
    }
  }
  const cmp = compareToBaseline(current, baseline);
  assert.equal(cmp.ok, false, '维度缺失不得静默通过');
  assert.ok(cmp.scoreMissing.length > 0, 'scoreMissing 必须非空');
  assert.ok(cmp.reasons.some((r) => r.includes('评分缺失')));
});

test('[审查 P2-4] 评测结果逐字节确定性：两次运行 JSON 完全一致（timestamp/durationMs 固定）', async () => {
  const a = await runGoldenEval({ gitCommit: 'test' });
  const b = await runGoldenEval({ gitCommit: 'test' });
  assert.equal(a.timestamp, 0, '默认确定性 epoch');
  const jsonA = JSON.stringify(a);
  const jsonB = JSON.stringify(b);
  assert.equal(jsonA, jsonB, '同 seed 两次运行的完整 JSON 必须逐字节一致');
  for (const s of a.samples) {
    for (const r of s.runs) {
      assert.equal(r.durationMs, 0, 'synthetic 评测无真实耗时，durationMs 固定为 0（确定性）');
      assert.equal(r.cost.recordedAt, 0);
    }
  }
});

test('回归阻断：样本缺失 → ok=false（不得静默通过）', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const dropped = await runGoldenEval({ gitCommit: 'test', dropSampleId: 'skincare-hero-1' });
  const cmp = compareToBaseline(dropped, baseline);
  assert.equal(cmp.ok, false);
  assert.deepEqual(cmp.missingSamples, ['skincare-hero-1']);
});

test('零测试绿灯：没有任何样本被评估 → ok=false', async () => {
  const empty: GoldenReport = {
    version: 'v1.0.0',
    timestamp: 0,
    generator: 'golden-eval',
    generatorVersion: GOLDEN_EVAL_VERSION,
    note: '',
    pipelineVersion: 'test',
    promptVersion: DEFAULT_PROMPT_VERSION,
    gitCommit: 'test',
    scorecardVersion: 'v1.0.0',
    ledgerVersion: 'v1.0.0',
    runsPerSample: 3,
    samples: [],
    stats: { sampleCount: 0, runCount: 0, measuredRuns: 0, unverifiedRuns: 0, failedRuns: 0, overallMean: null, overallVariance: null },
    costSummary: { entries: 0, estimatedUsd: 'unknown', actualUsd: 'unknown', byProvider: [], byModel: [], unknownCount: 0 },
    warnings: [],
  };
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const cmp = compareToBaseline(empty, baseline);
  assert.equal(cmp.ok, false, '零测试必须绿灯失败');
  assert.ok(cmp.reasons.some((r) => r.includes('零测试')));
  const cmp2 = compareToBaseline(baseline, empty);
  assert.equal(cmp2.ok, false, '基线为空也必须阻断');
});

test('回归阻断：评分缺失 → ok=false', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const broken = await runGoldenEval({ gitCommit: 'test' });
  // 人为删除一个样本的全部评分卡
  broken.samples[0].runs = broken.samples[0].runs.map((r) => ({ ...r, scorecard: { ...r.scorecard, dimensions: [] } }));
  const cmp = compareToBaseline(broken, baseline);
  assert.equal(cmp.ok, false);
  // 注意：数组 includes 是严格相等，scoreMissing 元素是「sample/run: 缺少维度」说明串，
  // 必须用 some+includes 做子串匹配
  assert.ok(cmp.scoreMissing.some((s) => s.includes('skincare-hero-1')), 'scoreMissing 必须包含该样本');
  assert.ok(cmp.reasons.some((r) => r.includes('评分缺失')));
});

test('未验证状态显式列出，不静默：正常对比列出全部 unverified 样本', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const current = await runGoldenEval({ gitCommit: 'test' });
  const cmp = compareToBaseline(current, baseline);
  assert.equal(cmp.ok, true, '未验证-对-未验证（值一致）不阻断');
  assert.equal(cmp.unverifiedSamples.length, 11, '未验证样本必须全部显式列出（8 synthetic + 3 真实）');
  // strict 模式阻断
  const strict = compareToBaseline(current, baseline, { strictUnverified: true });
  assert.equal(strict.ok, false);
});

test('strict-unverified：一次人工 measured 不得掩盖其他未验证运行和维度', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const partiallyMeasured = await runGoldenEval({
    gitCommit: 'test',
    manualScores: [
      { sampleId: 'skincare-hero-1', id: 'product_consistency', value: 0.95, reviewer: 'reviewer-a' },
    ],
  });
  const strict = compareToBaseline(partiallyMeasured, baseline, { strictUnverified: true });
  assert.equal(strict.ok, false);
  assert.ok(
    strict.unverifiedSamples.some((item) => item.startsWith('skincare-hero-1/')),
    'strict 模式必须列出仍含 unverified 运行或维度的样本'
  );
});

test('人工评分与自动评分并存：manual 维度 → measured 且参与加权', async () => {
  const report = await runGoldenEval({
    gitCommit: 'test',
    manualScores: [
      { sampleId: 'skincare-hero-1', id: 'product_consistency', value: 0.95, reviewer: '评审人A' },
      { sampleId: 'skincare-hero-1', id: 'competitor_residue', value: 1, reviewer: '评审人A' },
    ],
  });
  const run0 = report.samples[0].runs[0];
  const dim = run0.scorecard.dimensions.find((d) => d.id === 'product_consistency')!;
  assert.equal(dim.kind, 'manual');
  assert.equal(dim.status, 'measured');
  assert.equal(dim.value, 0.95);
  assert.equal(dim.scorer, 'manual-review:评审人A', '诚实标签：人工评分合并（非匿名盲测）');
  assert.ok(run0.scorecard.manualReview, 'manualReview 记录存在');
  assert.equal(run0.status, 'measured', '存在 measured 维度时运行状态为 measured');
  assert.ok(run0.scorecard.weighted.measuredCount >= 2);
  // 其他样本不受影响
  const run1 = report.samples[1].runs[0];
  assert.equal(run1.status, 'unverified');
});

test('基线对比：完全一致 → ok=true，0 下降', async () => {
  const baseline = await runGoldenEval({ gitCommit: 'test' });
  const current = await runGoldenEval({ gitCommit: 'test' });
  const cmp = compareToBaseline(current, baseline);
  assert.equal(cmp.ok, true);
  assert.equal(cmp.weightedDeclinePct, 0);
  assert.equal(cmp.missingSamples.length, 0);
  assert.equal(cmp.scoreMissing.length, 0);
  assert.equal(cmp.hardGateRegressions.length, 0);
  assert.equal(cmp.declines.length, 0);
});

test('样本级成本元数据随样本存在（provider/model/version/seed/估算成本/prompt 版本）', () => {
  const sample = GOLDEN_SAMPLES[0];
  assert.ok(sample.provider && sample.model && sample.version);
  assert.ok(Number.isInteger(sample.seed));
  assert.ok(sample.cost.estimatedUsd > 0);
  assert.equal(sample.cost.actualUsd, 'unknown');
  assert.equal(sample.cost.scope, 'sample');
  assert.equal(sample.promptVersion, DEFAULT_PROMPT_VERSION);
  assert.equal(sample.cost.promptVersion, DEFAULT_PROMPT_VERSION);
  assert.equal(sample.cost.manualChoice, null);
});

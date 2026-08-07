/**
 * S2 shared/workbench-contract.ts 单元测试（纯函数，无 DB）：
 * - 付费授权默认关闭、与自主模式解绑（证据 #1 契约层）；
 * - 成本估算微美元整数运算：逐镜汇总、unknown 不变成 0、亚分不丢精度（证据 #4）；
 * - 模型能力 schema 单一来源：未知模型拒绝假装支持；
 * - 阶段派生。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTONOMY_MODES,
  SAVE_STATES,
  createDefaultPaidAuthorization,
  createDefaultWorkbenchSettings,
  deriveWorkbenchPhase,
  estimateShotUsdMicros,
  getModelCapability,
  isAutonomyMode,
  isSaveState,
  matchShotCapability,
  microsToUsd,
  sumShotCostMicros,
  USD_MICROS,
} from '../../shared/workbench-contract';

test('付费授权默认关闭；默认设置不含任何确认点', () => {
  const paid = createDefaultPaidAuthorization();
  assert.equal(paid.enabled, false, '付费授权必须默认关闭');
  const settings = createDefaultWorkbenchSettings();
  assert.equal(settings.paidAuthorization.enabled, false);
  assert.equal(settings.confirms.deconstruction, false);
  assert.equal(settings.confirms.shot_plan, false);
  assert.equal(settings.confirms.batch_submit, false);
  assert.equal(settings.autonomyMode, 'managed');
});

test('三档自主模式枚举与守卫', () => {
  assert.deepEqual(AUTONOMY_MODES, ['managed', 'confirm_key_points', 'step_by_step']);
  assert.equal(isAutonomyMode('managed'), true);
  assert.equal(isAutonomyMode('confirm_key_points'), true);
  assert.equal(isAutonomyMode('step_by_step'), true);
  assert.equal(isAutonomyMode('auto_pay'), false);
  // 自主模式枚举里绝不能出现付费授权
  assert.ok(!AUTONOMY_MODES.includes('paid' as any));
});

test('SaveState 四态枚举与守卫', () => {
  assert.deepEqual(SAVE_STATES, ['saving', 'saved', 'dirty', 'offline_retry']);
  for (const s of SAVE_STATES) assert.equal(isSaveState(s), true);
  assert.equal(isSaveState('pending'), false);
});

test('成本估算：亚分成本不丢精度（微美元整数运算）', () => {
  // gpt-image-1-mini = $0.02 = 20000 micros（亚分精度必须保留）
  const mini = estimateShotUsdMicros('gpt-image-1-mini', 'image');
  assert.equal(mini, 20_000);
  assert.equal(microsToUsd(mini), 0.02);
  // seedance-2-0-fast = $0.10
  assert.equal(estimateShotUsdMicros('doubao-seedance-2-0-fast', 'video'), 100_000);
  // 未定价视频模型 → null（unknown），绝不返回 0
  const unpriced = estimateShotUsdMicros('unknown-video-model-xyz', 'video');
  assert.equal(unpriced, null);
  assert.equal(microsToUsd(unpriced), 'unknown');
  // 图像模型未定价 → 有兜底价（图像不产生 unknown，视频才可能 unknown）
  assert.ok((estimateShotUsdMicros('some-image', 'image') ?? 0) > 0);
});

test('逐镜汇总：整数求和精确；任一镜 unknown → 合计 unknown（不吞成 0）', () => {
  // $0.10 + $0.20 + $0.0075 → 307500 micros（亚分精度保留）
  const total = sumShotCostMicros([100_000, 200_000, 7_500]);
  assert.equal(total, 307_500);
  assert.equal(microsToUsd(total), 0.3075);
  // unknown 镜头 → 合计 unknown
  assert.equal(sumShotCostMicros([100_000, null]), null);
  assert.equal(microsToUsd(null), 'unknown');
  // 空列表 → 0（无镜头时合计 0 是合法的，因为不是「未知」）
  assert.equal(sumShotCostMicros([]), 0);
  assert.equal(microsToUsd(0), 0);
});

test('美元 <-> 微美元换算：1 USD = 1e6 micros', () => {
  assert.equal(USD_MICROS, 1_000_000);
  assert.equal(microsToUsd(1), 0.000001);
  assert.equal(microsToUsd(-5), 'unknown');
  assert.equal(microsToUsd(NaN), 'unknown');
});

test('模型能力 schema：单一来源，未知模型拒绝假装支持', () => {
  const fast = getModelCapability('Seedance 2.0 Fast');
  assert.equal(fast.category, 'video');
  assert.equal(fast.video?.maxDurationSec, 10);
  assert.ok(fast.video?.supportedAspectRatios.includes('9:16'));
  const unknown = getModelCapability('不存在的模型');
  assert.equal(unknown.video?.maxDurationSec, 0, '未知模型能力必须为空（拒绝假装支持）');
  const match = matchShotCapability('不存在的模型', {
    maxDurationSec: 5,
    supportedAspectRatios: ['9:16'],
  });
  assert.equal(match.supported, false);
  assert.ok(match.failed.some((f) => f.includes('拒绝假装支持')));
});

test('模型能力匹配：时长/比例/分辨率/参考输入逐项校验', () => {
  const ok = matchShotCapability('Seedance 2.0 Fast', {
    maxDurationSec: 5,
    minDurationSec: 3,
    supportedAspectRatios: ['9:16'],
    supportedResolutions: ['720p'],
    requiredReferenceInputs: 1,
  });
  assert.equal(ok.supported, true);
  assert.ok(ok.met.length >= 4);

  const tooLong = matchShotCapability('Seedance 2.0 Fast', { maxDurationSec: 30 });
  assert.equal(tooLong.supported, false);
  assert.ok(tooLong.failed.some((f) => f.includes('超过模型上限')));

  const tooManyRefs = matchShotCapability('Seedance 2.0 Fast', { requiredReferenceInputs: 5 });
  assert.equal(tooManyRefs.supported, false);
  assert.ok(tooManyRefs.failed.some((f) => f.includes('参考输入')));

  const notVideo = matchShotCapability('GPT Image 2', {});
  assert.equal(notVideo.supported, false);
  assert.ok(notVideo.failed.some((f) => f.includes('不是视频模型')));
});

test('阶段派生：setup → shot_plan → generating → completed', () => {
  assert.equal(
    deriveWorkbenchPhase({ runExists: false, runStatus: 'queued', hasShots: false, anyShotGenerating: false, allShotsCompleted: false, batchConfirmed: false }),
    'setup'
  );
  assert.equal(
    deriveWorkbenchPhase({ runExists: false, runStatus: 'queued', hasShots: true, anyShotGenerating: false, allShotsCompleted: false, batchConfirmed: false }),
    'shot_plan'
  );
  assert.equal(
    deriveWorkbenchPhase({ runExists: true, runStatus: 'running', hasShots: true, anyShotGenerating: true, allShotsCompleted: false, batchConfirmed: true }),
    'generating'
  );
  assert.equal(
    deriveWorkbenchPhase({ runExists: false, runStatus: 'queued', hasShots: true, anyShotGenerating: false, allShotsCompleted: true, batchConfirmed: true }),
    'completed'
  );
  assert.equal(
    deriveWorkbenchPhase({ runExists: true, runStatus: 'needs_review', hasShots: true, anyShotGenerating: false, allShotsCompleted: true, batchConfirmed: true }),
    'review'
  );
});

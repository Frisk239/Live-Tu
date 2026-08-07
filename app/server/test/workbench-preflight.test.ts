/**
 * S2 submission-preflight 单元测试：
 * - blocker → canSubmit=false（证据 #2）；
 * - 每个 blocker/warning 都有 evidence 与可执行修复动作（证据 #3）；
 * - 预估成本逐镜汇总正确、unknown 不变成 0、亚分成本不丢精度（证据 #4）；
 * - 无法验证余额如实显示、provider 不支持的策略禁用并解释（不展示假能力）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runSubmissionPreflight,
  type PreflightInput,
} from '../lib/submission-preflight';
import type { MaterialCheck, ShotPlanShot } from '../../shared/workbench-contract';

function makeShot(shotIndex: number, overrides: Partial<ShotPlanShot> = {}): ShotPlanShot {
  return {
    shotIndex,
    startTime: 0,
    endTime: 5,
    shotSize: 'close_up',
    cameraPosition: 'front',
    cameraMovement: 'push_in',
    lighting: 'soft',
    dialogue: [],
    soundEffects: [],
    mustKeep: ['包装'],
    mustReplace: ['竞品 logo'],
    generationMode: 'image_to_video',
    capabilityConstraints: {
      maxDurationSec: 5,
      minDurationSec: 3,
      supportedAspectRatios: ['9:16'],
      supportedResolutions: ['720p'],
      requiredReferenceInputs: 1,
    },
    status: 'pending',
    blockers: [],
    warnings: [],
    evidence: [],
    candidates: [{ id: `cand-${shotIndex}`, url: '/uploads/frame.png', prompt: 'frame', model: 'GPT Image 2', createdAt: 0 }],
    selectedCandidateId: `cand-${shotIndex}`,
    promptOverride: null,
    modelId: 'Seedance 2.0 Fast',
    ...overrides,
  };
}

const BASE_INPUT: PreflightInput = {
  ownerId: 'owner-one',
  shots: [makeShot(1), makeShot(2)],
  videoModelId: 'Seedance 2.0 Fast',
  modelConfigs: [
    { id: 'Seedance 2.0 Fast', modelCode: 'doubao-seedance-2-0-fast', category: 'video', enabled: 1 },
    { id: 'GPT Image 2', modelCode: 'gpt-image-2', category: 'image', enabled: 1 },
  ],
  candidateCountPerShot: 1,
  referenceInputCount: 1,
  hasVideoProviderConfig: true,
  providerName: 'fake',
  supportsPaidAcceleration: false,
};

const okProbe = async (url: string, kind: MaterialCheck['kind']): Promise<MaterialCheck> => ({
  kind,
  url,
  ok: true,
  status: 'verified',
  detail: '素材文件存在于本地',
});

test('全部就绪 → canSubmit=true，无 blocker', async () => {
  const result = await runSubmissionPreflight(BASE_INPUT, { materialProbe: okProbe });
  assert.equal(result.canSubmit, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.capability.length, 2);
  assert.ok(result.capability.every((c) => c.supported));
  assert.ok(result.wait.minSec > 0 && result.wait.maxSec >= result.wait.minSec);
  assert.ok(result.wait.evidenceSource.length > 0);
});

test('有 blocker → canSubmit=false（不得提交 provider）', async () => {
  const missing = await runSubmissionPreflight(
    {
      ...BASE_INPUT,
      shots: [makeShot(1, { candidates: [] })], // 缺首帧
    },
    { materialProbe: okProbe }
  );
  assert.equal(missing.canSubmit, false);
  assert.ok(missing.blockers.some((b) => b.code === 'first_frame_missing'));

  const providerGone = await runSubmissionPreflight(
    { ...BASE_INPUT, hasVideoProviderConfig: false },
    { materialProbe: okProbe }
  );
  assert.equal(providerGone.canSubmit, false);
  assert.ok(providerGone.blockers.some((b) => b.code === 'provider_unconfigured'));

  const missingAsset = await runSubmissionPreflight(
    { ...BASE_INPUT, referenceInputCount: 0 },
    { materialProbe: okProbe }
  );
  assert.equal(missingAsset.canSubmit, false);
  assert.ok(missingAsset.blockers.some((b) => b.code === 'missing_product_asset'));
});

test('每个 blocker 都有 evidence（source+detail）与可执行修复动作（证据 #3）', async () => {
  const result = await runSubmissionPreflight(
    {
      ...BASE_INPUT,
      hasVideoProviderConfig: false,
      shots: [makeShot(1, { candidates: [] }), makeShot(2)],
      referenceInputCount: 0,
    },
    {
      materialProbe: async (url, kind) =>
        url.includes('missing')
          ? { kind, url, ok: false, status: 'missing', detail: '素材文件缺失' }
          : okProbe(url, kind),
    }
  );
  assert.ok(result.blockers.length >= 3);
  for (const blocker of result.blockers) {
    assert.ok(blocker.evidence.source, `blocker ${blocker.code} 缺 evidence.source`);
    assert.ok(blocker.evidence.detail, `blocker ${blocker.code} 缺 evidence.detail`);
    assert.ok(blocker.fix && blocker.fix.label, `blocker ${blocker.code} 缺可执行修复动作`);
  }
  // warning 同样带 evidence
  for (const warning of result.warnings) {
    assert.ok(warning.evidence.source, `warning ${warning.code} 缺 evidence.source`);
    assert.ok(warning.evidence.detail, `warning ${warning.code} 缺 evidence.detail`);
  }
});

test('能力不匹配 → blocker 且带修复动作（switch_model）', async () => {
  const result = await runSubmissionPreflight(
    {
      ...BASE_INPUT,
      shots: [makeShot(1, { capabilityConstraints: { maxDurationSec: 30 } })],
    },
    { materialProbe: okProbe }
  );
  assert.equal(result.canSubmit, false);
  const cap = result.blockers.find((b) => b.code === 'capability_unsupported');
  assert.ok(cap, '应产生 capability_unsupported blocker');
  assert.equal(cap!.fix?.kind, 'switch_model');
  assert.ok(cap!.evidence.source === 'model-catalog');
});

test('预估成本：逐镜汇总精确、unknown 不变成 0、亚分成本不丢精度（证据 #4）', async () => {
  const result = await runSubmissionPreflight(
    {
      ...BASE_INPUT,
      shots: [makeShot(1), makeShot(2)],
      candidateCountPerShot: 1,
    },
    { materialProbe: okProbe }
  );
  // 每镜 = 视频 $0.10 + 1 候选图 $0.08 = $0.18 → 两镜 $0.36
  assert.equal(result.cost.perShot.length, 2);
  for (const shot of result.cost.perShot) {
    assert.equal(shot.estimatedUsdMicros, 180_000);
    assert.equal(shot.estimatedUsd, 0.18);
  }
  assert.equal(result.cost.totalEstimatedUsd, 0.36);
  // 实际成本未知必须显式 unknown，绝不写 0
  assert.equal(result.cost.actualUsd, 'unknown');
  assert.equal(result.cost.unknownActual, true);
  assert.ok(!result.warnings.some((w) => w.code === 'cost_unpriced'));
});

test('未定价模型 → 每镜与合计成本均为 unknown（绝不写 0）', async () => {
  const result = await runSubmissionPreflight(
    {
      ...BASE_INPUT,
      shots: [makeShot(1)],
      videoModelId: 'Unpriced Video Model',
      modelConfigs: [
        { id: 'Unpriced Video Model', modelCode: 'unpriced-code', category: 'video', enabled: 1 },
      ],
    },
    { materialProbe: okProbe }
  );
  assert.equal(result.cost.perShot[0].estimatedUsd, 'unknown');
  assert.equal(result.cost.totalEstimatedUsd, 'unknown');
  assert.ok(result.warnings.some((w) => w.code === 'cost_unpriced'));
  const unpricedWarning = result.warnings.find((w) => w.code === 'cost_unpriced')!;
  assert.ok(unpricedWarning.fix?.label.includes('切换'), '未定价应有可执行修复动作');
});

test('余额无法验证 → warning 且如实显示（不假装有余额）', async () => {
  const result = await runSubmissionPreflight(BASE_INPUT, { materialProbe: okProbe });
  assert.equal(result.balance.verified, false);
  assert.equal(result.balance.balanceUsd, 'unknown');
  assert.equal(result.balance.shortfallUsd, 'unknown');
  assert.ok(result.warnings.some((w) => w.code === 'balance_unverifiable'));
});

test('余额可验证但不足 → blocker insufficient_balance', async () => {
  const result = await runSubmissionPreflight(BASE_INPUT, {
    materialProbe: okProbe,
    balanceProvider: async () => ({
      verified: true,
      balanceUsd: 0.05,
      shortfallUsd: 0.31,
      provider: 'test-balance-api',
    }),
  });
  assert.equal(result.canSubmit, false);
  const bal = result.blockers.find((b) => b.code === 'insufficient_balance');
  assert.ok(bal);
  assert.equal(bal!.fix?.kind, 'wait');
});

test('等待区间：确定性且带证据来源', async () => {
  const result = await runSubmissionPreflight(BASE_INPUT, { materialProbe: okProbe });
  assert.equal(result.wait.minSec, 90);
  assert.equal(result.wait.maxSec, 240);
  assert.ok(result.wait.evidenceSource.includes('model-catalog'));
});

test('素材状态：本地存在 verified / 本地缺失 missing blocker / 远端 unverified warning', async () => {
  const result = await runSubmissionPreflight(
    {
      ...BASE_INPUT,
      shots: [
        makeShot(1),
        makeShot(2, { candidates: [{ id: 'c2', url: 'https://remote.example/frame.png', prompt: 'p', model: 'm', createdAt: 0 }] }),
        makeShot(3, { candidates: [{ id: 'c3', url: '/uploads/gone.png', prompt: 'p', model: 'm', createdAt: 0 }] }),
      ],
    },
    {
      materialProbe: async (url, kind) => {
        if (url.startsWith('http')) return { kind, url, ok: false, status: 'unverified', detail: '远端无法探测' };
        if (url.includes('gone')) return { kind, url, ok: false, status: 'missing', detail: '素材文件缺失' };
        return { kind, url, ok: true, status: 'verified', detail: '存在' };
      },
    }
  );
  assert.ok(result.materials.some((m) => m.status === 'verified'));
  assert.ok(result.materials.some((m) => m.status === 'unverified'));
  assert.ok(result.blockers.some((b) => b.code === 'material_missing'));
  assert.ok(result.warnings.some((w) => w.code === 'material_unverified'));
  assert.equal(result.canSubmit, false);
});

test('减成本策略：provider 不支持的必须禁用并解释（不展示假能力）', async () => {
  const result = await runSubmissionPreflight(BASE_INPUT, { materialProbe: okProbe });
  const freeQueue = result.strategies.find((s) => s.id === 'free_queue')!;
  assert.equal(freeQueue.supported, false);
  assert.ok(freeQueue.reason, '不支持的策略必须解释原因');
  const acceleration = result.strategies.find((s) => s.id === 'paid_acceleration')!;
  assert.equal(acceleration.supported, false, '星河中转不支持付费加速');
  assert.ok(acceleration.reason);
  const fewer = result.strategies.find((s) => s.id === 'fewer_candidates')!;
  assert.equal(fewer.supported, false, '单候选时无减少空间');
  const economy = result.strategies.find((s) => s.id === 'economy_model')!;
  assert.equal(economy.supported, false, '当前已是经济档');
  // 支持 paid acceleration 的 provider 会得到 enabled 的策略
  const withAccel = await runSubmissionPreflight(
    { ...BASE_INPUT, supportsPaidAcceleration: true },
    { materialProbe: okProbe }
  );
  assert.equal(withAccel.strategies.find((s) => s.id === 'paid_acceleration')!.supported, true);
});

test('素材比例与目标不一致 → warning material_aspect_mismatch', async () => {
  const result = await runSubmissionPreflight(
    { ...BASE_INPUT, targetAspectRatio: '9:16' },
    {
      materialProbe: async (url, kind) => ({
        kind,
        url,
        ok: true,
        status: 'verified' as const,
        detail: '存在',
        aspectRatio: '4:5',
      }),
    }
  );
  assert.equal(result.canSubmit, true);
  assert.ok(result.warnings.some((w) => w.code === 'material_aspect_mismatch'));
});

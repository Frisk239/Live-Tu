import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullVideoPlan, validateFullVideoPlan } from '../lib/full-video-plan';
import { buildSemanticStoryboard, validateSemanticStoryboard } from '../lib/semantic-storyboard';
import {
  runSequenceSemanticGate,
  runDeterministicStructureChecks,
} from '../lib/sequence-semantic-gate';
import { selectNarrativeSegments } from '../domain/reference-analysis/reference-analysis';

function segmentsFor(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    startSec: i * 2,
    endSec: i * 2 + 2,
  }));
}

/** 6/7/8 镜共用同一份动态契约：ReferenceAnalysis 选段 → storyboard → plan → gate */
for (const count of [6, 7, 8]) {
  test(`6-8 镜一致性（${count} 镜）：选段→故事板→计划→序列门禁数量与节拍链一致`, async () => {
    // ReferenceAnalysis 选段（确定性回退）
    const segments = selectNarrativeSegments({
      sceneChanges: [3, 6, 9, 12, 15, 18, 21, 24, 27],
      durationSec: 30,
      shotCount: count,
    });
    assert.equal(segments.length, count);

    // SemanticStoryboard：镜头数与选段数一致
    const storyboard = buildSemanticStoryboard({
      productName: 'BUV 小绿泥洁面膏',
      segments,
      analyzedKeyframeCount: count,
    });
    assert.equal(storyboard.shots.length, count, 'storyboard 镜头数必须与选段一致');
    assert.deepEqual(validateSemanticStoryboard(storyboard), []);

    // FullVideoPlan：镜头数与 storyboard 一致（同一份动态契约）
    const plan = createFullVideoPlan({
      productName: 'BUV 小绿泥洁面膏',
      targetDurationSec: 30,
      shotCount: count,
      safeReferenceSegments: segments.map(({ startSec, endSec }) => ({ startSec, endSec })),
      semanticStoryboard: storyboard,
    });
    assert.equal(plan.shots.length, count);
    assert.equal(plan.shotCount, count);
    assert.deepEqual(plan.beats, storyboard.shots.map((s) => s.beat), 'plan 节拍链与 storyboard 一致');
    assert.deepEqual(validateFullVideoPlan(plan), []);

    // 时轴完整：首镜从 0 开始，末镜结束于 target duration，单调递增
    assert.equal(plan.shots[0].targetStartMs, 0);
    assert.equal(plan.shots.at(-1)?.targetEndMs, 30_000);
    for (let i = 1; i < plan.shots.length; i++) {
      assert.ok(plan.shots[i].targetStartMs >= plan.shots[i - 1].targetEndMs, '时轴单调');
    }

    // 每镜都有完整叙事职责 + QA 合同
    for (const shot of plan.shots) {
      assert.ok(shot.semanticPurpose && shot.semanticPurpose.length >= 6, `第 ${shot.shotIndex} 镜叙事目的`);
      assert.ok(shot.preState && shot.postState, `第 ${shot.shotIndex} 镜状态契约`);
      // 首镜无 stateIn；末镜（cta）不再交付状态，其余每镜都有 stateOut
      if (shot.shotIndex > 1) assert.ok((shot.stateIn?.length ?? 0) > 0, `第 ${shot.shotIndex} 镜 stateIn`);
      if (shot.shotIndex < plan.shots.length) assert.ok((shot.stateOut?.length ?? 0) > 0, `第 ${shot.shotIndex} 镜 stateOut`);
      assert.ok(shot.transitionIn && shot.transitionOut, `第 ${shot.shotIndex} 镜承接契约`);
      assert.ok(shot.prompt.includes('Narrative purpose'), `第 ${shot.shotIndex} 镜生成 prompt`);
      assert.ok(shot.prompt.includes('State in:'), `第 ${shot.shotIndex} 镜 prompt 带状态契约`);
    }

    // SequenceGate：结构层全部通过；LLM 不可用时如实 unverified（不伪造 pass）
    const structure = runDeterministicStructureChecks(plan);
    const fails = structure.filter((c) => c.verdict === 'fail');
    assert.deepEqual(fails, [], `确定性结构检查不得 fail（${JSON.stringify(structure)}）`);
    const gate = await runSequenceSemanticGate({
      plan,
      finalVideoUrl: '/uploads/renders/missing.mp4',
      llm: async () => ({ success: false, error: 'model unavailable' }),
    });
    assert.equal(gate.status, 'unverified');
    assert.equal(gate.fallback, true);
  });
}

test('6/7/8 镜：beat 链形态正确（7 镜含 benefit，8 镜含 comparison）', () => {
  const beats7 = createFullVideoPlan({
    productName: 'BUV',
    targetDurationSec: 30,
    shotCount: 7,
  }).beats;
  assert.deepEqual(beats7, ['hook', 'problem', 'product_intro', 'demo', 'proof', 'benefit', 'cta']);

  const beats8 = createFullVideoPlan({
    productName: 'BUV',
    targetDurationSec: 30,
    shotCount: 8,
  }).beats;
  assert.deepEqual(beats8, ['hook', 'problem', 'product_intro', 'demo', 'proof', 'comparison', 'benefit', 'cta']);

  const beats6 = createFullVideoPlan({ productName: 'BUV', targetDurationSec: 30 }).beats;
  assert.deepEqual(beats6, ['hook', 'problem', 'product_intro', 'demo', 'proof', 'cta']);
});

test('6/7/8 镜：超出范围被钳制（9→8，2→6），不产生未计划镜头', () => {
  assert.equal(createFullVideoPlan({ productName: 'BUV', shotCount: 9 }).shots.length, 8);
  assert.equal(createFullVideoPlan({ productName: 'BUV', shotCount: 2 }).shots.length, 6);
  assert.equal(createFullVideoPlan({ productName: 'BUV', shotCount: 8 }).shots.length, 8);
  // 所有计划内镜头都有完整时轴位置（无「计划外但被生成」的镜头）
  for (const plan of [createFullVideoPlan({ productName: 'BUV', shotCount: 6 }), createFullVideoPlan({ productName: 'BUV', shotCount: 8 })]) {
    assert.equal(plan.shots.length, plan.shotCount);
    assert.equal(plan.shots.map((s) => s.shotIndex).join(','), Array.from({ length: plan.shotCount }, (_, i) => i + 1).join(','));
  }
});

test('计划数量以 storyboard 为准（同一份动态契约），不产生未计划镜头', () => {
  const storyboard = buildSemanticStoryboard({
    productName: 'BUV',
    segments: segmentsFor(6),
  });
  // 显式 shotCount=8 但 storyboard 为 6 镜 → storyboard 数量优先（动态契约单一来源）
  const plan = createFullVideoPlan({
    productName: 'BUV',
    targetDurationSec: 30,
    shotCount: 8,
    semanticStoryboard: storyboard,
  });
  assert.equal(plan.shots.length, 6);
  assert.equal(plan.shotCount, 6);
  assert.deepEqual(validateFullVideoPlan(plan), []);
});

test('计划外镜头被校验拒绝：往 plan 塞入未计划镜头 → 数量不一致 fail', () => {
  const plan = createFullVideoPlan({ productName: 'BUV', targetDurationSec: 30, shotCount: 6 });
  // 模拟「计划外镜头混入」（与 storyboard/契约不一致）
  (plan as any).shots.push({
    shotId: 'p4-shot-7',
    shotIndex: 7,
    beat: 'proof',
    targetStartMs: 25_000,
    targetEndMs: 30_000,
    referenceSegment: { startSec: 0, endSec: 5 },
    referencePolicy: 'semantic_replacement',
    visualIntent: '装饰性补充镜头',
    cameraDirection: 'push-in',
    continuityGroup: 'buv-green-tabletop-v1',
    productExposure: 'hero',
    semanticPurpose: '补充证据',
    preState: '',
    postState: '',
    transitionIn: '',
    transitionOut: '',
    prompt: 'unplanned shot',
    negativeConstraints: [],
  });
  plan.beats = plan.shots.map((s) => s.beat);
  const errors = validateFullVideoPlan(plan);
  assert.ok(
    errors.some((e) => /plan\.shotCount .* differs from shots/.test(e) || /outside 6-8/.test(e) || /timeline does not end/.test(e)),
    JSON.stringify(errors)
  );
});

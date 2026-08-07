import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullVideoPlan, type FullVideoPlan } from '../lib/full-video-plan';
import { buildSemanticStoryboard } from '../lib/semantic-storyboard';
import {
  runSequenceSemanticGate,
  runDeterministicStructureChecks,
  checkBeatOrder,
  buildSequenceFrameTargets,
  type SampledFrame,
} from '../lib/sequence-semantic-gate';

const segments = Array.from({ length: 6 }, (_, index) => ({
  startSec: index * 2,
  endSec: index * 2 + 2,
}));

function buildPlan(): FullVideoPlan {
  const storyboard = buildSemanticStoryboard({
    productName: 'BUV 小绿泥洁面膏',
    segments,
    analyzedKeyframeCount: 6,
  });
  return createFullVideoPlan({
    productName: 'BUV 小绿泥洁面膏',
    targetDurationSec: 30,
    safeReferenceSegments: segments,
    semanticStoryboard: storyboard,
  });
}

const fakeFrames: SampledFrame[] = Array.from({ length: 12 }, (_, index) => ({
  nodeIndex: index,
  timeSec: index * 5 + 2.5,
  url: `/uploads/.qa-tmp/fake/seq_${index}.jpg`,
}));

function passingLlm() {
  return async () => ({
    success: true,
    data: {
      checks: [
        { id: 'story_order', verdict: 'pass', score: 0.95, evidence: ['节拍顺序与计划一致'], reason: '顺序正确' },
        { id: 'causal_handoff', verdict: 'pass', score: 0.9, evidence: ['每镜承接可见'], reason: '承接连续' },
        { id: 'product_entry_timing', verdict: 'pass', score: 0.9, evidence: ['产品在第 3 镜进入'], reason: '时机正确' },
        { id: 'cta_closure', verdict: 'pass', score: 0.9, evidence: ['末镜产品收尾'], reason: '收束干净' },
        { id: 'no_filler_shot', verdict: 'pass', score: 0.9, evidence: ['无装饰镜头'], reason: '无 filler' },
        { id: 'visual_continuity', verdict: 'pass', score: 0.9, evidence: ['每个相邻剪辑点的产品、台面、光线和结果均连续'], reason: '视觉锚点连续' },
      ],
    },
  });
}

test('sequence gate: beat 顺序错乱（proof 出现在 demo 之前）被确定性判定 fail', async () => {
  const plan = buildPlan();
  plan.shots[3].beat = 'proof';
  plan.shots[4].beat = 'demo';
  plan.beats = plan.shots.map((shot) => shot.beat);

  const checks = runDeterministicStructureChecks(plan);
  const order = checks.find((check) => check.id === 'story_order');
  assert.equal(order?.verdict, 'fail');
  assert.match(order?.reason ?? '', /断裂|顺序/);
  assert.ok(order?.fix?.shotIndex, 'fail 时必须定位到应重做的镜头');

  const gate = await runSequenceSemanticGate({
    plan,
    finalVideoUrl: '/uploads/renders/final.mp4',
  });
  assert.equal(gate.status, 'fail');
  assert.equal(gate.fallback, true);
});

test('sequence gate: 断链（缺失 problem / 最后一镜不是 cta）被确定性判定 fail', async () => {
  const plan = buildPlan();
  plan.shots[1].beat = 'hook';
  plan.shots[5].beat = 'proof';
  plan.beats = plan.shots.map((shot) => shot.beat);

  const checks = runDeterministicStructureChecks(plan);
  assert.ok(
    checks.filter((check) => check.verdict === 'fail').length >= 1,
    '断链必须被结构层发现'
  );
  const gate = await runSequenceSemanticGate({ plan, finalVideoUrl: '/uploads/renders/final.mp4' });
  assert.equal(gate.status, 'fail');
});

test('sequence gate: 装饰性「产品展示」镜头被 no_filler_shot 拒绝并定位镜头', () => {
  const plan = buildPlan();
  plan.shots[2].semanticPurpose = '产品展示';
  const checks = runDeterministicStructureChecks(plan);
  const filler = checks.find((check) => check.id === 'no_filler_shot');
  assert.equal(filler?.verdict, 'fail');
  assert.equal(filler?.fix?.shotIndex, 3);
});

test('sequence gate: 缺少 transition 契约导致 causal_handoff fail', () => {
  const plan = buildPlan();
  plan.shots[3].transitionIn = '';
  plan.shots[3].transitionOut = '';
  const checks = runDeterministicStructureChecks(plan);
  const handoff = checks.find((check) => check.id === 'causal_handoff');
  assert.equal(handoff?.verdict, 'fail');
  assert.equal(handoff?.fix?.shotIndex, 4);
});

test('sequence gate: LLM 不可用且无帧时如实标记 unverified，不伪造通过', async () => {
  const plan = buildPlan();
  const gate = await runSequenceSemanticGate({
    plan,
    finalVideoUrl: '/uploads/renders/missing.mp4',
    llm: async () => ({ success: false, error: 'model unavailable' }),
  });
  assert.equal(gate.status, 'unverified');
  assert.equal(gate.fallback, true);
  assert.ok(gate.checks.some((check) => check.verdict === 'unverified'));
  // 未验证的检查不能给 pass 语义：unverified 项必须带「未获得画面证据」说明
  assert.ok(
    gate.checks.every((check) => check.verdict !== 'pass'),
    '无视觉验证时任何检查都不得判定为 pass'
  );
});

test('sequence gate: LLM 报告顺序错乱 → fail 并给出定位镜头的修复建议', async () => {
  const plan = buildPlan();
  const gate = await runSequenceSemanticGate({
    plan,
    finalVideoUrl: '/uploads/renders/final.mp4',
    extractFrames: async () => fakeFrames,
    llm: async () => ({
      success: true,
      data: {
        checks: [
          { id: 'story_order', verdict: 'fail', score: 0.2, evidence: ['成片第 2 镜已出现产品使用动作，早于产品进入'], reason: 'Demo 提前', failShotIndex: 2 },
          { id: 'causal_handoff', verdict: 'pass', score: 0.9, evidence: ['承接可见'], reason: 'ok' },
          { id: 'product_entry_timing', verdict: 'fail', score: 0.3, evidence: ['产品第 2 镜才出现'], reason: '进入过晚', failShotIndex: 3 },
          { id: 'cta_closure', verdict: 'pass', score: 0.9, evidence: ['收尾干净'], reason: 'ok' },
          { id: 'no_filler_shot', verdict: 'warning', score: 0.6, evidence: ['第 4 镜接近装饰'], reason: '接近 filler', failShotIndex: 4 },
        ],
      },
    }),
  });
  assert.equal(gate.status, 'fail');
  const order = gate.checks.find((check) => check.id === 'story_order');
  assert.equal(order?.fix?.shotIndex, 2);
  const filler = gate.checks.find((check) => check.id === 'no_filler_shot');
  assert.equal(filler?.fix?.shotIndex, 4);
});

test('sequence gate: 全部检查通过时判定 pass（视觉层验证）', async () => {
  const plan = buildPlan();
  const gate = await runSequenceSemanticGate({
    plan,
    finalVideoUrl: '/uploads/renders/final.mp4',
    extractFrames: async () => fakeFrames,
    llm: passingLlm(),
  });
  assert.equal(gate.status, 'pass');
  assert.equal(gate.fallback, false);
  assert.ok(gate.sampledFrames.length >= 6);
});

test('sequence gate: samples both sides of every edit and rejects a visually disconnected receiving shot', async () => {
  const plan = buildPlan();
  const targets = buildSequenceFrameTargets(plan);
  assert.equal(targets.length, 12, 'six shots require opening + two samples for each of five boundaries + closing');
  assert.deepEqual(
    targets.slice(1, 3).map((target) => [target.role, target.shotIndex, target.boundaryToShotIndex]),
    [['boundary_out', 1, 2], ['boundary_in', 2, 1]]
  );
  let observedTimes: number[] = [];
  const gate = await runSequenceSemanticGate({
    plan,
    finalVideoUrl: '/uploads/renders/final.mp4',
    extractFrames: async ({ timesSec }) => {
      observedTimes = timesSec;
      return timesSec.map((timeSec, index) => ({ nodeIndex: index, timeSec, url: `/uploads/.qa-tmp/fake/boundary_${index}.jpg` }));
    },
    llm: async () => ({
      success: true,
      data: {
        checks: [
          { id: 'story_order', verdict: 'pass', evidence: ['ok'], reason: 'ok' },
          { id: 'causal_handoff', verdict: 'pass', evidence: ['ok'], reason: 'ok' },
          { id: 'product_entry_timing', verdict: 'pass', evidence: ['ok'], reason: 'ok' },
          { id: 'cta_closure', verdict: 'pass', evidence: ['ok'], reason: 'ok' },
          { id: 'no_filler_shot', verdict: 'pass', evidence: ['ok'], reason: 'ok' },
          {
            id: 'visual_continuity',
            verdict: 'fail',
            evidence: ['boundary 3->4 jumps to a different tabletop and resets the visible result'],
            reason: 'the receiving demo shot does not inherit the product/set/result from shot 3',
            failShotIndex: 4,
          },
        ],
      },
    }),
  });
  assert.equal(observedTimes.length, 12);
  assert.equal(gate.status, 'fail');
  const continuity = gate.checks.find((check) => check.id === 'visual_continuity');
  assert.equal(continuity?.fix?.shotIndex, 4);
  assert.equal(gate.sampledFrames[1]?.role, 'boundary_out');
  assert.equal(gate.sampledFrames[2]?.role, 'boundary_in');
});

test('sequence gate: LLM 缺项/返回空时该维度 unverified，整体不伪造通过', async () => {
  const plan = buildPlan();
  const gate = await runSequenceSemanticGate({
    plan,
    finalVideoUrl: '/uploads/renders/final.mp4',
    extractFrames: async () => fakeFrames,
    llm: async () => ({
      success: true,
      data: { checks: [{ id: 'story_order', verdict: 'pass', score: 0.9, evidence: ['顺序一致'], reason: 'ok' }] },
    }),
  });
  assert.equal(gate.status, 'unverified');
  assert.ok(gate.checks.filter((check) => check.id !== 'story_order').every((check) => check.verdict === 'unverified'));
});

test('checkBeatOrder: 合法 6 镜链判定 pass', () => {
  const check = checkBeatOrder(['hook', 'problem', 'product_intro', 'demo', 'proof', 'cta']);
  assert.equal(check.verdict, 'pass');
  assert.equal(check.fix, null);
});

test('checkBeatOrder: 允许 benefit 作为可选中间节拍（7 镜）', () => {
  const check = checkBeatOrder(['hook', 'problem', 'product_intro', 'demo', 'proof', 'benefit', 'cta']);
  assert.equal(check.verdict, 'pass');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullVideoPlan, validateFullVideoPlan } from '../lib/full-video-plan';
import {
  VISUAL_CONTINUITY_PROMPT_MARKER,
  createVisualContinuityPackage,
  validateVisualContinuityPackage,
} from '../lib/visual-continuity';
import { composeFullVideoTimeline } from '../lib/full-video-timeline';

function buildPlan() {
  return createFullVideoPlan({
    productName: 'BUV cleanser',
    targetDurationSec: 30,
    shotCount: 6,
  });
}

test('quality plan binds a single visual bible and every boundary into provider prompts', () => {
  const plan = buildPlan();
  assert.ok(plan.visualContinuity);
  assert.equal(plan.visualContinuity?.seams.length, 5);
  assert.ok(plan.shots.every((shot) => shot.prompt.includes(VISUAL_CONTINUITY_PROMPT_MARKER)));
  const demoToProof = plan.visualContinuity?.seams.find((seam) => seam.fromShotIndex === 4 && seam.toShotIndex === 5);
  assert.ok(demoToProof);
  assert.match(demoToProof!.sharedAnchors.join(' '), /foam trail.*ceramic surface.*clean result/i);
  assert.match(demoToProof!.repairPrompt, /Repair only the boundary from shot 4 to shot 5/i);
  assert.deepEqual(validateFullVideoPlan(plan), []);
});

test('visual continuity validator rejects a missing or reordered boundary rather than allowing a generic same-table prompt', () => {
  const plan = buildPlan();
  const pkg = structuredClone(plan.visualContinuity!);
  pkg.seams.splice(2, 1);
  const errors = validateVisualContinuityPackage(pkg, plan.shots);
  assert.ok(errors.some((error) => /seam count|missing visual continuity seam/.test(error)), errors.join('; '));
});

test('timeline takes the declared seam strategy instead of inferring a decorative transition', () => {
  const plan = buildPlan();
  const timeline = composeFullVideoTimeline({
    plan,
    artifacts: plan.shots.map((shot) => ({
      shotIndex: shot.shotIndex,
      videoUrl: `https://example.test/${shot.shotIndex}.mp4`,
      durationSec: 5,
    })),
  });
  assert.equal(timeline.transitions[4].kind, 'dissolve', 'proof -> CTA is declared as a settling seam');
  assert.match(timeline.transitions[4].reason, /visual continuity seam 5->6/);
});

test('a package can be constructed independently from provider/runtime code', () => {
  const pkg = createVisualContinuityPackage({
    productName: 'demo product',
    shots: [
      { shotId: 's1', shotIndex: 1, beat: 'hook', continuityGroup: 'same-set', postState: 'problem is introduced' },
      { shotId: 's2', shotIndex: 2, beat: 'problem', continuityGroup: 'same-set', preState: 'problem is introduced', postState: 'solution enters' },
    ],
  });
  assert.deepEqual(validateVisualContinuityPackage(pkg, [
    { shotId: 's1', shotIndex: 1, beat: 'hook', continuityGroup: 'same-set' },
    { shotId: 's2', shotIndex: 2, beat: 'problem', continuityGroup: 'same-set' },
  ]), []);
});

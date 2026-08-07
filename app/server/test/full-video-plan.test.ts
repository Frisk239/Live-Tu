import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullVideoPlan, validateFullVideoPlan } from '../lib/full-video-plan';
import { buildSemanticStoryboard } from '../lib/semantic-storyboard';

test('full video plan covers six beats on a deterministic 30 second timeline', () => {
  const plan = createFullVideoPlan({
    productName: 'BUV 小绿泥洁面膏',
    targetDurationSec: 30,
    safeReferenceSegments: [
      { startSec: 53.5, endSec: 54.9 },
      { startSec: 60.95, endSec: 62.75 },
    ],
  });

  assert.equal(plan.shots.length, 6);
  assert.equal(plan.shots[0].beat, 'hook');
  assert.equal(plan.shots.at(-1)?.beat, 'cta');
  assert.equal(plan.shots.at(-1)?.targetEndMs, 30_000);
  assert.deepEqual(validateFullVideoPlan(plan), []);
  assert.equal(plan.safety.rawReferenceFramesToProvider, false);
  assert.equal(plan.shots[2].referencePolicy, 'semantic_replacement');
  assert.equal(plan.shots[5].continuityGroup, 'buv-green-tabletop-v1');
});

test('planner clamps demo duration into the supported 25-35 second range', () => {
  assert.equal(createFullVideoPlan({ productName: 'BUV', targetDurationSec: 5 }).targetDurationSec, 25);
  assert.equal(createFullVideoPlan({ productName: 'BUV', targetDurationSec: 60 }).targetDurationSec, 35);
});

test('full video planner carries semantic purpose and handoff into every provider shot', () => {
  const segments = Array.from({ length: 6 }, (_, index) => ({
    startSec: index * 2,
    endSec: index * 2 + 2,
  }));
  const semanticStoryboard = buildSemanticStoryboard({
    productName: 'BUV',
    segments,
    analyzedKeyframeCount: 6,
  });
  const plan = createFullVideoPlan({
    productName: 'BUV',
    targetDurationSec: 30,
    safeReferenceSegments: segments,
    semanticStoryboard,
  });

  assert.equal(plan.semanticStoryboard?.sourceIntent, semanticStoryboard.sourceIntent);
  assert.ok(plan.shots.every((shot) => shot.semanticPurpose && shot.transitionOut));
  assert.match(plan.shots[3].prompt, /Narrative purpose/);
  assert.match(plan.shots[3].prompt, /Every shot must advance the narrative purpose/);
  assert.deepEqual(validateFullVideoPlan(plan), []);
});

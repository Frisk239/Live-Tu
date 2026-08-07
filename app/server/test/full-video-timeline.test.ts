import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullVideoPlan } from '../lib/full-video-plan';
import {
  composeFullVideoTimeline,
  FullVideoTimelineError,
  validateFullVideoTimeline,
} from '../lib/full-video-timeline';

function plan() {
  return createFullVideoPlan({ productName: 'BUV', targetDurationSec: 30, shotCount: 6 });
}

function artifacts(durationSec = 5) {
  return Array.from({ length: 6 }, (_, index) => ({
    shotIndex: index + 1,
    videoUrl: `/uploads/renders/shot-${index + 1}.mp4`,
    durationSec,
  }));
}

test('timeline composer uses real clip durations and only applies purposeful transitions', () => {
  const timeline = composeFullVideoTimeline({ plan: plan(), artifacts: artifacts() });

  assert.equal(timeline.clips.length, 6);
  assert.equal(timeline.transitions.length, 5);
  assert.equal(timeline.clips[0].sourceDurationSec, 5);
  assert.equal(timeline.clips[0].renderDurationSec, 5);
  assert.deepEqual(
    timeline.transitions.map((transition) => transition.kind),
    ['match_cut', 'match_cut', 'match_cut', 'match_cut', 'dissolve']
  );
  assert.equal(timeline.expectedDurationSec, 29.82);
  assert.deepEqual(validateFullVideoTimeline(timeline), []);
});

test('timeline composer refuses unplanned, missing, or synthetic-duration clips', () => {
  assert.throws(
    () => composeFullVideoTimeline({ plan: plan(), artifacts: artifacts().slice(0, 5) }),
    (error: unknown) => error instanceof FullVideoTimelineError && /missing generated shots/.test(error.message)
  );

  assert.throws(
    () => composeFullVideoTimeline({
      plan: plan(),
      artifacts: [...artifacts(), { shotIndex: 7, videoUrl: '/uploads/renders/extra.mp4', durationSec: 5 }],
    }),
    (error: unknown) => error instanceof FullVideoTimelineError && /outside the approved plan/.test(error.message)
  );

  assert.throws(
    () => composeFullVideoTimeline({ plan: plan(), artifacts: artifacts(2) }),
    (error: unknown) => error instanceof FullVideoTimelineError && /cannot carry a meaningful narrative beat/.test(error.message)
  );
});

test('timeline composer does not hide a short clip behind frozen padding', () => {
  const tooShort = artifacts();
  tooShort[2] = { ...tooShort[2], durationSec: 3.8 };

  assert.throws(
    () => composeFullVideoTimeline({ plan: plan(), artifacts: tooShort }),
    (error: unknown) => error instanceof FullVideoTimelineError && /regenerate instead of padding/.test(error.message)
  );
});

test('timeline validator catches an altered render duration or broken boundary', () => {
  const timeline = composeFullVideoTimeline({ plan: plan(), artifacts: artifacts() });
  timeline.clips[2].renderDurationSec = 5.4;
  timeline.transitions[1].toShotId = 'wrong-shot';

  const errors = validateFullVideoTimeline(timeline);
  assert.ok(errors.some((error) => /pads beyond/.test(error)));
  assert.ok(errors.some((error) => /does not connect adjacent/.test(error)));
});

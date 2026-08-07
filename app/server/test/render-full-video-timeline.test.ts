import assert from 'node:assert/strict';
import test from 'node:test';
import { createFullVideoPlan } from '../lib/full-video-plan';
import { composeFullVideoTimeline } from '../lib/full-video-timeline';
import { buildMultiClipTimelineRenderPlan } from '../routes/render';

test('FFmpeg quality renderer follows the composed timeline instead of concatenating by clip count', () => {
  const plan = createFullVideoPlan({ productName: 'BUV', targetDurationSec: 30, shotCount: 6 });
  const timeline = composeFullVideoTimeline({
    plan,
    artifacts: plan.shots.map((shot) => ({
      shotIndex: shot.shotIndex,
      videoUrl: `/uploads/renders/shot-${shot.shotIndex}.mp4`,
      durationSec: 5,
    })),
  });

  const renderPlan = buildMultiClipTimelineRenderPlan(timeline, '1080:1920');
  assert.match(renderPlan.filters[0], /trim=start=0:end=5\.000/);
  assert.ok(
    renderPlan.filters.some((filter) => /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vt1\]/.test(filter)),
    renderPlan.filters.join('\n')
  );
  assert.ok(
    renderPlan.filters.some((filter) => /xfade=transition=fade:duration=0\.180/.test(filter)),
    renderPlan.filters.join('\n')
  );
  assert.equal(renderPlan.videoOutputLabel, '[vt5]');
  assert.equal(renderPlan.expectedDurationSec, 29.82);
});

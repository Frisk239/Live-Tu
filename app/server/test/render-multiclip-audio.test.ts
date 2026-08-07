import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMultiClipConcatPlan, buildSingleClipAudioMap } from '../routes/render';

test('multi-clip concat preserves each clip audio when no replacement BGM is supplied', () => {
  const plan = buildMultiClipConcatPlan(2, '1080:1920', true);

  assert.deepEqual(plan.scaleFilters, [
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v0]',
    '[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v1]',
  ]);
  assert.equal(plan.concatFilter, '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[vconcat][aconcat]');
  assert.equal(plan.audioOutputLabel, '[aconcat]');
});

test('multi-clip concat remains video-only when a clip audio stream is unavailable', () => {
  const plan = buildMultiClipConcatPlan(2, '1080:1920', false);

  assert.equal(plan.concatFilter, '[v0][v1]concat=n=2:v=1:a=0[vconcat]');
  assert.equal(plan.audioOutputLabel, null);
});

test('single-clip Step 5 export retains native audio unless replacement BGM is supplied', () => {
  assert.equal(buildSingleClipAudioMap(true), '-map 0:v:0 -map 0:a? -c:a aac');
  assert.equal(buildSingleClipAudioMap(false), '-map 0:v:0 -an');
});

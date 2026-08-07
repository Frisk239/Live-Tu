import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSemanticStoryboard,
  buildSemanticStoryboardPrompt,
  validateSemanticStoryboard,
} from '../lib/semantic-storyboard';

const segments = Array.from({ length: 6 }, (_, index) => ({
  startSec: index * 2,
  endSec: index * 2 + 2,
}));

test('semantic storyboard fallback gives every shot a narrative job and handoff', () => {
  const storyboard = buildSemanticStoryboard({
    productName: 'BUV 小绿泥洁面膏',
    segments,
    analyzedKeyframeCount: 6,
  });

  assert.equal(storyboard.evidence.source, 'deterministic_fallback');
  assert.equal(storyboard.shots.length, 6);
  assert.deepEqual(validateSemanticStoryboard(storyboard), []);
  assert.deepEqual(
    storyboard.shots.map((shot) => shot.beat),
    ['hook', 'problem', 'product_intro', 'demo', 'proof', 'cta']
  );
  for (const shot of storyboard.shots) {
    assert.ok(shot.purpose.length >= 8);
    assert.ok(shot.transitionOut.length > 0);
    assert.match(shot.replacementIntent, /替换/);
  }
});

test('LLM source meaning is normalized into product-safe intent instead of copied identity', () => {
  const storyboard = buildSemanticStoryboard({
    productName: 'BUV',
    segments,
    rawAnalysis: {
      sourceIntent: '先制造不洁反差，再用动作证明清洁结果',
      emotionalArc: '怀疑 -> 看到结果 -> 信任',
      visualGrammar: { transitionLanguage: '动作结果 match cut' },
      shotList: [
        { shotIndex: 1, purpose: '用强反差让观众停下来', description: '快速切入残留细节', shotType: 'macro', cameraMovement: 'push-in' },
        { shotIndex: 2, purpose: '把残留具体化', description: '焦点落在泡沫与表面纹理', shotType: 'detail', cameraMovement: 'rack focus' },
      ],
      narrativeBeats: [
        { beat: 'hook', startSec: 0, endSec: 2, intent: '强反差' },
        { beat: 'problem', startSec: 2, endSec: 4, intent: '具体痛点' },
      ],
    },
    analyzedKeyframeCount: 6,
  });

  assert.equal(storyboard.evidence.source, 'hybrid');
  assert.equal(storyboard.sourceIntent, '先制造不洁反差，再用动作证明清洁结果');
  assert.equal(storyboard.shots[0].purpose, '用强反差让观众停下来');
  assert.equal(storyboard.shots[0].visualTechnique, 'macro · push-in');
  assert.match(storyboard.shots[0].replacementIntent, /BUV/);
  assert.deepEqual(validateSemanticStoryboard(storyboard), []);
});

test('semantic prompt explicitly asks why each shot exists and what it hands off', () => {
  const prompt = buildSemanticStoryboardPrompt({ productName: 'BUV', segments });
  assert.match(prompt.system, /表达逻辑/);
  assert.match(prompt.system, /transitionOut/);
  assert.match(prompt.user, /不可省略的叙事目的/);
  assert.match(prompt.user, /0\.00-2\.00s/);
});

test('semantic prompt tells the source analyzer how to read an action-evidence strip', () => {
  const prompt = buildSemanticStoryboardPrompt({
    productName: 'BUV',
    segments,
    frameEvidence: 'early_mid_late_strip',
  });
  assert.match(prompt.system, /LEFT = early, CENTRE = middle, RIGHT = late/);
  assert.match(prompt.system, /do not describe only the centre panel/);
  assert.match(prompt.user, /左→中→右/);
});

test('decorative product-only purpose is rejected by the semantic gate', () => {
  const storyboard = buildSemanticStoryboard({ productName: 'BUV', segments });
  storyboard.shots[2].purpose = '产品展示';
  assert.ok(validateSemanticStoryboard(storyboard).some((error) => /decorative/.test(error)));
});

test('LLM narrativeBeats 覆盖不全/重复时不破坏必需节拍链（模板基底兜底）', () => {
  // LLM 把全片误标为同一个 beat（如 problem），时间戳不匹配任何镜头段
  const storyboard = buildSemanticStoryboard({
    productName: 'BUV',
    segments,
    rawAnalysis: {
      narrativeBeats: [{ beat: 'problem', startSec: 0, endSec: 100 }],
      shotList: [
        { shotIndex: 1, purpose: '用强反差开场让观众停下', description: '快速切入' },
        { shotIndex: 2, purpose: '把痛点具体化为可识别场景', description: '细节' },
      ],
    },
    analyzedKeyframeCount: 6,
  });

  assert.deepEqual(validateSemanticStoryboard(storyboard), []);
  assert.deepEqual(
    storyboard.shots.map((shot) => shot.beat),
    ['hook', 'problem', 'product_intro', 'demo', 'proof', 'cta'],
    '必需节拍链不能被 LLM 的重复 beat 破坏'
  );
});

test('LLM 只给出少量 beats 时其余镜头回退确定性模板', () => {
  const storyboard = buildSemanticStoryboard({
    productName: 'BUV',
    segments,
    rawAnalysis: {
      narrativeBeats: [
        { beat: 'hook', startSec: 0, endSec: 8 },
        { beat: 'cta', startSec: 9, endSec: 12 },
      ],
    },
    analyzedKeyframeCount: 6,
  });

  assert.deepEqual(validateSemanticStoryboard(storyboard), []);
  const beats = storyboard.shots.map((shot) => shot.beat);
  assert.equal(beats[0], 'hook');
  assert.equal(beats[5], 'cta');
  assert.deepEqual(
    beats.slice(1, 5).sort(),
    ['problem', 'product_intro', 'demo', 'proof'].sort(),
    '中间节拍由模板补全'
  );
});

test('P5：空对象/缺字段的 LLM 返回只能标为 fallback，不得记录为已深度理解', () => {
  const empty = buildSemanticStoryboard({ productName: 'BUV', segments, rawAnalysis: {} });
  assert.equal(empty.evidence.source, 'deterministic_fallback');
  assert.equal(empty.evidence.schemaValid, false);
  assert.equal(empty.evidence.rawAnalysisAvailable, false);
  assert.deepEqual(validateSemanticStoryboard(empty), []);

  const missingIntent = buildSemanticStoryboard({
    productName: 'BUV',
    segments,
    rawAnalysis: { narrativeBeats: [{ beat: 'hook', startSec: 0, endSec: 2 }] },
  });
  assert.equal(missingIntent.evidence.source, 'deterministic_fallback');
  assert.equal(missingIntent.evidence.schemaValid, false);
  assert.ok(missingIntent.evidence.validationErrors?.length > 0);
});

test('P5：中间镜 transitionIn/preState 可追溯到上一镜 postState/stateOut（不再是伪契约）', () => {
  const storyboard = buildSemanticStoryboard({ productName: 'BUV', segments });
  for (let i = 1; i < storyboard.shots.length; i++) {
    const cur = storyboard.shots[i];
    const prev = storyboard.shots[i - 1];
    assert.ok(
      cur.stateIn.every((token) => prev.stateOut.includes(token)),
      `第 ${cur.shotIndex} 镜 stateIn 必须由上一镜交付`
    );
    assert.ok(
      prev.stateOut.some((token) => cur.transitionIn.includes(token)),
      `第 ${cur.shotIndex} 镜 transitionIn 必须引用上一镜交付的状态（${prev.stateOut.join(', ')}）`
    );
    assert.ok(prev.stateOut.some((token) => cur.preState.includes(token)), `第 ${cur.shotIndex} 镜 preState 必须承接上一镜状态`);
  }
});

test('P5：模板文案不再覆盖承接字段——中间镜承接来自上一镜状态契约', () => {
  const storyboard = buildSemanticStoryboard({ productName: 'BUV', segments });
  for (const shot of storyboard.shots.slice(1)) {
    assert.ok(!shot.transitionIn.startsWith('承接第'), '旧模板文案（承接第 N 镜…）不得再出现');
    assert.match(shot.transitionIn, /上一镜/);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReferenceAnalysis,
  buildFallbackReferenceAnalysis,
  selectNarrativeSegments,
  normalizeReferenceAnalysis,
  narrativeValueForRole,
} from '../domain/reference-analysis/reference-analysis';

test('schema 校验：空对象/缺字段/无效分析 → invalid，不得记为已理解', () => {
  assert.deepEqual(validateReferenceAnalysis(null), { valid: false, errors: ['raw analysis is not an object'] });
  const empty = validateReferenceAnalysis({});
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((e) => /empty object/.test(e)));

  const noIntent = validateReferenceAnalysis({
    shotCandidates: [
      { startSec: 0, endSec: 3, beat: 'hook' },
      { startSec: 4, endSec: 7, beat: 'cta' },
    ],
  });
  assert.equal(noIntent.valid, false);
  assert.ok(noIntent.errors.some((e) => /globalIntent/.test(e)));

  const oneBeat = validateReferenceAnalysis({
    sourceIntent: '先制造反差再用动作证明',
    narrativeBeats: [{ beat: 'hook', startSec: 0, endSec: 3 }],
  });
  assert.equal(oneBeat.valid, false);
  assert.ok(oneBeat.errors.some((e) => /2 timed/.test(e)));

  const noBeat = validateReferenceAnalysis({
    sourceIntent: '先制造反差再用动作证明',
    narrativeBeats: [
      { startSec: 0, endSec: 3 },
      { startSec: 4, endSec: 7 },
    ],
  });
  assert.equal(noBeat.valid, false);
  assert.ok(noBeat.errors.some((e) => /narrative beat/.test(e)));
});

test('schema 校验：完整 raw 通过 → valid', () => {
  const check = validateReferenceAnalysis({
    sourceIntent: '先制造不洁反差，再用动作证明清洁结果',
    narrativeBeats: [
      { beat: 'hook', startSec: 0, endSec: 2 },
      { beat: 'problem', startSec: 2, endSec: 4 },
    ],
    shotCandidates: [{ startSec: 5, endSec: 8, beat: 'demo', narrativeValue: 0.8 }],
  });
  assert.equal(check.valid, true);
});

test('叙事价值：hook/proof/cta 高于普通展示，与时长无关', () => {
  assert.equal(narrativeValueForRole('hook'), 1.0);
  assert.equal(narrativeValueForRole('proof'), 0.9);
  assert.equal(narrativeValueForRole('cta'), 0.95);
  assert.ok(narrativeValueForRole('demo') > narrativeValueForRole('product_intro'));
  assert.equal(narrativeValueForRole('unknown-role'), 0.5);
});

test('选段：覆盖开头/中段/结尾三个叙事区，按叙事价值而非时长', () => {
  // 场景：开头 0-2s（短但 hook）、中段 10-20s（长展示）、结尾 58-60s（短 CTA）
  const segments = selectNarrativeSegments({
    sceneChanges: [2, 10, 20, 40, 58],
    durationSec: 60,
    shotCount: 6,
  });
  assert.equal(segments.length, 6);
  const zones = new Set(segments.map((s) => s.narrativeZone));
  assert.ok(zones.has('begin'), '必须覆盖开头');
  assert.ok(zones.has('middle'), '必须覆盖中段');
  assert.ok(zones.has('end'), '必须覆盖结尾');
  // 时间单调递增、不重叠
  for (let i = 1; i < segments.length; i++) {
    assert.ok(segments[i].startSec >= segments[i - 1].endSec, '选段不得重叠');
  }
  // 开头区必选 0-2s（唯一 begin 段，价值保底 0.8）
  assert.ok(segments.some((s) => s.startSec === 0 && s.endSec === 2));
});

test('选段：LLM 候选带叙事角色时价值覆盖确定性保底', () => {
  const segments = selectNarrativeSegments({
    sceneChanges: [3, 8, 30, 55],
    durationSec: 60,
    shotCount: 6,
    rawAnalysis: {
      sourceIntent: '反差开场，动作证明',
      shotCandidates: [
        { startSec: 0, endSec: 3, beat: 'hook', narrativeValue: 0.99 },
        { startSec: 55, endSec: 60, beat: 'cta', narrativeValue: 0.98 },
      ],
      narrativeBeats: [
        { beat: 'hook', startSec: 0, endSec: 3 },
        { beat: 'cta', startSec: 55, endSec: 60 },
      ],
    },
  });
  const hook = segments.find((s) => s.narrativeRole === 'hook');
  const cta = segments.find((s) => s.narrativeRole === 'cta');
  assert.ok(hook, 'hook 段被选中');
  assert.ok(cta, 'cta 段被选中');
  assert.equal(hook?.narrativeValue, 0.99);
  assert.equal(cta?.narrativeValue, 0.98);
});

test('选段：人工审核段覆盖（--segments）直接返回，不做叙事挑选', () => {
  const segments = selectNarrativeSegments({
    sceneChanges: [5, 15],
    durationSec: 60,
    shotCount: 3,
    overrides: [
      { startSec: 53.5, endSec: 54.9 },
      { startSec: 60.95, endSec: 62.75 },
    ],
  });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].startSec, 53.5);
  assert.ok(segments[0].narrativeZone === 'end');
});

test('确定性回退分析：明确标记 fallback，不假装已深度理解', () => {
  const fallback = buildFallbackReferenceAnalysis({
    productName: 'BUV',
    durationSec: 30,
    segments: [
      { startSec: 0, endSec: 5, narrativeZone: 'begin', narrativeValue: 0.8 },
      { startSec: 15, endSec: 20, narrativeZone: 'middle', narrativeValue: 0.5 },
      { startSec: 25, endSec: 30, narrativeZone: 'end', narrativeValue: 0.75 },
    ],
  });
  assert.equal(fallback.source, 'deterministic_fallback');
  assert.equal(fallback.schemaValid, false);
  assert.equal(fallback.rawAnalysisAvailable, false);
  assert.equal(fallback.confidence, 'low');
  assert.equal(fallback.timeline.length, 3);
});

test('归一化：raw 无效时返回确定性回退；有效时保留原始意图', () => {
  const invalid = normalizeReferenceAnalysis({
    productName: 'BUV',
    rawAnalysis: { someRandomField: true },
    durationSec: 30,
    segments: [{ startSec: 0, endSec: 5, narrativeZone: 'begin', narrativeValue: 0.8 }],
  });
  assert.equal(invalid.source, 'deterministic_fallback');
  assert.equal(invalid.schemaValid, false);

  const valid = normalizeReferenceAnalysis({
    productName: 'BUV',
    rawAnalysis: {
      sourceIntent: '先制造不洁反差，再用动作证明清洁结果',
      sellingMechanism: '因果动作+结果对比',
      narrativeBeats: [
        { beat: 'hook', startSec: 0, endSec: 2 },
        { beat: 'cta', startSec: 28, endSec: 30 },
      ],
    },
    durationSec: 30,
    segments: [{ startSec: 0, endSec: 5, narrativeZone: 'begin', narrativeValue: 0.8 }],
  });
  assert.equal(valid.source, 'llm_vision');
  assert.equal(valid.schemaValid, true);
  assert.equal(valid.globalIntent, '先制造不洁反差，再用动作证明清洁结果');
});

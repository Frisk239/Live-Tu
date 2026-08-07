import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTemplateContracts,
  validateNarrativeChain,
  resolveShotCount,
  BEAT_CHAINS,
} from '../domain/production-plan/narrative-shot-contract';

const segments6 = Array.from({ length: 6 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 }));
const segments7 = Array.from({ length: 7 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 }));
const segments8 = Array.from({ length: 8 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 }));

test('resolveShotCount：6-8 钳制，所有模块共用同一口径', () => {
  assert.equal(resolveShotCount(undefined), 6);
  assert.equal(resolveShotCount(6), 6);
  assert.equal(resolveShotCount(7), 7);
  assert.equal(resolveShotCount(8), 8);
  assert.equal(resolveShotCount(9), 8);
  assert.equal(resolveShotCount(2), 6);
});

test('6/7/8 镜节拍链：hook 开头、cta 收尾、中间因果递增', () => {
  assert.deepEqual(BEAT_CHAINS[6], ['hook', 'problem', 'product_intro', 'demo', 'proof', 'cta']);
  assert.deepEqual(BEAT_CHAINS[7], ['hook', 'problem', 'product_intro', 'demo', 'proof', 'benefit', 'cta']);
  assert.deepEqual(BEAT_CHAINS[8], ['hook', 'problem', 'product_intro', 'demo', 'proof', 'comparison', 'benefit', 'cta']);
  for (const count of [6, 7, 8]) {
    const contracts = buildTemplateContracts({ productName: 'BUV', segments: segmentsN(count) });
    assert.equal(contracts.length, count);
    assert.equal(contracts[0].beat, 'hook');
    assert.equal(contracts.at(-1)?.beat, 'cta');
    assert.deepEqual(validateNarrativeChain(contracts), []);
  }
});

function segmentsN(count: number): Array<{ startSec: number; endSec: number }> {
  return Array.from({ length: count }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 }));
}

test('状态链：下一镜 stateIn ⊆ 上一镜 stateOut（确定性承接）', () => {
  const contracts = buildTemplateContracts({ productName: 'BUV', segments: segments6 });
  // 篡改第 3 镜的 stateIn 为上一镜未交付的状态 → 链断裂
  const broken = contracts.map((c) => ({ ...c, stateIn: [...c.stateIn] }));
  broken[2] = { ...broken[2], stateIn: ['state_from_nowhere'] };
  const errors = validateNarrativeChain(broken);
  assert.ok(errors.some((e) => /requires state \[state_from_nowhere\] not produced by shot 2/.test(e)));

  // 首镜声明进入状态 → 断裂
  const firstBroken = contracts.map((c) => ({ ...c, stateIn: [...c.stateIn] }));
  firstBroken[0] = { ...firstBroken[0], stateIn: ['attention_held'] };
  assert.ok(validateNarrativeChain(firstBroken).some((e) => /first shot must not require incoming state/.test(e)));
});

test('状态链：preState/transitionIn 可追溯到上一镜 postState/stateOut', () => {
  const contracts = buildTemplateContracts({ productName: 'BUV', segments: segments6 });
  for (let i = 1; i < contracts.length; i++) {
    const cur = contracts[i];
    const prev = contracts[i - 1];
    // 文本层面：transitionIn/preState 必须引用上一镜交付的状态令牌或「承接上一镜」
    assert.match(cur.transitionIn, new RegExp(prev.stateOut.join('|').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `shot ${i + 1} transitionIn 未引用上一镜状态`);
    assert.ok(cur.preState.length > 0);
    // 令牌层面：stateIn 全部来自上一镜 stateOut
    assert.ok(cur.stateIn.every((token) => prev.stateOut.includes(token)), `shot ${i + 1} stateIn 超出上一镜交付`);
  }
});

test('契约完整性：每镜都有 purpose/preState/action/postState/transition/productRole', () => {
  const contracts = buildTemplateContracts({ productName: 'BUV', segments: segments7 });
  for (const c of contracts) {
    assert.ok(c.purpose.length >= 6, `shot ${c.shotIndex} purpose`);
    assert.ok(c.preState.length > 0 && c.postState.length > 0, `shot ${c.shotIndex} states`);
    assert.ok(c.action.length > 0, `shot ${c.shotIndex} action`);
    assert.ok(c.transitionIn.length > 0 && c.transitionOut.length > 0, `shot ${c.shotIndex} transitions`);
    assert.ok(['none', 'supporting', 'hero'].includes(c.productRole), `shot ${c.shotIndex} role`);
  }
});

test('装饰性 purpose / 缺字段被确定性拒绝（不是只查字段非空）', () => {
  const contracts = buildTemplateContracts({ productName: 'BUV', segments: segments6 });
  const decorative = contracts.map((c) => ({ ...c, purpose: '产品特写' }));
  assert.ok(validateNarrativeChain(decorative).some((e) => /decorative/.test(e)));

  const missing = contracts.map((c) => ({ ...c, postState: '' }));
  assert.ok(validateNarrativeChain(missing).some((e) => /no postState/.test(e)));

  const noIncoming = contracts.map((c) => ({ ...c, stateIn: [] }));
  assert.ok(validateNarrativeChain(noIncoming).some((e) => /no incoming state token/.test(e)));
});

test('兼容性：旧 plan（无状态令牌）不崩溃，仅按非空检查', () => {
  const legacy = [
    { shotIndex: 1, beat: 'hook' as const, purpose: '开场钩子', preState: '', action: '动作', postState: '', transitionIn: '', transitionOut: '', stateIn: undefined, stateOut: undefined },
    { shotIndex: 2, beat: 'problem' as const, purpose: '痛点具体化', preState: '', action: '动作', postState: '', transitionIn: '', transitionOut: '', stateIn: undefined, stateOut: undefined },
    { shotIndex: 3, beat: 'product_intro' as const, purpose: '产品进入', preState: '', action: '动作', postState: '', transitionIn: '', transitionOut: '', stateIn: undefined, stateOut: undefined },
    { shotIndex: 4, beat: 'demo' as const, purpose: '使用演示', preState: '', action: '动作', postState: '', transitionIn: '', transitionOut: '', stateIn: undefined, stateOut: undefined },
    { shotIndex: 5, beat: 'proof' as const, purpose: '结果证明', preState: '', action: '动作', postState: '', transitionIn: '', transitionOut: '', stateIn: undefined, stateOut: undefined },
    { shotIndex: 6, beat: 'cta' as const, purpose: '收尾转化', preState: '', action: '动作', postState: '', transitionIn: '', transitionOut: '', stateIn: undefined, stateOut: undefined },
  ];
  // 不抛异常；缺失文本字段被如实报告（旧 plan 需升级补齐状态契约）
  const errors = validateNarrativeChain(legacy);
  assert.ok(errors.some((e) => /no preState/.test(e)));
});

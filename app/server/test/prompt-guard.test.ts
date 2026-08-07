/**
 * Prompt guard 回归测试（P3 稳定性修复 · 计划 1）：
 * 源素材审计文本（字幕/标签/引号文字）绝不进入 provider prompt。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractContaminationWords,
  collectAuditTexts,
  lintProviderPrompt,
  PromptGuardError,
} from '../lib/prompt-guard.ts';

test('审计文本中的字幕/标签（如「粗大毛孔」）命中时拒绝 prompt', () => {
  const auditTexts = [
    '[53.47-54.97s] 绿色泥浆覆盖带有「粗大毛孔」文字的手臂',
    '字幕：深层清洁毛孔，黑头再见',
  ];
  const words = extractContaminationWords(auditTexts);
  assert.ok(words.includes('粗大毛孔'), '引号内标签文字必须被提取');
  assert.ok(words.some((w) => w.includes('黑头')), '字幕风格词必须被提取');

  // 含污染词的 prompt → 拒绝
  assert.throws(
    () => lintProviderPrompt({ prompt: 'apply green clay over a ceramic plate, 粗大毛孔 visible', auditTexts }),
    (error: any) => error instanceof PromptGuardError && error.code === 'prompt_contaminated_with_audit_text'
  );
  // 干净 prompt（安全代理动作）→ 通过
  lintProviderPrompt({
    prompt: 'green clay spreads from left to right across a plain white ceramic test plate; no text, no labels, no hands',
    auditTexts,
  });
});

test('没有审计文本时 lint 放行（旧 plan 兼容）', () => {
  lintProviderPrompt({ prompt: 'product close-up', auditTexts: [] });
});

test('collectAuditTexts 从 plan 与草稿提取审计字段', () => {
  const plan = {
    shots: [
      { shotIndex: 1, sourceActionAudit: '[0-3s] 字幕「秒变水光肌」' },
      { shotIndex: 2, sourceActionAudit: '手部涂抹，画面带「清洁毛孔」标签' },
    ],
  } as any;
  const draft = {
    shots: [{ shotIndex: 1, sourceActionAudit: 'audit from draft' }],
  };
  const texts = collectAuditTexts(plan, draft);
  assert.ok(texts.some((t) => t.includes('秒变水光肌')));
  assert.ok(texts.some((t) => t.includes('清洁毛孔')));
  assert.ok(texts.some((t) => t.includes('audit from draft')));
});

test('含「黑头」「粉刺」等源字幕的审计文本不会泄漏进安全代理 prompt', () => {
  const auditTexts = ['[55-56s] 字幕：「黑头粉刺一挤就没」'];
  const safeProxy = 'green clay covers shallow pits on a plain ceramic test plate; no text, no labels';
  // 安全代理不含污染词 → 通过
  lintProviderPrompt({ prompt: safeProxy, auditTexts });
  // 若安全代理误含字幕词 → 拒绝
  assert.throws(
    () => lintProviderPrompt({ prompt: `${safeProxy} 黑头粉刺一挤就没`, auditTexts }),
    (error: any) => error instanceof PromptGuardError
  );
});

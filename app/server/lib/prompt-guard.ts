/**
 * Prompt guard（P3 稳定性修复 · 计划 1）
 *
 * 源素材审计（sourceActionAudit / OCR 文本 / 原字幕 / 标签文字 / 时间戳）只允许
 * 用于审计与追溯，绝不进入图像或视频 provider prompt。本模块在付费调用前对
 * 最终 prompt 做确定性 lint：命中审计文本即显式失败（fail fast，不发起调用）。
 *
 * 规则：
 * 1. 从计划/草稿收集全部审计文本（sourceActionAudit、含引号文字的字段）；
 * 2. 提取其中的「污染词」：中文标签/字幕片段（2 字以上连续中文 + 引号内容）、
 *   数字标签、来源字幕风格短语；
 * 3. provider prompt 包含任一污染词 → PromptGuardError（生成前直接失败）。
 */
import type { FullVideoPlan } from './full-video-plan';

export class PromptGuardError extends Error {
  readonly code = 'prompt_contaminated_with_audit_text' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PromptGuardError';
  }
}

/** 常见字幕/标签风格污染词（源视频烧录字幕高频出现；命中即拒绝进入 prompt） */
const SUBTITLE_STYLE_PATTERNS: RegExp[] = [
  /粗大毛孔|黑头|粉刺|闭口|祛痘|清洁毛孔|深层清洁|控油|补水|美白|提亮/g,
  /第\s*\d+\s*步|步骤\d+|用法|成分|功效|秒变|立竿见影/g,
];

/** 引号包裹的疑似字幕/标签短语（中文 2-12 字） */
const QUOTED_TEXT_PATTERN = /["「『]([\u4e00-\u9fa5A-Za-z0-9]{2,12})["」』]/g;

export interface PromptGuardInput {
  prompt: string;
  /** 审计文本来源（sourceActionAudit / 含原视频文字的字段） */
  auditTexts: Array<string | null | undefined>;
  /** 附加禁止词（如选段 OCR 结果） */
  extraForbiddenWords?: string[];
}

/** 从审计文本中提取污染词（引号内容 + 字幕风格短语 + 长中文词） */
export function extractContaminationWords(
  auditTexts: Array<string | null | undefined>,
  extraForbiddenWords: string[] = []
): string[] {
  const words = new Set<string>();
  for (const audit of auditTexts) {
    if (!audit) continue;
    for (const match of audit.matchAll(QUOTED_TEXT_PATTERN)) {
      if (match[1]) words.add(match[1]);
    }
    for (const pattern of SUBTITLE_STYLE_PATTERNS) {
      for (const match of audit.matchAll(pattern)) {
        if (match[0]) words.add(match[0]);
      }
    }
    // 2 字以上连续中文（可能是标签/字幕片段）
    for (const match of audit.matchAll(/[\u4e00-\u9fa5]{2,8}/g)) {
      const word = match[0];
      // 只收录审计字段里「引号内」或紧邻时间戳的中文片段之外的候选——
      // 保守策略：仅收录引号内容与字幕风格词，避免误伤正常叙事文本
      if (QUOTED_TEXT_PATTERN.test(match.input)) continue;
    }
  }
  for (const word of extraForbiddenWords) {
    if (word && word.trim().length >= 2) words.add(word.trim());
  }
  return [...words];
}

/** 审计文本集合（从计划/草稿提取，供 lint 使用） */
export function collectAuditTexts(plan?: FullVideoPlan | null, draft?: any): string[] {
  const texts: string[] = [];
  for (const shot of plan?.shots ?? []) {
    if (shot.sourceActionAudit) texts.push(shot.sourceActionAudit);
    if ((shot as any)?.auditText) texts.push((shot as any).auditText);
  }
  if (draft) {
    for (const shot of Array.isArray(draft?.shots) ? draft.shots : []) {
      if (shot?.sourceActionAudit) texts.push(String(shot.sourceActionAudit));
      if (shot?.auditText) texts.push(String(shot.auditText));
    }
    if (typeof draft?.referenceStructure === 'string' && /字幕|OCR|文字/.test(draft.referenceStructure)) {
      texts.push(draft.referenceStructure);
    }
  }
  return texts;
}

/**
 * Prompt lint：provider prompt 含审计污染词 → PromptGuardError。
 * 无审计文本时 lint 通过（旧 plan 兼容：不因缺审计信息阻断）。
 */
export function lintProviderPrompt(input: PromptGuardInput): void {
  const contamination = extractContaminationWords(input.auditTexts, input.extraForbiddenWords);
  if (contamination.length === 0) return;
  const hits = contamination.filter((word) => input.prompt.includes(word));
  if (hits.length > 0) {
    throw new PromptGuardError(
      `provider prompt 包含源素材审计文本（${hits.join('、')}）：` +
        '源动作中的字幕/标签/引号文字不得进入生成指令。请改用 safeVisualProxy 作为动作来源'
    );
  }
}

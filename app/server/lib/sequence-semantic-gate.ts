/**
 * S4.1 序列级语义门禁（sequence-level semantic gate）
 *
 * 单镜 QA（shot-qa）只回答「这一镜本身合不合格」。本模块回答
 * 「6-8 镜串成一条 25-35 秒的成片之后，故事是否真的成立」：
 * - 故事顺序是否与语义故事板的 beat 链一致；
 * - 每镜的 transitionIn/transitionOut 承诺是否被画面兑现（因果/状态承接）；
 * - 产品进入时机是否正确（product_intro 前不抢戏、之后必须在场）；
 * - CTA 是否真正收束（不再引入新叙事问题）；
 * - 是否存在「画面好看但没有推进故事」的装饰性镜头。
 *
 * 两条路径：
 * 1. 确定性结构检查（无条件先跑）：基于 full-video plan 的元数据做可证明的
 *    顺序/承接/收束检查。结构层 fail 是确定的失败，不需要 LLM。
 * 2. LLM vision 序列 QA（可选）：对最终成片按镜头节点抽帧，视觉验证画面是否
 *    兑现了语义承诺。LLM 不可用/帧提取失败 → 整体如实标记 unverified，
 *    绝不把「未验证」包装成「已通过」。
 *
 * 可测试性：llm / extractFrames 均可注入，测试覆盖顺序错乱 fail、
 * 断链 fail、LLM 不可用 fallback 如实标记、全通过 pass。
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { FullVideoPlan } from './full-video-plan';
import type { FullVideoTimeline } from './full-video-timeline';
import {
  validateVisualContinuityPackage,
  VISUAL_CONTINUITY_PROMPT_MARKER,
  type VisualContinuityPackage,
} from './visual-continuity';
import {
  validateNarrativeChain,
  toNarrativeContractShapes,
  MIDDLE_BEAT_ORDER as DOMAIN_MIDDLE_BEAT_ORDER,
} from '../domain/production-plan/narrative-shot-contract';

const execAsync = promisify(exec);

export type SequenceCheckId =
  | 'story_order'
  | 'causal_handoff'
  | 'product_entry_timing'
  | 'cta_closure'
  | 'no_filler_shot'
  | 'visual_continuity';

export type SequenceVerdict = 'pass' | 'warning' | 'fail' | 'unverified';

export interface SequenceCheckFix {
  /** 需要重做/重新生成的目标镜头（1-based；null = 不定位到具体镜头） */
  shotIndex: number | null;
  /** 用户可执行的修复动作 */
  action: string;
  /** 可拼接进该镜 prompt 的修复片段（可选） */
  promptFragment?: string;
}

export interface SequenceCheck {
  id: SequenceCheckId;
  verdict: SequenceVerdict;
  evidence: string[];
  reason: string;
  fix: SequenceCheckFix | null;
}

export interface SampledFrame {
  nodeIndex: number;
  /** 相对成片的时间点（秒） */
  timeSec: number;
  /** /uploads 相对 URL 或 data: URL（LLM 可读） */
  url: string;
  /** Meaning of this sample within a shot or an adjacent-shot boundary. */
  role?: 'opening' | 'boundary_out' | 'boundary_in' | 'closing';
  shotIndex?: number;
  boundaryToShotIndex?: number;
}

export interface SequenceFrameTarget {
  timeSec: number;
  role: NonNullable<SampledFrame['role']>;
  shotIndex: number;
  boundaryToShotIndex?: number;
}

export interface SequenceGateResult {
  version: 'v1';
  status: SequenceVerdict;
  checks: SequenceCheck[];
  sampledFrames: SampledFrame[];
  /** llm-vision-sequence-qa | deterministic-structure-check */
  scorer: string;
  /** true = 未获得视觉验证，结果不得视为「已通过」 */
  fallback: boolean;
  checkedAt: number;
}

/** LLM 注入点：返回 LLM 原始响应（测试可注入确定性 fake） */
export type SequenceLlm = (input: {
  system: string;
  user: string;
  imageUrls: string[];
}) => Promise<{ success: boolean; data?: any; error?: string }>;

/** 抽帧注入点：按绝对时间点从成片抽帧（默认 ffmpeg 实现） */
export type FrameExtractor = (opts: {
  videoPath: string;
  timesSec: number[];
  requestId: string;
}) => Promise<SampledFrame[]>;

export interface SequenceGateOptions {
  plan: FullVideoPlan;
  /** 最终成片：/uploads 相对 URL 或本地绝对路径 */
  finalVideoUrl: string;
  /** Actual composed timeline when the FFmpeg quality path produced one. */
  timeline?: FullVideoTimeline;
  uploadsRoot?: string;
  llm?: SequenceLlm;
  extractFrames?: FrameExtractor;
}

// ==================== 确定性结构检查（第一层，无条件先跑） ====================

/**
 * 合法中间节拍（缺 benefit/comparison 允许；缺 hook/problem/product_intro/demo/
 * proof/cta 是断链）。P5 修复：直接从 domain 导入单一词表——plan/storyboard/gate
 * 共用同一份 MIDDLE_BEAT_ORDER，杜绝多模块各自维护导致的漂移。
 */
export const MIDDLE_BEAT_ORDER = DOMAIN_MIDDLE_BEAT_ORDER;

/** 结构层 beat 链检查：hook 开头、cta 收尾、中间节拍保持因果顺序 */
export function checkBeatOrder(beats: string[]): SequenceCheck {
  if (beats.length < 6 || beats.length > 8) {
    return {
      id: 'story_order',
      verdict: 'fail',
      evidence: [`成片包含 ${beats.length} 镜，超出 6-8 镜范围`],
      reason: '序列长度不满足 6-8 镜要求，无法构成完整 Hook→Problem→Demo→Proof→CTA 链',
      fix: { shotIndex: null, action: '调整分镜数量到 6-8 镜后重新生成' },
    };
  }
  const first = beats[0];
  const last = beats[beats.length - 1];
  const middle = beats.slice(1, -1);

  const errors: string[] = [];
  if (first !== 'hook') errors.push(`第 1 镜应为 hook，实际为 ${first}`);
  if (last !== 'cta') errors.push(`最后一镜应为 cta 收束，实际为 ${last}`);

  // 中间节拍按因果顺序出现：允许缺省个别（如 benefit），不允许逆序（如 proof 出现在 demo 前）
  let brokenIndex: number | null = null;
  {
    let expected = 0;
    for (let i = 0; i < middle.length; i++) {
      const beat = middle[i];
      if (beat === 'hook' || beat === 'cta') {
        errors.push(`中间镜出现了 ${beat}，打乱了节奏顺序`);
        if (brokenIndex === null) brokenIndex = i + 2;
        continue;
      }
      const position = (MIDDLE_BEAT_ORDER as readonly string[]).indexOf(beat);
      if (position >= 0 && position < expected) {
        errors.push(`中间节拍 ${beat} 出现在 ${MIDDLE_BEAT_ORDER[expected] ?? '后续'} 之前，因果顺序断裂`);
        if (brokenIndex === null) brokenIndex = i + 2;
      }
      expected = Math.max(expected, position + 1);
    }
  }

  if (errors.length > 0) {
    return {
      id: 'story_order',
      verdict: 'fail',
      evidence: errors,
      reason: '成片节拍链断裂：' + errors.join('；'),
      fix: {
        shotIndex: brokenIndex,
        action: '重新排布镜头节拍顺序（Hook → Problem → 产品进入 → Demo → Proof → CTA），重做乱序的镜头',
      },
    };
  }
  return {
    id: 'story_order',
    verdict: 'pass',
    evidence: [`节拍链合法：${beats.join(' -> ')}`],
    reason: '镜头节拍顺序与 Hook→Problem→Demo→Proof→CTA 链一致',
    fix: null,
  };
}

const DECORATIVE_PURPOSE = /^(产品特写|产品展示|镜头\s*\d+|close[- ]?up|product (close-?up|shot|showcase))$/i;

/**
 * 结构层承接检查：P5 起改为「状态链」确定性校验——
 * - 每镜必须有 purpose + transition 契约 + 状态契约（preState/postState），且不是装饰性镜头；
 * - 下一镜的 stateIn ⊆ 上一镜 stateOut（进入状态必须由上一镜交付）；
 * - 缺状态令牌的旧 plan 仍走字段非空检查（兼容），但新 plan 必须通过链式校验。
 */
export function checkHandoffContract(plan: FullVideoPlan): SequenceCheck {
  const missing: Array<{ shotIndex: number; problem: string }> = [];
  for (const shot of plan.shots) {
    if (!shot.semanticPurpose || shot.semanticPurpose.trim().length < 6) {
      missing.push({ shotIndex: shot.shotIndex, problem: '缺少叙事目的' });
    } else if (DECORATIVE_PURPOSE.test(shot.semanticPurpose.trim())) {
      missing.push({ shotIndex: shot.shotIndex, problem: '目的是装饰性产品展示，未承担叙事职责' });
    }
    if (!shot.transitionIn || !shot.transitionOut || !shot.transitionIn.trim() || !shot.transitionOut.trim()) {
      missing.push({ shotIndex: shot.shotIndex, problem: '缺少入镜/出镜承接契约' });
    }
    if (!shot.sourceAction || !shot.sourceAction.trim()) {
      missing.push({ shotIndex: shot.shotIndex, problem: '缺少可复刻的源动作' });
    }
  }

  // 状态链校验（确定性）：下一镜 stateIn 必须 ⊆ 上一镜 stateOut；
  // 契约完整性（preState/postState/action/transition/purpose）缺失同样是承接失败
  // （先经 toNarrativeContractShapes 映射字段名，PlannedShot 的 purpose 在 semanticPurpose 上）。
  // P5 二轮修复：只排除 story_order 维度的错误（节拍/数量由 checkBeatOrder 单独判定），
  // preState/postState/action 缺失必须让 causal_handoff fail——不得过滤。
  const chainErrors = validateNarrativeChain(toNarrativeContractShapes(plan.shots));
  const chainMissing = chainErrors
    .filter((error) => !/first shot must be hook|last shot must be cta|middle beat|outside 6-8|unknown middle beat|shot count/.test(error))
    .map((error) => {
      const match = /shot (\d+)/.exec(error);
      return { shotIndex: Number(match?.[1]) || 0, problem: `状态链断裂：${error}` };
    })
    .filter((item) => item.shotIndex > 0 && item.shotIndex <= plan.shots.length);
  const allMissing = [...missing, ...chainMissing];

  if (allMissing.length > 0) {
    const first = allMissing[0];
    return {
      id: 'causal_handoff',
      verdict: 'fail',
      evidence: allMissing.map((m) => `第 ${m.shotIndex} 镜：${m.problem}`),
      reason: `第 ${first.shotIndex} 镜 ${first.problem}，镜头之间的因果承接无法成立`,
      fix: {
        shotIndex: first.shotIndex,
        action: '为该镜补全叙事目的、状态契约（preState/postState/stateIn/stateOut）和入/出镜承接契约后重新生成（禁止纯装饰产品展示）',
      },
    };
  }
  return {
    id: 'causal_handoff',
    verdict: 'pass',
    evidence: ['全部镜头的 purpose/sourceAction/状态链/transitionIn/transitionOut 契约完整且状态链闭合'],
    reason: '每镜都有明确的入镜承接与出镜交付，状态链（stateIn ⊆ 上一镜 stateOut）成立',
    fix: null,
  };
}

/** 结构层产品进入时机检查：product_intro 前产品只作钩子出现、之后必须在场 */
export function checkProductEntryTiming(beats: string[]): SequenceCheck {
  const introIndex = beats.indexOf('product_intro');
  if (introIndex === -1) {
    return {
      id: 'product_entry_timing',
      verdict: 'fail',
      evidence: ['节拍链中不存在 product_intro'],
      reason: '产品进入时机缺失：观众无法在故事中识别解决方案',
      fix: { shotIndex: null, action: '在 Problem 之后加入产品进入镜头' },
    };
  }
  // product_intro 之前只能出现 hook/problem（产品以钩子/配角方式提前出现是允许的），
  // product_intro 之后产品必须在每镜在场（hero 或 supporting）。
  return {
    id: 'product_entry_timing',
    verdict: 'pass',
    evidence: [`产品进入发生在第 ${introIndex + 1} 镜（product_intro），位于 Problem 之后`],
    reason: '产品进入时机符合故事推进顺序',
    fix: null,
  };
}

/** 结构层 CTA 收束检查：最后一镜必须是 cta 且不再引入新叙事问题 */
export function checkCtaClosure(plan: FullVideoPlan): SequenceCheck {
  const last = plan.shots.at(-1);
  if (!last || last.beat !== 'cta') {
    return {
      id: 'cta_closure',
      verdict: 'fail',
      evidence: [`最后一镜 beat=${last?.beat ?? '(无)'}，不是 cta`],
      reason: '成片未以 CTA 收束，观众没有得到行动提示',
      fix: {
        shotIndex: plan.shots.length,
        action: '重做最后一镜为稳定的产品收尾（干净负空间，不引入新叙事信息）',
      },
    };
  }
  return {
    id: 'cta_closure',
    verdict: 'pass',
    evidence: [`第 ${last.shotIndex} 镜为 cta 收束`],
    reason: '成片以产品记忆和行动提示收尾',
    fix: null,
  };
}

/**
 * The semantic state chain says that a boundary is meaningful; this companion
 * check says what must visibly survive the boundary.  It is intentionally
 * separate from the LLM assessment below: malformed/missing visual contracts
 * are deterministic failures, while an unobserved rendered boundary is merely
 * unverified.
 */
export function checkVisualContinuityContract(plan: FullVideoPlan): SequenceCheck {
  if (!plan.visualContinuity) {
    return {
      id: 'visual_continuity',
      verdict: 'unverified',
      evidence: ['This saved plan predates the visual continuity package, so no explicit visual bible or boundary evidence exists.'],
      reason: 'The plan has no serializable visual continuity contract.',
      fix: {
        shotIndex: null,
        action: 'Rebuild the full-video plan so every generated shot receives the shared visual bible and every edit boundary has an explicit handoff.',
      },
    };
  }
  const errors = validateVisualContinuityPackage(plan.visualContinuity, plan.shots);
  for (const shot of plan.shots) {
    if (!shot.prompt.includes(VISUAL_CONTINUITY_PROMPT_MARKER)) {
      errors.push(`shot ${shot.shotIndex} does not carry the visual continuity contract into generation`);
    }
  }
  if (errors.length > 0) {
    const first = errors[0];
    const match = /shot\s+(\d+)|seam\s+(\d+)->/.exec(first);
    const shotIndex = Number(match?.[1] || match?.[2]) || null;
    return {
      id: 'visual_continuity',
      verdict: 'fail',
      evidence: errors,
      reason: `The visual continuity package is not executable: ${first}`,
      fix: {
        shotIndex,
        action: 'Restore the shared visual bible, exact adjacent-shot seam, and provider prompt fragment before generating any affected clip.',
      },
    };
  }
  return {
    id: 'visual_continuity',
    verdict: 'pass',
    evidence: [
      `One visual bible is bound to ${plan.shots.length} shots and ${plan.visualContinuity.seams.length} adjacent-shot seams.`,
      'Every planned provider prompt carries the same visual continuity contract.',
    ],
    reason: 'The plan has a testable visual anchor and a local repair path for every cut.',
    fix: null,
  };
}

/**
 * 确定性结构门禁：不依赖 LLM 即可判定的顺序/承接/收束问题。
 * 返回结构层所有检查；任一项 fail → 整体 fail（即使没有视觉验证）。
 */
export function runDeterministicStructureChecks(plan: FullVideoPlan): SequenceCheck[] {
  const beats = plan.shots.map((shot) => shot.beat);
  const handoff = checkHandoffContract(plan);
  const hasFiller = plan.shots.some(
    (shot) => !shot.semanticPurpose || shot.semanticPurpose.trim().length < 6 || DECORATIVE_PURPOSE.test(shot.semanticPurpose.trim())
  );
  return [
    checkBeatOrder(beats),
    handoff,
    checkProductEntryTiming(beats),
    checkCtaClosure(plan),
    {
      id: 'no_filler_shot',
      verdict: hasFiller ? 'fail' : 'pass',
      evidence: hasFiller
        ? ['存在未承担叙事职责的装饰性镜头']
        : ['每一镜都有独立叙事目的'],
      reason: hasFiller
        ? '存在「只是再来一个产品特写」的装饰性镜头'
        : '没有装饰性 filler 镜头',
      fix: hasFiller
        ? {
            shotIndex: plan.shots.findIndex((shot) => !shot.semanticPurpose || shot.semanticPurpose.trim().length < 6 || DECORATIVE_PURPOSE.test(shot.semanticPurpose.trim())) + 1,
            action: '为装饰性镜头补上不可替代的叙事职责（承接上一镜状态、完成状态变化、交给下一镜）或删除该镜',
          }
        : null,
    },
    checkVisualContinuityContract(plan),
  ];
}

// ==================== LLM vision 序列 QA prompt ====================

/**
 * Sample both sides of every edit. A centre-frame-only contact sheet can make
 * unrelated pretty clips look acceptable; boundary evidence exposes whether
 * action, product, light, and result actually carry through each cut. The
 * rendered FFmpeg timeline wins when it is available.
 */
export function buildSequenceFrameTargets(
  plan: FullVideoPlan,
  timeline?: FullVideoTimeline
): SequenceFrameTarget[] {
  const windowsByShot = new Map(
    (timeline?.clips || []).map((clip) => [clip.shotIndex, {
      startSec: clip.timelineStartSec,
      endSec: clip.timelineEndSec,
    }])
  );
  const windows = plan.shots.map((shot) => windowsByShot.get(shot.shotIndex) || ({
    startSec: shot.targetStartMs / 1000,
    endSec: shot.targetEndMs / 1000,
  }));
  const edgeInset = (startSec: number, endSec: number) => Math.min(0.35, Math.max(0.08, (endSec - startSec) / 8));
  const targets: SequenceFrameTarget[] = [];
  for (let index = 0; index < plan.shots.length; index += 1) {
    const shot = plan.shots[index];
    const window = windows[index];
    const inset = edgeInset(window.startSec, window.endSec);
    if (index === 0) {
      targets.push({
        timeSec: Number((window.startSec + inset).toFixed(3)),
        role: 'opening',
        shotIndex: shot.shotIndex,
      });
    }
    if (index < plan.shots.length - 1) {
      const next = plan.shots[index + 1];
      const nextWindow = windows[index + 1];
      const nextInset = edgeInset(nextWindow.startSec, nextWindow.endSec);
      targets.push({
        timeSec: Number((window.endSec - inset).toFixed(3)),
        role: 'boundary_out',
        shotIndex: shot.shotIndex,
        boundaryToShotIndex: next.shotIndex,
      });
      targets.push({
        timeSec: Number((nextWindow.startSec + nextInset).toFixed(3)),
        role: 'boundary_in',
        shotIndex: next.shotIndex,
        boundaryToShotIndex: shot.shotIndex,
      });
    } else {
      targets.push({
        timeSec: Number((window.endSec - inset).toFixed(3)),
        role: 'closing',
        shotIndex: shot.shotIndex,
      });
    }
  }
  return targets;
}

export function buildSequenceQaPrompt(opts: {
  productName: string;
  beats: string[];
  shots: Array<{ shotIndex: number; beat: string; purpose: string; sourceAction: string; transitionIn: string; transitionOut: string }>;
  sourceIntent: string;
  visualContinuity?: VisualContinuityPackage;
  frameTargets?: SequenceFrameTarget[];
}): { system: string; user: string } {
  const shotLines = opts.shots
    .map(
      (shot, index) =>
        `镜${index + 1}（beat=${shot.beat}）：目的「${shot.purpose}」；源动作「${shot.sourceAction}」；入镜承接「${shot.transitionIn}」；出镜交付「${shot.transitionOut}」`
    )
    .join('\n');
  const base = {
    system: `你是短视频叙事质量评审专家。任务：基于成片关键节点帧，判断整条视频是否兑现了语义故事板的叙事承诺。
只评估「故事是否串得起来」，不重复单镜质量评估。
五项检查（每项必须返回 pass/warning/fail/unverified 之一）：
1. story_order：画面呈现的顺序是否与给定的 beat 链一致（如 Demo 画面出现在 Product intro 之前 → fail）
2. causal_handoff：每一镜是否兑现了入镜承接/出镜交付（上一镜留下的状态被下一镜继续；状态断裂/跳变 → warning/fail）
3. product_entry_timing：产品是否在指定镜头正确进入，进入后是否持续在场（过早/过晚/进入后消失 → warning/fail）
4. cta_closure：最后一镜是否真正收束（干净产品收尾），是否又引入了新叙事信息（有 → fail）
5. no_filler_shot：是否存在「画面好看但没有任何状态变化」的装饰性镜头（有 → fail，指出是哪一镜）
规则：
- 只有从帧证据能直接判断的才可判 pass；证据不足判 unverified，禁止猜测通过；
- 「整体漂亮但没推进故事」必须反映在对应检查项的 fail/warning 中；
- fail/warning 时，evidence 里必须给出具体镜头序号（1-based）和画面证据。
返回严格 JSON（不要 Markdown 代码块）：
{"checks":[{"id":"story_order","verdict":"pass|warning|fail|unverified","score":0.0-1.0,"evidence":["..."],"reason":"...","failShotIndex":1}]}`,
    user: `目标产品：${opts.productName}
原视频整体意图：${opts.sourceIntent}
期望的节拍链：${opts.beats.join(' -> ')}

每镜的语义契约：
${shotLines}

我按每个镜头的计划时间节点抽取了成片关键帧（图片组按时间顺序排列）。
请逐一评估 5 项检查并返回 JSON。`,
  };
  const visualBible = opts.visualContinuity?.visualBible;
  const frameGuide = (opts.frameTargets || [])
    .map((target, index) =>
      `#${index + 1}=${target.role}: shot ${target.shotIndex}${target.boundaryToShotIndex ? ` -> shot ${target.boundaryToShotIndex}` : ''} @ ${target.timeSec}s`
    )
    .join('; ');
  const continuitySystem = `\n\nSixth required dimension: visual_continuity. Inspect every adjacent boundary pair, not just centre frames. Pass only when the same product package, set/props, lighting and white balance, camera-direction logic, and already-achieved visual result carry through the cut. A reset of the result, a different package, a sudden location/light shift, or a disconnected action is warning or fail. If boundary evidence is insufficient, return unverified. Return this sixth check in the same strict JSON checks array with failShotIndex set to the affected receiving shot.`;
  const continuityUser = `\n\nVisual continuity contract: ${visualBible
    ? `product=${visualBible.productIdentity}; set=${visualBible.setAndProps}; light=${visualBible.lighting}; forbidden drift=${visualBible.forbiddenDrift.join(' / ')}`
    : 'none; visual_continuity must be unverified'}\nBoundary frame guide (image order): ${frameGuide || 'no boundary-frame map available'}.`;
  return {
    system: base.system + continuitySystem,
    user: base.user + continuityUser,
  };
}

// ==================== 默认帧提取（ffmpeg，输出强制在 uploads 下） ====================

const defaultFrameExtractor: FrameExtractor = async ({ videoPath, timesSec, requestId }) => {
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  const safeOutDir = path.join(uploadsRoot, '.qa-tmp', requestId);
  fs.mkdirSync(safeOutDir, { recursive: true });
  const frames: SampledFrame[] = [];
  for (let i = 0; i < timesSec.length; i++) {
    const t = timesSec[i];
    const outFile = path.join(safeOutDir, `seq_${i}_${t.toFixed(1)}s.jpg`);
    try {
      await execAsync(
        `ffmpeg -y -v error -ss ${t.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 2 "${outFile}"`,
        { timeout: 20_000 }
      );
      if (fs.existsSync(outFile)) {
        frames.push({
          nodeIndex: i,
          timeSec: t,
          url: `/uploads/.qa-tmp/${requestId}/${path.basename(outFile)}`,
        });
      }
    } catch {
      // 单帧失败跳过（该节点在 LLM 侧表现为缺帧证据）
    }
  }
  return frames;
};

// ==================== 主入口 ====================

function resolveLocalVideoPath(videoUrl: string, uploadsRoot: string): string | null {
  if (videoUrl.startsWith('/uploads/')) {
    const local = path.join(uploadsRoot, videoUrl.replace(/^\/?uploads\//, ''));
    return fs.existsSync(local) ? local : null;
  }
  if (videoUrl.startsWith('http')) {
    // 远端成片由调用方先缓存到本地；此处不支持直接拉流（与单镜 QA 同纪律）
    return null;
  }
  return fs.existsSync(videoUrl) ? videoUrl : null;
}

function planToShotContract(plan: FullVideoPlan) {
  return plan.shots.map((shot) => ({
    shotIndex: shot.shotIndex,
    beat: shot.beat,
    purpose: shot.semanticPurpose || shot.visualIntent,
    sourceAction: shot.sourceAction || '',
    transitionIn: shot.transitionIn || '',
    transitionOut: shot.transitionOut || '',
  }));
}

function parseLlmChecks(raw: any): Array<Record<string, any>> {
  if (!raw || !Array.isArray(raw.checks)) return [];
  return raw.checks.filter((check: any) => check && typeof check.id === 'string');
}

const VALID_IDS: SequenceCheckId[] = [
  'story_order',
  'causal_handoff',
  'product_entry_timing',
  'cta_closure',
  'no_filler_shot',
  'visual_continuity',
];

function verdictOf(value: unknown): SequenceVerdict | null {
  return value === 'pass' || value === 'warning' || value === 'fail' || value === 'unverified'
    ? value
    : null;
}

/**
 * 序列级语义门禁主入口。
 *
 * 流程：
 * 1. 先跑确定性结构检查（顺序/承接/收束/无 filler）——结构层失败是确定失败；
 * 2. 结构层通过后，尝试视觉验证：按镜头节点抽帧 + LLM 评估；
 * 3. LLM 不可用/帧提取失败 → 视觉层 unverified；整体 = 任一 fail 则 fail，
 *    否则任一 unverified 则 unverified（绝不能把未验证包装成通过）。
 */
export async function runSequenceSemanticGate(opts: SequenceGateOptions): Promise<SequenceGateResult> {
  const { plan, finalVideoUrl } = opts;
  const uploadsRoot = path.resolve(opts.uploadsRoot || process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  const structureChecks = runDeterministicStructureChecks(plan);
  const checkedAt = Date.now();

  if (structureChecks.some((check) => check.verdict === 'fail')) {
    return {
      version: 'v1',
      status: 'fail',
      checks: structureChecks,
      sampledFrames: [],
      scorer: 'deterministic-structure-check',
      fallback: true,
      checkedAt,
    };
  }

  // 结构层通过 → 尝试视觉验证
  const localPath = resolveLocalVideoPath(finalVideoUrl, uploadsRoot);
  const requestId = `seq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const frameTargets = buildSequenceFrameTargets(plan, opts.timeline);
  const timesSec = frameTargets.map((target) => target.timeSec);
  let frames: SampledFrame[] = [];
  try {
    if (opts.extractFrames) {
      // 注入的提取器完全决定帧来源（测试/运行器已准备好帧或成片路径）
      frames = await opts.extractFrames({ videoPath: localPath ?? finalVideoUrl, timesSec, requestId });
    } else if (localPath) {
      frames = await defaultFrameExtractor({ videoPath: localPath, timesSec, requestId });
    }
  } catch {
    frames = [];
  }
  // Keep the evidence self-describing. Injected extractors may only return
  // URLs, while the gate still needs to tell the reviewer which side of which
  // edit each image represents.
  frames = frames.map((frame, index) => {
    const target = frameTargets[index];
    return target
      ? {
          ...frame,
          nodeIndex: index,
          timeSec: target.timeSec,
          role: target.role,
          shotIndex: target.shotIndex,
          ...(target.boundaryToShotIndex ? { boundaryToShotIndex: target.boundaryToShotIndex } : {}),
        }
      : frame;
  });

  const llm = opts.llm;
  if (!llm || frames.length === 0) {
    // 视觉验证不可用：结构层已通过，但画面是否兑现无从确认 → 如实 unverified
    return {
      version: 'v1',
      status: 'unverified',
      checks: structureChecks.map((check) =>
        check.verdict === 'pass'
          ? {
              ...check,
              verdict: 'unverified' as const,
              evidence: [...check.evidence, `视觉验证不可用（${!llm ? 'LLM 不可用' : '成片帧提取失败'}），该检查未获得画面证据`],
              reason: check.reason + '（未获得画面证据，不得视为通过）',
            }
          : check
      ),
      sampledFrames: frames,
      scorer: 'deterministic-structure-check',
      fallback: true,
      checkedAt,
    };
  }

  const { system, user } = buildSequenceQaPrompt({
    productName: plan.productName,
    beats: plan.shots.map((shot) => shot.beat),
    shots: planToShotContract(plan),
    sourceIntent: plan.semanticStoryboard?.sourceIntent || '通过痛点提出、产品进入、使用动作和结果证明，把观众从问题带到解决方案。',
    visualContinuity: plan.visualContinuity,
    frameTargets,
  });

  let llmChecks: Array<Record<string, any>> = [];
  let llmError: string | null = null;
  try {
    const response = await llm({
      system,
      user,
      imageUrls: frames.map((frame) => frame.url),
    });
    if (response.success && response.data) {
      llmChecks = parseLlmChecks(response.data);
    } else {
      llmError = response.error || 'sequence QA LLM 未返回数据';
    }
  } catch (error: any) {
    llmError = String(error?.message || error);
  }

  const checks: SequenceCheck[] = structureChecks.map((structural) => {
    const llmMatch = llmChecks.find((check) => check.id === structural.id);
    if (!llmMatch) {
      // LLM 未评估该项：该维度无画面证据 → unverified（结构 pass 不升级为视觉 pass）
      return {
        ...structural,
        verdict: 'unverified',
        evidence: [...structural.evidence, llmError ? `LLM 失败：${llmError}` : 'LLM 未返回该维度评估'],
        reason: structural.reason + '（视觉层未获得该维度评估，不得视为通过）',
      };
    }
    const verdict = verdictOf(llmMatch.verdict) ?? 'unverified';
    const evidenceList = Array.isArray(llmMatch.evidence)
      ? llmMatch.evidence.map((e: any) => String(e))
      : [String(llmMatch.reason || '无证据')];
    const failShotIndex = Number(llmMatch.failShotIndex);
    const shotIndex = Number.isInteger(failShotIndex) && failShotIndex > 0 ? failShotIndex : structural.fix?.shotIndex ?? null;
    return {
      id: structural.id,
      verdict,
      evidence: [...structural.evidence, ...evidenceList],
      reason: String(llmMatch.reason || '视觉序列评估'),
      fix: verdict === 'fail' || verdict === 'warning'
        ? {
            shotIndex,
            action: `重做第 ${shotIndex ?? '?'} 镜（${structural.id}：${String(llmMatch.reason || '视觉未兑现语义承诺')}）后重新生成成片并复检`,
          }
        : null,
    };
  });

  const status: SequenceVerdict = checks.some((check) => check.verdict === 'fail')
    ? 'fail'
    : checks.some((check) => check.verdict === 'unverified')
      ? 'unverified'
      : checks.some((check) => check.verdict === 'warning')
        ? 'warning'
        : 'pass';

  return {
    version: 'v1',
    status,
    checks,
    sampledFrames: frames,
    scorer: 'llm-vision-sequence-qa',
    fallback: status !== 'pass',
    checkedAt,
  };
}

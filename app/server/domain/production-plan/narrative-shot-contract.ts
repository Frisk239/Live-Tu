/**
 * NarrativeShotContract — 镜头叙事契约（纯领域模块，无 I/O）。
 *
 * 背景（P5 修复）：旧 storyboard 的中间镜 transitionIn 被模板文案覆盖，没有使用
 * 原始分析结果，也没有真正关联上一镜 transitionOut；旧 gate 只检查字段非空，
 * 无法证明镜头有意义地串联。
 *
 * 本模块定义单一镜头叙事契约：
 *   purpose / preState / action / postState / transitionIn / transitionOut / productRole
 * 外加确定性的状态令牌（stateIn/stateOut）：
 * - stateOut：本镜结束时向观众交付的叙事状态；
 * - stateIn：本镜开始前必须已成立的叙事状态；
 * - 链式规则：下一镜的 stateIn ⊆ 上一镜的 stateOut，preState/transitionIn 必须
 *   可追溯到上一镜的 postState/transitionOut。
 *
 * 6-8 镜使用同一份动态节拍链模板（同一词表、同一状态词表），
 * ReferenceAnalysis / SemanticStoryboard / FullVideoPlan / SequenceGate
 * 全部引用本模块的 SHOT_COUNT_RANGE / 节拍链 / 链式校验，避免各模块口径漂移。
 */

export type SemanticBeat =
  | 'hook'
  | 'problem'
  | 'product_intro'
  | 'demo'
  | 'proof'
  | 'comparison'
  | 'benefit'
  | 'cta';

export type SemanticProductRole = 'none' | 'supporting' | 'hero';

export const SHOT_COUNT_RANGE = { min: 6, max: 8 } as const;

/** 中间节拍的因果顺序（hook 固定开头、cta 固定收尾；comparison 位于 proof 之后） */
export const MIDDLE_BEAT_ORDER: readonly SemanticBeat[] = [
  'problem',
  'product_intro',
  'demo',
  'proof',
  'comparison',
  'benefit',
];

/** 必需节拍（6-8 镜的任何链都必须包含；benefit/comparison 可选） */
export const REQUIRED_NARRATIVE_BEATS: readonly SemanticBeat[] = [
  'hook',
  'problem',
  'product_intro',
  'demo',
  'proof',
  'cta',
];

/** 6/7/8 镜的动态节拍链（同一份契约：第一镜 hook、最后一镜 cta、中间因果递增） */
export const BEAT_CHAINS: Record<number, readonly SemanticBeat[]> = {
  6: ['hook', 'problem', 'product_intro', 'demo', 'proof', 'cta'],
  7: ['hook', 'problem', 'product_intro', 'demo', 'proof', 'benefit', 'cta'],
  8: ['hook', 'problem', 'product_intro', 'demo', 'proof', 'comparison', 'benefit', 'cta'],
};

export interface NarrativeShotContract {
  shotIndex: number;
  beat: SemanticBeat;
  /** 本镜不可替代的叙事职责（不是「再来一个产品特写」） */
  purpose: string;
  /** 本镜开始前的叙事状态（自由文本，供 prompt/QA） */
  preState: string;
  /** 本镜发生的可观察动作/状态变化（prompt 使用的安全版本） */
  action: string;
  /** 本镜结束后的叙事状态（自由文本） */
  postState: string;
  /** 如何承接上一镜留下的状态进入本镜 */
  transitionIn: string;
  /** 本镜把什么状态交给下一镜 */
  transitionOut: string;
  productRole: SemanticProductRole;
  /** 确定性状态令牌：进入本镜前必须已成立的状态 */
  stateIn: string[];
  /** 确定性状态令牌：本镜结束时交付的状态 */
  stateOut: string[];
  /** 原人物/竞品/字幕/水印的替换规则 */
  replacementIntent: string;
  /**
   * 源动作审计（P3 稳定性修复）：原视频动作/字幕/标签/时间段——仅审计与追溯，
   * 绝不进入图像或视频 provider prompt。
   */
  sourceActionAudit?: string;
  /** 可生成的安全视觉替代动作（无人物/无字幕/无标签；provider prompt 唯一动作来源） */
  safeVisualProxy: string;
  /** QA 应检查的可见结果（替代「复刻源人物动作」的不可满足契约） */
  safeCoverageCriteria: string[];
}

export interface TemplateContractInput {
  productName: string;
  segments: Array<{ startSec: number; endSec: number; candidateId?: string }>;
  rawAnalysis?: unknown;
  /** raw 分析是否通过 schema 校验（未通过只能走模板文本） */
  rawValid?: boolean;
  /** 每镜来自 raw 分析的补充文本（可空） */
  rawShots?: Array<Record<string, unknown>>;
}

/** 解析镜头数量：6-8 钳制（所有模块共用同一口径） */
export function resolveShotCount(requested: number | undefined, fallback = 6): number {
  const value = Number.isFinite(requested) ? Math.floor(Number(requested)) : fallback;
  return Math.max(SHOT_COUNT_RANGE.min, Math.min(SHOT_COUNT_RANGE.max, value));
}

/** 该镜节拍在模板链中的位置（用于状态词表） */
function beatIndex(beat: SemanticBeat): number {
  if (beat === 'hook') return -1;
  if (beat === 'cta') return MIDDLE_BEAT_ORDER.length;
  return MIDDLE_BEAT_ORDER.indexOf(beat);
}

/**
 * 状态词表：每个节拍交付的确定性状态令牌（stateOut）。
 * S4.1 修复：stateIn 不再单独声明——下一镜的进入状态 = 上一镜的 stateOut（链式继承），
 * 任何 6/7/8 镜链都自洽（原表把 cta.in=['value_delivered'] 写死，6 镜链没有 benefit
 * 交付该状态导致确定性断链；benefit.in 在 7/8 镜链同样断裂）。
 * comparison 同时延续 result_proven 与新增 edge_clear，供 8 镜链 benefit 承接。
 */
const STATE_OUT_TOKENS: Record<SemanticBeat, string[]> = {
  hook: ['attention_held'],
  problem: ['problem_identified'],
  product_intro: ['solution_identified'],
  demo: ['usage_result'],
  proof: ['result_proven'],
  comparison: ['result_proven', 'edge_clear'],
  benefit: ['value_delivered'],
  cta: [],
};

function templateForBeat(beat: SemanticBeat, productName: string): Omit<NarrativeShotContract, 'shotIndex' | 'stateIn' | 'stateOut' | 'beat'> & { beat: SemanticBeat } {
  const p = productName || 'the product';
  switch (beat) {
    case 'hook':
      return {
        beat,
        purpose: '先用一个可立即读懂的视觉反差提出问题，让观众停留。',
        preState: '从空场或低信息状态快速切入。',
        action: '快速进入主体并在第一拍给出强构图信号。',
        postState: '观众的目光被吸引，注意力指向待解决的痛点。',
        transitionIn: '从空场或低信息状态快速切入（开场，无需承接上一镜）。',
        transitionOut: '把注意力从视觉反差导向待解决的痛点。',
        productRole: 'hero',
        replacementIntent: `保留原视频的强构图开场节奏，将原人物、竞品包装、字幕和身份元素替换为 ${p}、喷嘴、泡沫与中性台面。`,
        safeVisualProxy: '产品包装在干净中性台面上以强构图第一拍出现，画面无人物、无手、无字幕。',
        safeCoverageCriteria: ['产品在首帧即清晰出现', '画面无人物/手/字幕/标签'],
      };
    case 'problem':
      return {
        beat,
        purpose: '把痛点具体化，让观众理解为什么需要解决方案。',
        preState: '承接 Hook 已提出的疑问，观众知道「这里有问题」。',
        action: '放大残留、泡沫、质感或不洁表面等问题证据。',
        postState: '问题被看清，观众形成解决期待。',
        transitionIn: '承接上一镜（Hook）留下的「attention_held」状态：从视觉反差转入问题证据。',
        transitionOut: '问题被看清后，画面准备引入解决方案。',
        productRole: 'supporting',
        replacementIntent: `保留原视频的痛点放大技法，将原人物、竞品包装、字幕和身份元素替换为 ${p}、喷嘴、泡沫与中性台面。`,
        safeVisualProxy: '台面上的残留、泡沫与表面质感被镜头放大展示，产品包装作为背景锚点稳定可见，画面无人物、无字幕。',
        safeCoverageCriteria: ['问题证据（残留/泡沫/质感）清晰可见', '产品包装在画面中可识别', '画面无人物/字幕/标签'],
      };
    case 'product_intro':
      return {
        beat,
        purpose: '让解决方案在故事中第一次被明确识别。',
        preState: '承接「problem_identified」：观众带着解决期待等待答案。',
        action: '从问题细节切到包装、形状或使用入口的清晰展示。',
        postState: '观众识别出具体产品就是解决方案。',
        transitionIn: '承接上一镜（Problem）留下的「problem_identified」状态：从问题证据转入解决方案识别。',
        transitionOut: '产品被识别后，马上进入可验证的使用动作。',
        productRole: 'hero',
        replacementIntent: `保留原视频的解决方案识别节奏，将原人物、竞品包装、字幕和身份元素替换为 ${p}、喷嘴、泡沫与中性台面。`,
        safeVisualProxy: '产品包装在稳定光线与机位下完整展示，包装颜色、形状与标签布局清晰可读，画面无人物、无字幕。',
        safeCoverageCriteria: ['产品包装完整可读', '包装颜色与产品参考图一致', '画面无人物/字幕/标签'],
      };
    case 'demo':
      return {
        beat,
        purpose: '用一个可观察的动作证明产品不是静态摆拍。',
        preState: '承接「solution_identified」：观众已认出产品，等待看它如何工作。',
        action: '展示挤出、铺展、起泡、接触或清理的因果动作。',
        postState: '动作结果留在画面中，供下一镜比较或收束。',
        transitionIn: '承接上一镜（产品进入）留下的「solution_identified」状态：从产品识别自然进入使用动作。',
        transitionOut: '动作结果必须留在画面中，供下一镜比较或收束。',
        productRole: 'hero',
        replacementIntent: `保留原视频的因果动作演示，将原人物、竞品包装、字幕和身份元素替换为 ${p}、喷嘴、泡沫与中性台面。`,
        safeVisualProxy: '喷嘴挤出泡沫并沿台面连续铺展，动作方向一致，泡沫与产品作为动作载体，结果留在画面中，画面无人物、无手。',
        safeCoverageCriteria: ['泡沫挤出并连续铺展的动作可见', '动作方向一致无跳变', '画面无人物/手/字幕/标签'],
      };
    case 'proof':
      return {
        beat,
        purpose: '把动作结果转成一眼可判断的对比或证据。',
        preState: '承接「usage_result」：动作结果已在画面中，等待被证明。',
        action: '展示表面变化、泡沫质感或清洁后的状态对比。',
        postState: '观众获得「确实发生了变化」的视觉确认。',
        transitionIn: '承接上一镜（Demo）留下的「usage_result」状态：从动作结果转入证据确认。',
        transitionOut: '证据完成后，把视线重新交还给产品。',
        productRole: 'hero',
        replacementIntent: `保留原视频的结果证明技法，将原人物、竞品包装、字幕和身份元素替换为 ${p}、喷嘴、泡沫与中性台面。`,
        safeVisualProxy: '台面清洁前后的状态对比在相同光线与机位下呈现，产品保持同框锚点，画面无人物、无字幕。',
        safeCoverageCriteria: ['前后状态差异一眼可判断', '光线与机位保持稳定', '画面无人物/字幕/标签'],
      };
    case 'comparison':
      return {
        beat,
        purpose: '用可观察的对比（不同表面/使用前后）把证据推向更强的说服力。',
        preState: '承接「result_proven」：第一个证据已成立，等待对比强化。',
        action: '在同一光线下切换/并列展示处理前后或不同表面的差异。',
        postState: '对比让效果边界清晰，观众不再怀疑有效性。',
        transitionIn: '承接上一镜（Proof）留下的「result_proven」状态：从第一证据转入对比强化。',
        transitionOut: '对比完成后，把视线引向使用利益的概括。',
        productRole: 'hero',
        replacementIntent: `保留原视频的对比强化技法，将原人物、竞品包装、字幕和身份元素替换为 ${p}、喷嘴、泡沫与中性台面。`,
        safeVisualProxy: '同一台面上清洁与未清洁区域并列展示，光线与机位完全一致，产品作为中立锚点，画面无人物、无文字。',
        safeCoverageCriteria: ['对比区域同框且边界清晰', '光线与机位一致', '画面无人物/文字/标签'],
      };
    case 'benefit':
      return {
        beat,
        purpose: '把局部结果提升为用户可以带走的核心利益。',
        preState: '承接「result_proven/edge_clear」：证据与对比已成立，等待价值概括。',
        action: '用产品与干净场景的关系概括使用价值，不添加未经证实的功效。',
        postState: '观众理解产品适合什么场景、解决什么问题。',
        transitionIn: '承接上一镜（Proof/对比）留下的「result_proven/edge_clear」状态：从证据状态提炼出使用利益。',
        transitionOut: '利益表达为最终产品记忆和行动提示铺路。',
        productRole: 'hero',
        replacementIntent: `保留原视频的价值概括节奏，将原人物、竞品包装、字幕和身份元素替换为 ${p}、喷嘴、泡沫与中性台面。`,
        safeVisualProxy: '清洁结果与产品在同一舒缓构图中同框，负空间干净，画面无人物、无字幕。',
        safeCoverageCriteria: ['结果与产品同框可见', '构图舒缓无新元素', '画面无人物/字幕/标签'],
      };
    case 'cta':
      return {
        beat,
        purpose: '用清晰、可记忆的产品收尾完成转化准备。',
        preState: '承接上一镜已建立的叙事状态，观众带着正面印象来到收尾。',
        action: '回到产品英雄镜头并保持足够停留时间。',
        postState: '观众记住产品外观和下一步行动对象，故事不再引入新信息。',
        transitionIn: '承接上一镜已建立的叙事状态，从证据/利益表达进入稳定产品收尾。',
        transitionOut: '以稳定产品状态结束，不再引入新的叙事问题。',
        productRole: 'hero',
        replacementIntent: `保留原视频的收尾节奏，将原人物、竞品包装、字幕和身份元素替换为 ${p}、喷嘴、泡沫与中性台面。`,
        safeVisualProxy: '产品以稳定收尾构图停留，负空间干净，画面无人物、无字幕、无新叙事信息。',
        safeCoverageCriteria: ['产品收尾构图稳定', '无新叙事信息进入', '画面无人物/字幕/标签'],
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** 定位该镜对应的 raw 分析：优先 candidateId（cand-N → shotIndex N），回退最终镜序 */
function matchRawShot(
  rawShots: Array<Record<string, unknown>>,
  candidateId: string | undefined,
  index: number
): Record<string, unknown> | undefined {
  if (candidateId) {
    const seq = Number(String(candidateId).replace(/^cand-/, ''));
    if (Number.isInteger(seq) && seq >= 1) {
      const byCandidate = rawShots.find((s) => Number(s.shotIndex) === seq);
      if (byCandidate) return byCandidate;
    }
  }
  return rawShots.find((s) => Number(s.shotIndex) === index + 1);
}

/** 从 raw 分析中提取该镜的补充文本（仅当 raw 通过 schema 校验才使用） */
function rawShotText(
  rawShots: Array<Record<string, unknown>>,
  candidateId: string | undefined,
  index: number,
  field: string
): string {
  const shot = matchRawShot(rawShots, candidateId, index);
  return shot ? text(shot[field], '') : '';
}

/**
 * 构建 6-8 镜的模板叙事契约链。
 * rawAnalysis 通过 schema 校验时，用 raw 文本覆盖 purpose/action/transition 等
 * 自由文本字段；状态令牌（stateIn/stateOut）永远来自模板词表——
 * 链的完整性不因 LLM 文本而断裂。
 */
export function buildTemplateContracts(input: TemplateContractInput): NarrativeShotContract[] {
  const shotCount = resolveShotCount(input.segments.length);
  const beats = BEAT_CHAINS[shotCount] ?? BEAT_CHAINS[6];
  const segments = input.segments.slice(0, shotCount);
  const useRaw = Boolean(input.rawValid);
  const rawShots = Array.isArray(input.rawShots) ? input.rawShots : [];

  const contracts = beats.map((beat, index) => {
    const tpl = templateForBeat(beat, input.productName);
    const segment = segments[index] ?? { startSec: index, endSec: index + 1 };
    const purpose = useRaw
      ? text(rawShotText(rawShots, segment.candidateId, index, 'purpose'), tpl.purpose)
      : tpl.purpose;
    // P3 稳定性修复：provider prompt 的动作来源 = 安全代理（LLM 提供或模板兜底）。
    // raw 的 sourceAction/description 只进 sourceActionAudit（审计与追溯），
    // 绝不覆盖 action——杜绝源字幕/标签文本（如「粗大毛孔」）泄漏进生成指令。
    const rawActionText =
      rawShotText(rawShots, segment.candidateId, index, 'sourceAction') ||
      rawShotText(rawShots, segment.candidateId, index, 'description');
    const rawProxyText = rawShotText(rawShots, segment.candidateId, index, 'safeVisualProxy');
    const action = useRaw && rawProxyText ? rawProxyText : tpl.action;
    const safeVisualProxy = useRaw && rawProxyText ? rawProxyText : tpl.safeVisualProxy;
    const rawCriteria = useRaw
      ? rawShotText(rawShots, segment.candidateId, index, 'safeCoverageCriteria')
      : '';
    let safeCoverageCriteria = tpl.safeCoverageCriteria;
    if (rawCriteria) {
      try {
        const parsed = JSON.parse(rawCriteria);
        if (Array.isArray(parsed) && parsed.length > 0) {
          safeCoverageCriteria = parsed.map((item: unknown) => String(item)).filter((item: string) => item.trim().length > 0);
        }
      } catch {
        // 非法 JSON 保持模板标准
      }
    }
    const postState = useRaw
      ? text(rawShotText(rawShots, segment.candidateId, index, 'postState'), tpl.postState)
      : tpl.postState;
    const transitionOut = useRaw
      ? text(rawShotText(rawShots, segment.candidateId, index, 'transitionOut'), tpl.transitionOut)
      : tpl.transitionOut;
    // 链式状态令牌：本镜进入状态 = 上一镜交付状态（首镜无进入状态），链永远自洽
    const prevBeat = index > 0 ? beats[index - 1] : null;
    const stateIn = prevBeat ? [...(STATE_OUT_TOKENS[prevBeat] ?? [])] : [];
    const stateOut = [...(STATE_OUT_TOKENS[beat] ?? [])];

    return {
      shotIndex: index + 1,
      beat,
      purpose,
      preState: tpl.preState,
      action,
      postState,
      transitionIn: tpl.transitionIn,
      transitionOut,
      productRole: tpl.productRole,
      stateIn,
      stateOut,
      replacementIntent: tpl.replacementIntent,
      // 源动作审计：原动作/字幕/标签/时间段，仅审计（不进入任何 provider prompt）
      sourceActionAudit: useRaw && rawActionText
        ? `[${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}s] ${rawActionText}`
        : undefined,
      safeVisualProxy,
      safeCoverageCriteria,
    };
  });

  // 第二遍：给每一镜（首镜除外）追加「上一镜交付状态」的字面引用——
  // preState/transitionIn 由此可文本级追溯到上一镜的 stateOut（确定性可检验）。
  return contracts.map((contract, index) => {
    if (index === 0) return contract;
    const prev = contracts[index - 1];
    const trace = `（承接第 ${index} 镜交付状态：${prev.stateOut.join('、')}）`;
    return {
      ...contract,
      preState: `${contract.preState}${trace}`,
      transitionIn: `${contract.transitionIn}${trace}`,
    };
  });
}

/**
 * 确定性链式校验（状态链，而非字段非空）：
 * 1. 数量在 6-8 且与模板链一致；
 * 2. 第一镜 hook、最后一镜 cta、中间节拍因果递增；
 * 3. 下一镜 stateIn ⊆ 上一镜 stateOut（进入状态必须由上一镜交付）；
 * 4. 首镜 stateIn 必须为空；
 * 5. 每个契约的 purpose/preState/action/postState/transitionIn/transitionOut
 *    非空且不是装饰性文本。
 * 兼容性：旧 plan 可能没有 stateIn/stateOut（undefined 视为空数组）；
 * 只有至少一镜声明了状态令牌（「现代」契约）时才强制中间镜声明 stateIn。
 * 返回错误列表；空数组 = 链成立。
 */
export function validateNarrativeChain(
  contracts: Array<
    Pick<
      NarrativeShotContract,
      'shotIndex' | 'beat' | 'purpose' | 'preState' | 'action' | 'postState' | 'transitionIn' | 'transitionOut' | 'stateIn' | 'stateOut'
    > & {
      stateIn?: string[];
      stateOut?: string[];
      preState?: string;
      postState?: string;
      action?: string;
      purpose?: string;
      transitionIn?: string;
      transitionOut?: string;
    }
  >
): string[] {
  const errors: string[] = [];
  if (contracts.length < SHOT_COUNT_RANGE.min || contracts.length > SHOT_COUNT_RANGE.max) {
    errors.push(`shot count ${contracts.length} outside 6-8`);
  }
  if (contracts.length === 0) return errors;
  const beats = contracts.map((c) => c.beat);
  const first = beats[0];
  const last = beats.at(-1);
  if (first !== 'hook') errors.push(`first shot must be hook, got ${first}`);
  if (last !== 'cta') errors.push(`last shot must be cta, got ${last}`);

  // 中间节拍因果递增（与 SequenceGate 的 MIDDLE_BEAT_ORDER 同源）
  let expected = 0;
  for (let i = 1; i < beats.length - 1; i++) {
    const beat = beats[i];
    if (beat === 'hook' || beat === 'cta') {
      errors.push(`middle shot ${i + 1} is ${beat}, breaking the causal order`);
      continue;
    }
    const position = MIDDLE_BEAT_ORDER.indexOf(beat);
    if (position < 0) {
      errors.push(`unknown middle beat ${beat}`);
      continue;
    }
    if (position < expected) {
      errors.push(`middle beat ${beat} at shot ${i + 1} breaks causal order`);
    }
    expected = Math.max(expected, position + 1);
  }

  // 现代契约判定：任一镜声明了状态令牌
  const modern = contracts.some((c) => (c.stateIn?.length ?? 0) > 0 || (c.stateOut?.length ?? 0) > 0);

  // 状态链：下一镜 stateIn ⊆ 上一镜 stateOut
  for (let i = 1; i < contracts.length; i++) {
    const prev = contracts[i - 1];
    const cur = contracts[i];
    const curIn = cur.stateIn ?? [];
    const prevOut = prev.stateOut ?? [];
    if (modern) {
      const missing = curIn.filter((token) => !prevOut.includes(token));
      if (missing.length > 0) {
        errors.push(
          `shot ${cur.shotIndex} requires state [${missing.join(', ')}] not produced by shot ${prev.shotIndex}`
        );
      }
    }
  }
  if (modern && (contracts[0].stateIn?.length ?? 0) > 0) {
    errors.push(`first shot must not require incoming state (got [${contracts[0].stateIn?.join(', ')}])`);
  }

  // 文本契约完整性（装饰性 purpose 视为无效）
  const DECORATIVE = /^(产品特写|产品展示|镜头\s*\d+|close[- ]?up|product (close-?up|shot|showcase))$/i;
  for (const c of contracts) {
    const purpose = (c.purpose ?? '').trim();
    const preState = (c.preState ?? '').trim();
    const action = (c.action ?? '').trim();
    const postState = (c.postState ?? '').trim();
    const transitionIn = (c.transitionIn ?? '').trim();
    const transitionOut = (c.transitionOut ?? '').trim();
    if (purpose.length < 6) errors.push(`shot ${c.shotIndex} has no meaningful purpose`);
    if (DECORATIVE.test(purpose)) errors.push(`shot ${c.shotIndex} purpose is decorative`);
    if (!preState) errors.push(`shot ${c.shotIndex} has no preState`);
    if (!action) errors.push(`shot ${c.shotIndex} has no action`);
    if (!postState) errors.push(`shot ${c.shotIndex} has no postState`);
    if (!transitionIn || !transitionOut) errors.push(`shot ${c.shotIndex} has no transition contract`);
    if (modern && (c.stateIn?.length ?? 0) === 0 && c.shotIndex > 1) {
      // 中间镜必须声明进入状态（首镜除外），否则链无从证明
      errors.push(`shot ${c.shotIndex} declares no incoming state token`);
    }
  }
  return errors;
}

/**
 * 把带语义元数据的 plan shot（semanticPurpose/sourceAction 命名）映射为
 * 链式校验所需的契约形状。full-video-plan 与 sequence gate 共用，避免
 * 字段名漂移（PlannedShot 的 purpose 实际在 semanticPurpose 上）。
 */
export function toNarrativeContractShapes(
  shots: Array<{
    shotIndex: number;
    beat: SemanticBeat;
    semanticPurpose?: string | null;
    sourceAction?: string | null;
    preState?: string | null;
    postState?: string | null;
    transitionIn?: string | null;
    transitionOut?: string | null;
    stateIn?: string[] | null;
    stateOut?: string[] | null;
  }>
): Array<{
  shotIndex: number;
  beat: SemanticBeat;
  purpose: string;
  preState: string;
  action: string;
  postState: string;
  transitionIn: string;
  transitionOut: string;
  stateIn: string[];
  stateOut: string[];
}> {
  return shots.map((shot) => ({
    shotIndex: shot.shotIndex,
    beat: shot.beat,
    purpose: shot.semanticPurpose ?? '',
    preState: shot.preState ?? '',
    action: shot.sourceAction ?? '',
    postState: shot.postState ?? '',
    transitionIn: shot.transitionIn ?? '',
    transitionOut: shot.transitionOut ?? '',
    stateIn: shot.stateIn ? [...shot.stateIn] : [],
    stateOut: shot.stateOut ? [...shot.stateOut] : [],
  }));
}

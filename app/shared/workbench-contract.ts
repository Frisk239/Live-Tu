/**
 * S2 爆款复刻工作台契约（单一来源）
 *
 * 覆盖：三档自主模式、独立付费授权、持久化 SaveState、拆片/分镜 typed contract、
 * 提交前预检（能力/素材/成本/余额/等待）、镜头级局部重试、模型能力 schema。
 *
 * 约束（S2 执行者提示词 §二/§三）：
 * - 「允许 AI 自动提交付费生成」必须是独立、默认关闭的授权，不与自主性档位绑定；
 * - SaveState 状态机 shared 单一来源，前端展示与服务端持久化共用；
 * - 普通模式只展示产品语言，JSON/原始 prompt/provider 参数默认折叠；
 * - 未知成本必须显示 unknown，绝不写 0；亚分成本用微美元整数运算，不丢精度；
 * - 模型能力 schema 驱动前端选择、服务端校验和测试（单一来源）。
 */

// ==================== 自主模式 ====================

export const AUTONOMY_MODES = ['managed', 'confirm_key_points', 'step_by_step'] as const;
/**
 * - managed（托管直出）：确认点自动通过，但付费授权仍独立默认关闭；
 * - confirm_key_points（关键节点确认）：仅在 拆解结果 / 分镜计划 / 批量付费提交 三处确认；
 * - step_by_step（逐步控制）：每一步由用户显式触发。
 */
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const isAutonomyMode = (value: unknown): value is AutonomyMode =>
  typeof value === 'string' && (AUTONOMY_MODES as readonly string[]).includes(value);

/** 三档自主性的产品语言文案（frontend 与服务端报告共用） */
export const AUTONOMY_MODE_LABELS: Record<AutonomyMode, string> = {
  managed: '托管直出',
  confirm_key_points: '关键节点确认',
  step_by_step: '逐步控制',
};

// ==================== 独立付费授权 ====================

export interface PaidAuthorization {
  /** 「允许 AI 自动提交付费生成」——独立授权，默认 false，与自主模式解绑 */
  enabled: boolean;
}

export const createDefaultPaidAuthorization = (): PaidAuthorization => ({ enabled: false });

// ==================== 持久化 SaveState ====================

export const SAVE_STATES = ['saving', 'saved', 'dirty', 'offline_retry'] as const;
export type SaveState = (typeof SAVE_STATES)[number];

export const isSaveState = (value: unknown): value is SaveState =>
  typeof value === 'string' && (SAVE_STATES as readonly string[]).includes(value);

export const SAVE_STATE_LABELS: Record<SaveState, string> = {
  saving: '保存中…',
  saved: '已保存',
  dirty: '有未保存修改',
  offline_retry: '保存失败，等待重试',
};

// ==================== 确认点 ====================

export const CONFIRM_TYPES = ['deconstruction', 'shot_plan', 'batch_submit'] as const;
export type ConfirmType = (typeof CONFIRM_TYPES)[number];

export const CONFIRM_TYPE_LABELS: Record<ConfirmType, string> = {
  deconstruction: '拆解结果',
  shot_plan: '分镜计划',
  batch_submit: '批量付费提交',
};

// ==================== 拆片/分镜 typed contract ====================

export type ShotSize =
  | 'extreme_wide'
  | 'wide'
  | 'medium'
  | 'close_up'
  | 'extreme_close_up'
  | 'unknown';

export type ShotStatus =
  | 'pending'
  | 'confirmed'
  | 'submitted'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DialogueLine {
  text: string;
  startTime?: number;
  endTime?: number;
}

export interface ShotCandidate {
  id: string;
  /** 候选资源（首帧图/视频）URL */
  url: string;
  prompt: string;
  model: string;
  createdAt: number;
}

export interface ShotCapabilityConstraints {
  /** 生成时长约束（秒）；undefined = 无约束/未知 */
  minDurationSec?: number;
  maxDurationSec?: number;
  supportedAspectRatios?: string[];
  supportedResolutions?: string[];
  /** 需要的参考输入数量（首帧/产品图/参考视频） */
  requiredReferenceInputs?: number;
}

export interface ShotPlanShot {
  shotIndex: number;
  /** 时间码（秒） */
  startTime: number;
  endTime: number;
  /** 景别 */
  shotSize: ShotSize;
  /** 机位 */
  cameraPosition: string;
  /** 运镜 */
  cameraMovement: string;
  /** 光线 */
  lighting: string;
  /** 台词/字幕 */
  dialogue: DialogueLine[];
  /** 音效 */
  soundEffects: string[];
  /** 必须保留 */
  mustKeep: string[];
  /** 必须替换 */
  mustReplace: string[];
  /** 生成模式 */
  generationMode: 'text_to_video' | 'image_to_video' | 'unknown';
  /** 模型能力约束（由能力 schema 校验） */
  capabilityConstraints: ShotCapabilityConstraints;
  /** 该镜状态 */
  status: ShotStatus;
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
  /** 证据引用（来源 artifact / provider 参数快照） */
  evidence: PreflightEvidence[];
  /** 镜头候选与用户选择 */
  candidates: ShotCandidate[];
  selectedCandidateId: string | null;
  /** 用户对该镜 prompt 的局部覆盖（可编辑）；null = 用默认 prompt */
  promptOverride: string | null;
  /** 该镜视频模型（提交时使用） */
  modelId: string;
  /** Full-video planner metadata. Optional for legacy single-shot drafts. */
  beat?: string;
  referencePolicy?: 'safe_keyframe' | 'semantic_replacement';
  referenceKeyframeUrl?: string | null;
  continuityAnchorUrl?: string | null;
  continuityGroup?: string;
  visualIntent?: string;
  productExposure?: 'none' | 'supporting' | 'hero';
  /** Hard visual constraints that must survive provider prompt rewriting. */
  negativeConstraints?: string[];
  /** Semantic storyboard metadata: why this shot exists and what it hands off. */
  semanticPurpose?: string;
  sourceAction?: string;
  audienceEffect?: string;
  transitionIn?: string;
  transitionOut?: string;
  replacementIntent?: string;
  targetStartMs?: number;
  targetEndMs?: number;
}

// ==================== 预检契约 ====================

export type PreflightLevel = 'blocker' | 'warning';

export interface PreflightEvidence {
  /** 证据来源：如 'shot-qa', 'model-catalog', 'materials', 'cost-estimator', 'balance-api', 'provider' */
  source: string;
  detail: string;
  /** 关联产物/资源（URL 或 artifact id） */
  artifact?: string;
}

export interface FixAction {
  /** 可执行修复动作分类 */
  kind:
    | 'upload'
    | 'configure'
    | 'select'
    | 'switch_model'
    | 'authorize'
    | 'retry'
    | 'wait'
    | 'reduce_candidates';
  /** 用户可执行的动作描述（产品语言） */
  label: string;
}

export interface PreflightIssue {
  code: string;
  level: PreflightLevel;
  /** 面向用户的产品语言 */
  message: string;
  evidence: PreflightEvidence;
  /** 可执行修复动作；null = 无需修复（纯提示） */
  fix: FixAction | null;
}

export interface ShotCostEstimate {
  shotIndex: number;
  shotId?: string;
  modelId: string;
  /** 预估成本（USD）；未知必须 'unknown'，绝不写 0 */
  estimatedUsd: number | 'unknown';
  /** 微美元整数（估算依据）；unknown 时为 null */
  estimatedUsdMicros: number | null;
}

export interface CostPreflight {
  perShot: ShotCostEstimate[];
  /** 逐镜合计；任一镜 unknown 则合计 unknown（不吞成 0） */
  totalEstimatedUsd: number | 'unknown';
  /** 已发生实际成本（成本账本汇总）；无账单/未产生时 'unknown' */
  actualUsd: number | 'unknown';
  unknownActual: boolean;
  currency: 'USD';
  evidenceSource: string;
}

export interface BalancePreflight {
  /** false = 无法验证余额（如实显示，不假装有余额） */
  verified: boolean;
  balanceUsd: number | 'unknown';
  /** 差额；无法验证时 'unknown' */
  shortfallUsd: number | 'unknown';
  provider: string;
}

export interface WaitEstimate {
  /** 预计等待区间（秒） */
  minSec: number;
  maxSec: number;
  /** 证据来源说明（如 model-catalog speedMs + 队列缓冲） */
  evidenceSource: string;
}

export interface ShotCapabilityMatch {
  shotIndex: number;
  modelId: string;
  supported: boolean;
  reason?: string;
  constraintsMet: string[];
  constraintsFailed: string[];
}

export type MaterialCheckStatus = 'verified' | 'unverified' | 'missing' | 'blocked';

export interface MaterialCheck {
  kind: 'first_frame' | 'reference' | 'product_asset' | 'audio';
  url: string;
  ok: boolean;
  status: MaterialCheckStatus;
  detail?: string;
  /** 素材元数据（可达时） */
  aspectRatio?: string;
  durationSec?: number;
  resolution?: string;
}

export interface CostReductionStrategy {
  id: 'fewer_candidates' | 'economy_model' | 'free_queue' | 'paid_acceleration';
  label: string;
  /** provider 不支持时必须 false 并给 reason，不能展示假能力 */
  supported: boolean;
  reason?: string;
}

export interface PreflightResult {
  ok: boolean;
  canSubmit: boolean;
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
  cost: CostPreflight;
  balance: BalancePreflight;
  wait: WaitEstimate;
  /** 每镜模型与能力匹配结果 */
  capability: ShotCapabilityMatch[];
  /** 素材可达性/比例/时长/分辨率/参考输入数量 */
  materials: MaterialCheck[];
  strategies: CostReductionStrategy[];
  checkedAt: number;
}

// ==================== 工作台状态（getState） ====================

export type WorkbenchPhase =
  | 'setup'
  | 'deconstruction'
  | 'shot_plan'
  | 'preflight'
  | 'generating'
  | 'render'
  | 'review'
  | 'completed';

export const WORKBENCH_PHASES: WorkbenchPhase[] = [
  'setup',
  'deconstruction',
  'shot_plan',
  'preflight',
  'generating',
  'render',
  'review',
  'completed',
];

export interface ShotRuntimeState {
  shotId: string;
  sessionId: string;
  shotIndex: number;
  status: ShotStatus;
  attempt: number;
  failureReason: string | null;
  videoUrl: string | null;
  errorMessage: string | null;
  updatedAt: string;
  // --- P3 质量闭环字段 ---
  /** 当前版本号（shot_versions.version） */
  currentVersion: number;
  /** 技术 QA 状态 */
  techQaStatus: 'pending' | 'verified' | 'unverified' | 'warning';
  /** 语义 QA 总体判决 */
  semanticVerdict: 'pending' | 'pass' | 'warning' | 'fail' | 'unverified';
  /** 语义 QA 摘要（一句话） */
  qaSummary: string | null;
  /** QA 报告 ID（关联 shot_qa_reports） */
  qaReportId: string | null;
  /** 版本列表（从旧到新） */
  versions: ShotVersionInfo[];
  /** 选中的版本 ID（null = 使用当前版本） */
  selectedVersionId: string | null;
  /** 是否已人工通过 */
  manualPassed: boolean;
  /** 自动修复次数（最多 2 次后需人工确认） */
  autoFixCount: number;
}

export interface ShotVersionInfo {
  versionId: string;
  version: number;
  videoUrl: string | null;
  prompt: string | null;
  modelCode: string | null;
  status: string;
  verdict: string | null;
  createdAt: string;
}

export interface WorkbenchState {
  ownerId: string;
  runId: string | null;
  sessionId: string | null;
  autonomyMode: AutonomyMode;
  paidAuthorization: PaidAuthorization;
  saveState: SaveState;
  /** 三处确认点状态 */
  confirms: Record<ConfirmType, boolean>;
  /** 用户对分镜的局部编辑（promptOverride / 候选选择）——服务端持久化草稿 */
  draftJson: string | null;
  phase: WorkbenchPhase;
  /** 服务端当前执行阶段（来自 pipeline_runs.current_step + shots） */
  serverPhase: string;
  /** 任务开始以来耗时（ms） */
  elapsedMs: number;
  /** 累计重试次数 */
  retryCount: number;
  failureReason: string | null;
  /** P3：累计估算成本（USD），unknown = 'unknown' */
  estimatedCostUsd: number | 'unknown';
  /** P3：累计实际成本（USD），unknown = 'unknown' */
  incurredCostUsd: number | 'unknown';
  /** P3：语义 QA 通过的镜头数 / 总镜头数 */
  qaPassedShots: number;
  qaTotalShots: number;
  /** P3：等待时间估计区间（秒） */
  waitEstimate: { minSec: number; maxSec: number } | null;
  /** 「任务可安全离开」的明确状态 */
  safeToLeave: boolean;
  shotStates: ShotRuntimeState[];
  updatedAt: string;
}

/** 默认设置：托管直出 + 付费授权关闭 + 无任何确认 */
export function createDefaultWorkbenchSettings(): {
  autonomyMode: AutonomyMode;
  paidAuthorization: PaidAuthorization;
  confirms: Record<ConfirmType, boolean>;
} {
  return {
    autonomyMode: 'managed',
    paidAuthorization: createDefaultPaidAuthorization(),
    confirms: { deconstruction: false, shot_plan: false, batch_submit: false },
  };
}

// ==================== 镜头重试请求 ====================

export interface RetryShotRequest {
  runId: string;
  shotId: string;
  /** 重试序号（>=1），必须携带并进入成本账本 */
  attempt: number;
  /** 失败原因，必须携带并进入成本账本 */
  failureReason: string;
  /** 用户对该镜 prompt 的局部修改（可选） */
  promptOverride?: string | null;
  /** Internal-only visual constraints derived from a QA report for this retry. */
  fixGuidance?: string[];
}

export interface RetryShotResult {
  shotId: string;
  shotIndex: number;
  attempt: number;
  status: ShotStatus;
  submitted: boolean;
  /** 拒绝原因（如成功镜头不可重提） */
  rejectedReason?: string;
  videoUrl: string | null;
  costLedgerId: string | null;
}

/** 确认点结果（服务端返回，frontend 与测试共用） */
export interface ConfirmResult {
  type: ConfirmType;
  confirmed: boolean;
  /** 拒绝原因（如 paid_auth_required / preflight_blocked） */
  rejectedReason?: string;
  submittedCount?: number;
  /** batch_submit 每镜提交明细（shotIndex + submitted + reason）——全失败时不再 200 假成功 */
  results?: Array<{ shotIndex: number; submitted: boolean; reason?: string }>;
  /** batch_submit 时的预检结果（blocker 时随拒绝返回） */
  preflight?: PreflightResult;
  state: WorkbenchState;
}

// ==================== 模型能力 schema（单一来源） ====================

export type ModelCategory = 'text' | 'image' | 'video';

export interface VideoModelCapability {
  maxDurationSec: number;
  minDurationSec: number;
  supportedAspectRatios: string[];
  supportedResolutions: string[];
  /** 参考输入数量上限（首帧/产品图/参考视频） */
  maxReferenceInputs: number;
  /** provider 是否支持付费加速 */
  supportsPaidAcceleration: boolean;
  economyTier: 'standard' | 'economy' | 'premium';
}

export interface ModelCapability {
  category: ModelCategory;
  video?: VideoModelCapability;
  /** 图像模型参考输入上限 */
  maxImageReferenceInputs?: number;
}

/** 未知模型的兜底能力：拒绝（避免假装支持） */
export const UNKNOWN_MODEL_CAPABILITY: ModelCapability = {
  category: 'video',
  video: {
    maxDurationSec: 0,
    minDurationSec: 0,
    supportedAspectRatios: [],
    supportedResolutions: [],
    maxReferenceInputs: 0,
    supportsPaidAcceleration: false,
    economyTier: 'standard',
  },
};

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // 星河中转 Seedance（model-catalog 同 ID）
  'Seedance 2.0 Fast': {
    category: 'video',
    video: {
      maxDurationSec: 10,
      minDurationSec: 3,
      supportedAspectRatios: ['9:16', '16:9', '1:1'],
      supportedResolutions: ['720p', '1080p'],
      maxReferenceInputs: 2,
      supportsPaidAcceleration: false,
      economyTier: 'economy',
    },
  },
  'Seedance 2.0': {
    category: 'video',
    video: {
      maxDurationSec: 15,
      minDurationSec: 3,
      supportedAspectRatios: ['9:16', '16:9', '1:1'],
      supportedResolutions: ['720p', '1080p'],
      maxReferenceInputs: 2,
      supportsPaidAcceleration: false,
      economyTier: 'standard',
    },
  },
  // 图像模型（首帧/候选图）
  'GPT Image 2': {
    category: 'image',
    maxImageReferenceInputs: 1,
  },
  'GPT Image 1': {
    category: 'image',
    maxImageReferenceInputs: 1,
  },
  'GPT Image 1 Mini': {
    category: 'image',
    maxImageReferenceInputs: 1,
  },
  'GPT Image 1.5': {
    category: 'image',
    maxImageReferenceInputs: 1,
  },
  'Seedream 4.5': {
    category: 'image',
    maxImageReferenceInputs: 1,
  },
  'Z-Image Turbo': {
    category: 'image',
    maxImageReferenceInputs: 1,
  },
};

/** 查询模型能力；未知模型返回拒绝能力（绝不假装支持） */
export function getModelCapability(modelId: string): ModelCapability {
  return MODEL_CAPABILITIES[modelId] ?? UNKNOWN_MODEL_CAPABILITY;
}

/** 模型能力与需求约束的匹配（前端选择与服务端校验共用） */
export function matchShotCapability(
  modelId: string,
  constraints: ShotCapabilityConstraints
): { supported: boolean; met: string[]; failed: string[] } {
  const cap = getModelCapability(modelId);
  const met: string[] = [];
  const failed: string[] = [];
  if (cap.category !== 'video') {
    failed.push(`模型 ${modelId} 不是视频模型`);
    return { supported: false, met, failed };
  }
  const v = cap.video!;
  if (v.maxDurationSec <= 0) {
    failed.push(`模型 ${modelId} 能力未知，拒绝假装支持`);
    return { supported: false, met, failed };
  }
  const maxDur = constraints.maxDurationSec ?? v.maxDurationSec;
  const minDur = constraints.minDurationSec ?? v.minDurationSec;
  if (maxDur > v.maxDurationSec) {
    failed.push(`需求时长 ${maxDur}s 超过模型上限 ${v.maxDurationSec}s`);
  } else {
    met.push(`时长 ${minDur}-${maxDur}s 在能力范围内（上限 ${v.maxDurationSec}s）`);
  }
  if (constraints.supportedAspectRatios?.length) {
    const ok = constraints.supportedAspectRatios.every((r) => v.supportedAspectRatios.includes(r));
    if (ok) met.push(`比例 ${constraints.supportedAspectRatios.join('/')} 受支持`);
    else failed.push(`比例 ${constraints.supportedAspectRatios.join('/')} 不受支持（支持 ${v.supportedAspectRatios.join('/')}）`);
  } else {
    met.push('无比例约束');
  }
  if (constraints.supportedResolutions?.length) {
    const ok = constraints.supportedResolutions.every((r) => v.supportedResolutions.includes(r));
    if (ok) met.push(`分辨率 ${constraints.supportedResolutions.join('/')} 受支持`);
    else failed.push(`分辨率 ${constraints.supportedResolutions.join('/')} 不受支持`);
  } else {
    met.push('无分辨率约束');
  }
  const refs = constraints.requiredReferenceInputs ?? 1;
  if (refs > v.maxReferenceInputs) {
    failed.push(`参考输入 ${refs} 个超过上限 ${v.maxReferenceInputs} 个`);
  } else {
    met.push(`参考输入 ${refs} 个在能力内（上限 ${v.maxReferenceInputs}）`);
  }
  return { supported: failed.length === 0, met, failed };
}

// ==================== 成本估算（微美元整数运算，不丢亚分精度） ====================

/** 微美元：1 USD = 1_000_000 micros */
export const USD_MICROS = 1_000_000;

/**
 * 确定性视频单价（估算用，micros）。S2 不声称真实账单——provider 账单接入后
 * 以 cost_ledger actual_usd_micros 为准；这里只驱动预检展示与成本账本 estimated 列。
 */
export const VIDEO_PRICE_MICROS: Record<string, number> = {
  'doubao-seedance-2-0-fast': 100_000, // $0.10
  'doubao-seedance-2-0': 200_000, // $0.20
};

/** 确定性图像单价（候选图/首帧） */
export const IMAGE_PRICE_MICROS: Record<string, number> = {
  'gpt-image-2': 80_000, // $0.08
  'gpt-image-1': 50_000, // $0.05
  'gpt-image-1.5': 60_000, // $0.06
  'gpt-image-1-mini': 20_000, // $0.02
  'doubao-seedream-4-5-251128': 30_000, // $0.03
  'z-image-turbo': 20_000, // $0.02
};

export const DEFAULT_VIDEO_PRICE_MICROS: number | null = null; // 未定价模型 → unknown
export const DEFAULT_IMAGE_PRICE_MICROS = 50_000;

/**
 * 估算单镜成本（micros）。未知模型返回 null（= 'unknown'），绝不返回 0 冒充未知。
 */
export function estimateShotUsdMicros(modelCode: string, kind: 'video' | 'image'): number | null {
  const table = kind === 'video' ? VIDEO_PRICE_MICROS : IMAGE_PRICE_MICROS;
  const price = table[modelCode];
  if (price === undefined) {
    return kind === 'image' ? DEFAULT_IMAGE_PRICE_MICROS : DEFAULT_VIDEO_PRICE_MICROS;
  }
  return price;
}

/**
 * 整镜提交成本（预检展示与成本账本 estimated 共用同一算法）：
 * 视频生成 + candidateCount 个候选首帧图。视频未定价 → null（unknown）。
 */
export function estimateVideoShotUsdMicros(
  modelCode: string,
  candidateCount = 1
): number | null {
  const video = estimateShotUsdMicros(modelCode, 'video');
  if (video === null) return null;
  const candidate = estimateShotUsdMicros('gpt-image-2', 'image');
  return video + (candidate ?? 0) * Math.max(1, candidateCount);
}

/** micros → USD 展示值（保留 6 位小数，未知返回 'unknown'） */
export function microsToUsd(micros: number | null): number | 'unknown' {
  if (micros === null || !Number.isFinite(micros) || micros < 0) return 'unknown';
  return Math.round(micros) / USD_MICROS;
}

/**
 * 逐镜合计：整数微美元求和（不丢亚分精度）；任一镜 unknown → 合计 unknown（不吞成 0）。
 */
export function sumShotCostMicros(estimates: Array<number | null>): number | null {
  if (estimates.some((e) => e === null)) return null;
  return estimates.reduce((acc, e) => acc + (e as number), 0);
}

/** USD 展示（未知为 'unknown'，绝不写 0） */
export function formatUsd(value: number | 'unknown'): string {
  if (value === 'unknown') return 'unknown';
  return `$${value.toFixed(6)}`;
}

// ==================== 阶段派生 ====================

/**
 * 由 run 状态 + shots 派生工作台阶段（frontend 与服务端共用）。
 * runId 为空 → setup；batch_submit 已确认且任一 shot generating → generating；全部完成 → completed。
 */
export function deriveWorkbenchPhase(
  opts: {
    runExists: boolean;
    runStatus: string;
    hasShots: boolean;
    anyShotGenerating: boolean;
    allShotsCompleted: boolean;
    batchConfirmed: boolean;
  }
): WorkbenchPhase {
  if (!opts.runExists && !opts.hasShots) return 'setup';
  if (!opts.batchConfirmed && !opts.anyShotGenerating) return 'shot_plan';
  if (opts.anyShotGenerating) return 'generating';
  if (opts.runStatus === 'needs_review' || opts.runStatus === 'failed') return 'review';
  if (opts.runStatus === 'completed' || opts.allShotsCompleted) return 'completed';
  return 'generating';
}

// ==================== P3 质量闭环请求/结果类型 ====================

/** 对单个镜头执行 QA（技术 + 语义） */
export interface ShotQaRequest {
  runId: string;
  shotId: string;
}

export interface ShotQaResult {
  shotId: string;
  version: number;
  overallVerdict: 'pass' | 'warning' | 'fail' | 'unverified';
  summary: string;
  issues: Array<{
    dimension: string;
    verdict: 'pass' | 'warning' | 'fail' | 'unverified';
    reason: string;
    fixAction: string | null;
  }>;
  reportId: string;
}

/** 自动修复循环：最多 2 次，超出后需人工确认 */
export interface FixShotRequest {
  runId: string;
  shotId: string;
  /** 是否跳过自动修复直接使用当前版本 */
  skipAutoFix?: boolean;
}

export interface FixShotResult {
  shotId: string;
  action: 'regenerated' | 'already_passing' | 'needs_human_confirm' | 'max_fixes_reached';
  newVersion: number;
  autoFixCount: number;
  verdict: string;
  summary: string;
}

/** 人工通过：接受当前版本，不再要求修复 */
export interface ManualPassRequest {
  runId: string;
  shotId: string;
  comment?: string;
}

export interface ManualPassResult {
  shotId: string;
  version: number;
  manualPassed: boolean;
  comment: string | null;
}

/** 选择历史版本 */
export interface UseVersionRequest {
  runId: string;
  shotId: string;
  /** 目标版本 ID（shot_versions.id） */
  versionId: string;
}

export interface UseVersionResult {
  shotId: string;
  newVersion: number;
  videoUrl: string | null;
  selectedVersionId: string;
}

/** 恢复操作（前端刷新后使用） */
export interface RestoreVersionRequest {
  runId: string;
  shotId: string;
}

export interface RestoreVersionResult {
  shotId: string;
  videoUrl: string | null;
  version: number;
  manualPassed: boolean;
}

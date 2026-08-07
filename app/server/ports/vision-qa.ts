/**
 * VisionQaPort — LLM/vision QA 端口（外部调用统一经此 port，CLI/服务端共用）。
 *
 * 职责：
 * - 定义「序列级视觉 QA」与「原视频语义理解」两类调用的端口契约；
 * - 真实适配器由调用方显式注入（runner 使用真实 gateway 适配器，
 *   测试使用确定性 fake）——不允许 CLI runner 自行拼装散乱的 provider 调用；
 * - LLM 不可用时必须如实返回 unverified/fallback，绝不伪造 pass。
 *
 * 本文件只定义契约类型，不含任何实现（实现见 adapters/）。
 */

/** 序列 QA 输入：计划 + 成片节点帧 */
export interface SequenceQaInput {
  productName: string;
  beats: string[];
  /** 每镜的语义契约（供 LLM 核对画面是否兑现） */
  shots: Array<{
    shotIndex: number;
    beat: string;
    purpose: string;
    sourceAction: string;
    preState?: string;
    postState?: string;
    transitionIn: string;
    transitionOut: string;
  }>;
  sourceIntent: string;
  /** 成片抽帧（/uploads 相对 URL 或 data: URL），按时间顺序 */
  frameUrls: string[];
}

export interface SequenceQaCheckVerdict {
  id: 'story_order' | 'causal_handoff' | 'product_entry_timing' | 'cta_closure' | 'no_filler_shot';
  verdict: 'pass' | 'warning' | 'fail' | 'unverified';
  evidence: string[];
  reason: string;
  failShotIndex?: number;
}

export interface SequenceQaResult {
  checks: SequenceQaCheckVerdict[];
  /** 整体状态：任一 fail → fail；否则任一 unverified → unverified */
  status: 'pass' | 'warning' | 'fail' | 'unverified';
  fallback: boolean;
  modelUsed?: string | null;
  error?: string | null;
}

/** 单次 LLM 调用契约（sequence gate 与 source 理解共用同一形状） */
export interface LlmCallInput {
  system: string;
  user: string;
  imageUrls: string[];
  modelId?: string;
  temperature?: number;
}

export interface LlmCallResult {
  success: boolean;
  data?: unknown;
  modelUsed?: string;
  source?: string;
  error?: string;
}

/** 序列视觉 QA 端口 */
export interface SequenceVisionQaPort {
  readonly name: string;
  analyzeSequence(input: SequenceQaInput): Promise<SequenceQaResult>;
}

/** 原视频语义理解端口（非付费理解 pass） */
export interface SourceSemanticAnalysisPort {
  readonly name: string;
  /** 返回归一化后的 storyboard + 原始分析 + 来源标记（fallback 必须如实标注） */
  analyzeSource(input: SourceSemanticAnalysisInput): Promise<SourceSemanticAnalysisOutput>;
}

export interface SourceSemanticAnalysisInput {
  productName: string;
  segments: Array<{ candidateId?: string; startSec: number; endSec: number; structure?: string }>;
  keyframeUrls: string[];
  modelId?: string;
}

export interface SourceSemanticAnalysisOutput {
  storyboard: unknown;
  rawAnalysis: unknown;
  source: 'llm_vision' | 'deterministic_fallback' | 'hybrid';
  schemaValid: boolean;
  modelUsed: string | null;
  error: string | null;
}

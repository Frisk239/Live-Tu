/**
 * 黄金样本集契约 v1 (S1)
 *
 * - 可版本管理的黄金样本数据结构：6–8 条真实样本槽位；
 *   真实素材尚未提供前，全部为 synthetic/placeholder fixture，显式标记，不得冒充真实样本。
 * - 每条样本至少包含：产品与产品素材、原始爆款参考、替换目标、允许保留项、禁止项、
 *   人工基准、provider/model/version/seed、运行次数、成本与耗时。
 * - 每次评测至少运行 3 次，报告均值、方差与单次结果（见 golden-eval）。
 * - 不触发真实付费模型调用：由 golden-eval 的 fake/synthetic scorer 完成可复现验证。
 */

import { DEFAULT_PROMPT_VERSION, type CostEntry, type UsdAmount } from './cost-ledger';
import type { Scorecard } from './scorecard';

export const GOLDEN_SET_VERSION = 'v1.0.0';

export interface GoldenSample {
  id: string;
  name: string;
  product: string;
  /** 产品素材（相对 /uploads 或绝对 URL；synthetic 阶段可能不存在，仅作引用） */
  productAssetUrl: string;
  /** 原始爆款参考 */
  referenceUrl: string;
  /** 参考视频结构段落（真实样本用于区分不同视频结构） */
  referenceSegment?: { startSec: number; endSec: number; description: string };
  /** 替换目标（理想产物） */
  targetUrl?: string;
  /** 已知合格产物 URL 列表（真实样本用于验收基线） */
  knownAcceptableUrls?: string[];
  /** 允许保留项 */
  allowedItems: string[];
  /** 禁止项 */
  prohibitedItems: string[];
  /** 人工基准描述（评审标准） */
  manualBaseline: string;
  provider: string;
  model: string;
  version: string;
  seed: number;
  /** fixture 标记：synthetic=true 为占位 fixture；真实素材提供后必须改为 false（审查 P1-6） */
  synthetic: boolean;
  provenance: {
    source: 'synthetic-fixture' | 'real';
    /** 说明该样本现状（素材缺失 / 待人工提供） */
    note: string;
    lastUpdated: string;
  };
  /** 每次评测的默认运行次数 */
  runsRequired: number;
  /** prompt 模板版本；S1 无托管模板时为 DEFAULT_PROMPT_VERSION */
  promptVersion: string;
  /** 样本级成本（实际成本未知时必须为 'unknown'） */
  cost: CostEntry;
  qaVersion: string;
  gateVersion: string;
  scorecardVersion: string;
}

/** 单次运行结果：评分卡 + 成本账本 + 产物引用 + 状态 */
export interface SampleRun {
  id: string;
  sampleId: string;
  runIndex: number;
  timestamp: number;
  provider: string;
  model: string;
  version: string;
  seed: number;
  /** 本次运行的产物引用 */
  artifactUrl: string;
  /** 产物是否实际存在（synthetic 阶段通常 missing） */
  artifactStatus: 'present' | 'missing' | 'unverified';
  scorecard: Scorecard;
  cost: CostEntry;
  /** 总耗时（含排队）ms */
  durationMs: number;
  /** prompt 模板版本（S1 无模板时为 DEFAULT_PROMPT_VERSION） */
  promptVersion: string;
  pipelineVersion: string;
  gitCommit: string | 'unknown';
  /** measured=真实测得；unverified=未验证（不得当通过）；failed=运行失败 */
  status: 'measured' | 'unverified' | 'failed';
  failureReason?: string;
  /** 发布门禁快照（存在时），用于报告 blocker/warning */
  gate?: {
    passed: boolean;
    status: 'passed' | 'needs_review' | 'failed' | 'unverified';
    blockers: string[];
    warnings: string[];
    blockerEvidence: Record<string, GateEvidence>;
    warningEvidence: Record<string, GateEvidence>;
    scorerVersion: string;
  };
}

export interface GateEvidence {
  code: string;
  source: string;
  detail: string;
  artifact?: string;
}

export interface SampleStats {
  runs: number;
  /** 加权分均值（按 run 的 weighted.value） */
  mean: number;
  /** 总体方差（样本方差；runs<2 时为 0） */
  variance: number;
  min: number;
  max: number;
  /** 逐维度均值（run 间） */
  perDimensionMean: Record<string, number>;
  measuredRuns: number;
  unverifiedRuns: number;
  failedRuns: number;
}

/** 8 条结构完整的 synthetic fixture 槽位（真实素材待人工提供后逐个替换） */
export const GOLDEN_SAMPLES: GoldenSample[] = [
  {
    id: 'skincare-hero-1',
    name: '绿泥洗面奶 爆款视频（fixture）',
    product: '绿泥洗面奶',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/参考视频/20260722-100929.856-0.mp4',
    targetUrl: '/uploads/renders/test_render_1785200791697.mp4',
    allowedItems: ['skin-care-text', 'product-emoji', 'clean-background'],
    prohibitedItems: ['competitor-logo', 'extra-text', 'branding'],
    manualBaseline: '产品主图清晰，皮肤质感自然，无黑帧，无额外文字，9:16 比例，音画同步',
    provider: '星河中转（fixture）',
    model: 'Seedance 2.0 Fast（fixture）',
    version: '2.0.0',
    seed: 42,
    synthetic: true,
    provenance: {
      source: 'synthetic-fixture',
      note: '占位 fixture：URL 为真实工程目录中的路径，素材未入库前仅作引用；成本为估算，实际成本 unknown。',
      lastUpdated: '2026-08-04',
    },
    runsRequired: 3,
    promptVersion: DEFAULT_PROMPT_VERSION,
    cost: {
      id: 'cost-skincare-hero-1',
      scope: 'sample',
      sampleId: 'skincare-hero-1',
      provider: '星河中转（fixture）',
      model: 'Seedance 2.0 Fast（fixture）',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 42,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: DEFAULT_PROMPT_VERSION,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.15,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
  {
    id: 'skincare-hero-2',
    name: '李响 护肤视频（fixture）',
    product: '绿泥洗面奶',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/爆款视频/0716-毛孔2-1.mp4',
    targetUrl: '/uploads/renders/test_render_1785208832328.mp4',
    allowedItems: ['skin-care-text', 'product-emoji', 'clean-background'],
    prohibitedItems: ['competitor-logo', 'extra-text', 'branding'],
    manualBaseline: '产品主图清晰，皮肤质感自然，无黑帧，无额外文字，9:16 比例，音画同步',
    provider: '星河中转（fixture）',
    model: 'Seedance 2.0 Fast（fixture）',
    version: '2.0.0',
    seed: 123,
    synthetic: true,
    provenance: {
      source: 'synthetic-fixture',
      note: '占位 fixture：URL 为真实工程目录中的路径，素材未入库前仅作引用；成本为估算，实际成本 unknown。',
      lastUpdated: '2026-08-04',
    },
    runsRequired: 3,
    promptVersion: DEFAULT_PROMPT_VERSION,
    cost: {
      id: 'cost-skincare-hero-2',
      scope: 'sample',
      sampleId: 'skincare-hero-2',
      provider: '星河中转（fixture）',
      model: 'Seedance 2.0 Fast（fixture）',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 123,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: DEFAULT_PROMPT_VERSION,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.15,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
  {
    id: 'skincare-hero-3',
    name: '林鸿杰 科普视频（fixture）',
    product: '绿泥洗面奶',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/爆款视频/林鸿杰-0701-2-3厘米针头科普.mp4',
    targetUrl: '/uploads/renders/test_render_1785200951200.mp4',
    allowedItems: ['skin-care-text', 'product-emoji', 'clean-background'],
    prohibitedItems: ['competitor-logo', 'extra-text', 'branding'],
    manualBaseline: '产品主图清晰，皮肤质感自然，无黑帧，无额外文字，9:16 比例，音画同步',
    provider: '星河中转（fixture）',
    model: 'Seedance 2.0 Fast（fixture）',
    version: '2.0.0',
    seed: 456,
    synthetic: true,
    provenance: {
      source: 'synthetic-fixture',
      note: '占位 fixture：URL 为真实工程目录中的路径，素材未入库前仅作引用；成本为估算，实际成本 unknown。',
      lastUpdated: '2026-08-04',
    },
    runsRequired: 3,
    promptVersion: DEFAULT_PROMPT_VERSION,
    cost: {
      id: 'cost-skincare-hero-3',
      scope: 'sample',
      sampleId: 'skincare-hero-3',
      provider: '星河中转（fixture）',
      model: 'Seedance 2.0 Fast（fixture）',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 456,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: DEFAULT_PROMPT_VERSION,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.15,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
  {
    id: 'skincare-hero-4',
    name: '赖雨华 护肤视频（fixture）',
    product: '绿泥洗面奶',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/爆款视频/赖雨华-0701-40-清水洗脸24.mp4',
    targetUrl: '/uploads/renders/test_render_1785208832328.mp4',
    allowedItems: ['skin-care-text', 'product-emoji', 'clean-background'],
    prohibitedItems: ['competitor-logo', 'extra-text', 'branding'],
    manualBaseline: '产品主图清晰，皮肤质感自然，无黑帧，无额外文字，9:16 比例，音画同步',
    provider: '星河中转（fixture）',
    model: 'Seedance 2.0 Fast（fixture）',
    version: '2.0.0',
    seed: 789,
    synthetic: true,
    provenance: {
      source: 'synthetic-fixture',
      note: '占位 fixture：URL 为真实工程目录中的路径，素材未入库前仅作引用；成本为估算，实际成本 unknown。',
      lastUpdated: '2026-08-04',
    },
    runsRequired: 3,
    promptVersion: DEFAULT_PROMPT_VERSION,
    cost: {
      id: 'cost-skincare-hero-4',
      scope: 'sample',
      sampleId: 'skincare-hero-4',
      provider: '星河中转（fixture）',
      model: 'Seedance 2.0 Fast（fixture）',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 789,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: DEFAULT_PROMPT_VERSION,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.15,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
  {
    id: 'skincare-hero-5',
    name: '郭海艳 护肤视频（fixture）',
    product: '绿泥洗面奶',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/爆款视频/郭海艳-0709-43-去年的我1.mp4',
    targetUrl: '/uploads/renders/test_render_1785200791697.mp4',
    allowedItems: ['skin-care-text', 'product-emoji', 'clean-background'],
    prohibitedItems: ['competitor-logo', 'extra-text', 'branding'],
    manualBaseline: '产品主图清晰，皮肤质感自然，无黑帧，无额外文字，9:16 比例，音画同步',
    provider: '星河中转（fixture）',
    model: 'Seedance 2.0 Fast（fixture）',
    version: '2.0.0',
    seed: 101,
    synthetic: true,
    provenance: {
      source: 'synthetic-fixture',
      note: '占位 fixture：URL 为真实工程目录中的路径，素材未入库前仅作引用；成本为估算，实际成本 unknown。',
      lastUpdated: '2026-08-04',
    },
    runsRequired: 3,
    promptVersion: DEFAULT_PROMPT_VERSION,
    cost: {
      id: 'cost-skincare-hero-5',
      scope: 'sample',
      sampleId: 'skincare-hero-5',
      provider: '星河中转（fixture）',
      model: 'Seedance 2.0 Fast（fixture）',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 101,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: DEFAULT_PROMPT_VERSION,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.15,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
  {
    id: 'skincare-hero-6',
    name: '黎晓晓 护肤视频（fixture）',
    product: '绿泥洗面奶',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/爆款视频/黎晓晓-0704-157-AI歌曲高考主题优化.mp4',
    targetUrl: '/uploads/renders/test_render_1785208832328.mp4',
    allowedItems: ['skin-care-text', 'product-emoji', 'clean-background'],
    prohibitedItems: ['competitor-logo', 'extra-text', 'branding'],
    manualBaseline: '产品主图清晰，皮肤质感自然，无黑帧，无额外文字，9:16 比例，音画同步',
    provider: '星河中转（fixture）',
    model: 'Seedance 2.0 Fast（fixture）',
    version: '2.0.0',
    seed: 202,
    synthetic: true,
    provenance: {
      source: 'synthetic-fixture',
      note: '占位 fixture：URL 为真实工程目录中的路径，素材未入库前仅作引用；成本为估算，实际成本 unknown。',
      lastUpdated: '2026-08-04',
    },
    runsRequired: 3,
    promptVersion: DEFAULT_PROMPT_VERSION,
    cost: {
      id: 'cost-skincare-hero-6',
      scope: 'sample',
      sampleId: 'skincare-hero-6',
      provider: '星河中转（fixture）',
      model: 'Seedance 2.0 Fast（fixture）',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 202,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: DEFAULT_PROMPT_VERSION,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.15,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
  {
    id: 'skincare-hero-7',
    name: '毛孔护肤合成（fixture）',
    product: '绿泥洗面奶',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/uploads/renders/test_render_1785200791697.mp4',
    targetUrl: '/uploads/renders/test_render_1785200791697.mp4',
    allowedItems: ['skin-care-text', 'product-emoji', 'clean-background'],
    prohibitedItems: ['competitor-logo', 'extra-text', 'branding'],
    manualBaseline: '产品主图清晰，皮肤质感自然，无黑帧，无额外文字，9:16 比例，音画同步',
    provider: '星河中转（fixture）',
    model: 'Seedance 2.0 Fast（fixture）',
    version: '2.0.0',
    seed: 303,
    synthetic: true,
    provenance: {
      source: 'synthetic-fixture',
      note: '占位 fixture：URL 为真实工程目录中的路径，素材未入库前仅作引用；成本为估算，实际成本 unknown。',
      lastUpdated: '2026-08-04',
    },
    runsRequired: 3,
    promptVersion: DEFAULT_PROMPT_VERSION,
    cost: {
      id: 'cost-skincare-hero-7',
      scope: 'sample',
      sampleId: 'skincare-hero-7',
      provider: '星河中转（fixture）',
      model: 'Seedance 2.0 Fast（fixture）',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 303,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: DEFAULT_PROMPT_VERSION,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.15,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
  {
    id: 'skincare-hero-8',
    name: '合成护肤视频（fixture）',
    product: '绿泥洗面奶',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/uploads/renders/test_render_1785200951200.mp4',
    targetUrl: '/uploads/renders/test_render_1785200951200.mp4',
    allowedItems: ['skin-care-text', 'product-emoji', 'clean-background'],
    prohibitedItems: ['competitor-logo', 'extra-text', 'branding'],
    manualBaseline: '产品主图清晰，皮肤质感自然，无黑帧，无额外文字，9:16 比例，音画同步',
    provider: '星河中转（fixture）',
    model: 'Seedance 2.0 Fast（fixture）',
    version: '2.0.0',
    seed: 404,
    synthetic: true,
    provenance: {
      source: 'synthetic-fixture',
      note: '占位 fixture：URL 为真实工程目录中的路径，素材未入库前仅作引用；成本为估算，实际成本 unknown。',
      lastUpdated: '2026-08-04',
    },
    runsRequired: 3,
    promptVersion: DEFAULT_PROMPT_VERSION,
    cost: {
      id: 'cost-skincare-hero-8',
      scope: 'sample',
      sampleId: 'skincare-hero-8',
      provider: '星河中转（fixture）',
      model: 'Seedance 2.0 Fast（fixture）',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 404,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: DEFAULT_PROMPT_VERSION,
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.15,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
  // ==================== P3 真实黄金样例（真实素材，非 synthetic fixture） ====================

  /**
   * 真实样例 1：泡沫涂抹 Hook 段
   * 视频结构：极近特写面部 + 洁面泡沫涂抹（对应参考视频 0-25s 第一位博主段落）
   * 产品：BUV 小绿泥洁面（淡绿色软管 + "BUV" 标识）
   */
  {
    id: 'golden-real-hook-foam',
    name: 'BUV 小绿泥洁面 — 泡沫涂抹 Hook 段',
    product: 'BUV 小绿泥洁面',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/uploads/materials/mat_1785761660278_l27efzmt.mp4',
    referenceSegment: { startSec: 0, endSec: 25, description: '极近特写面部 + 双手涂白色泡沫于双颊，无产品包装露出' },
    knownAcceptableUrls: ['/uploads/renders/remote_072d4c85bcfe4477af052f7b9cfc69b5b0ab8fa3.mp4'],
    allowedItems: [
      'BUV 品牌产品',
      '绿色软管包装',
      '洁面泡沫涂抹',
      '面部特写',
      '自然光线',
      'UGC 真实感',
    ],
    prohibitedItems: [
      '竞品品牌标识',
      '非 BUV 产品包装',
      '夸大功效文字',
      '未备案广告语',
      '医疗效果声称',
      '竞品对比内容',
    ],
    manualBaseline:
      '1) 产品包装清晰可见且与参考产品图一致（绿色软管、BUV 标识）' +
      '2) 泡沫涂抹动作自然、与参考视频结构匹配（极近特写）' +
      '3) 无竞品标识残留' +
      '4) 无黑帧或严重畸变' +
      '5) 音画同步，节奏与参考一致' +
      '6) 字幕无违禁词',
    provider: '星河中转',
    model: 'Seedance 2.0 Fast',
    version: '2.0.0',
    seed: 3001,
    synthetic: false,
    provenance: {
      source: 'real',
      note: '真实 UGC 爆款视频（78s，3 位博主）的泡沫涂抹段落（0-25s），产品图真实存在于 /uploads/product-assets/，已知合格产物来自 remote_*.mp4 系列（真实 provider 生成）。',
      lastUpdated: '2026-08-05',
    },
    runsRequired: 1,
    promptVersion: 'v1.0.0 (P3 真实样例)',
    cost: {
      id: 'cost-golden-real-hook-foam',
      scope: 'sample',
      sampleId: 'golden-real-hook-foam',
      provider: '星河中转',
      model: 'Seedance 2.0 Fast',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 3001,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: 'v1.0.0 (P3 真实样例)',
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.10,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },

  /**
   * 真实样例 2：产品介绍 + 博主背书段
   * 视频结构：中景 + 手持产品展示 + 口播/字幕推荐（对应参考视频 25-50s 徐艺洋推荐段落）
   * 产品：BUV 小绿泥洁面
   */
  {
    id: 'golden-real-product-intro',
    name: 'BUV 小绿泥洁面 — 产品介绍背书段',
    product: 'BUV 小绿泥洁面',
    productAssetUrl: '/uploads/product-assets/pa_1785762184103_smhk1m.png',
    referenceUrl: '/uploads/materials/mat_1785761660278_l27efzmt.mp4',
    referenceSegment: { startSec: 25, endSec: 50, description: '中景，博主手持绿色产品管展示，口播推荐，黄色字幕"现在又升级了新版本"' },
    knownAcceptableUrls: ['/uploads/renders/remote_0b6cfee15d78aa72805300e5e20be741a0f8bb03.mp4'],
    allowedItems: [
      'BUV 品牌产品展示',
      '博主/人物口播推荐',
      '手持绿色软管',
      '中景构图',
      '字幕推荐文案',
    ],
    prohibitedItems: [
      '竞品品牌标识',
      '非 BUV 产品包装',
      '医疗效果声称',
      '虚假销量数据',
      '竞品对比贬低',
    ],
    manualBaseline:
      '1) 产品管在画面中清晰可见，颜色/形状与产品图一致' +
      '2) 人物手持产品动作自然' +
      '3) 构图与参考视频匹配（中景，非特写）' +
      '4) 无竞品标识' +
      '5) 字幕文案合规',
    provider: '星河中转',
    model: 'Seedance 2.0 Fast',
    version: '2.0.0',
    seed: 3002,
    synthetic: false,
    provenance: {
      source: 'real',
      note: '参考视频 25-50s 段落（徐艺洋推荐段），同一参考视频的不同视频结构段。',
      lastUpdated: '2026-08-05',
    },
    runsRequired: 1,
    promptVersion: 'v1.0.0 (P3 真实样例)',
    cost: {
      id: 'cost-golden-real-product-intro',
      scope: 'sample',
      sampleId: 'golden-real-product-intro',
      provider: '星河中转',
      model: 'Seedance 2.0 Fast',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 3002,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: 'v1.0.0 (P3 真实样例)',
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.10,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },

  /**
   * 真实样例 3：痛点展示 + 效果对比段
   * 视频结构：特写皮肤问题 → 效果展示（对应参考视频 50-78s 段落）
   * 产品：BUV 小绿泥洁面
   */
  {
    id: 'golden-real-result-showcase',
    name: 'BUV 小绿泥洁面 — 痛点效果展示段',
    product: 'BUV 小绿泥洁面',
    productAssetUrl: '/uploads/product-assets/pa_1785762173546_5rkfnl.png',
    referenceUrl: '/uploads/materials/mat_1785761660278_l27efzmt.mp4',
    referenceSegment: { startSec: 50, endSec: 78, description: '极近特写皮肤问题（闭口粉刺）→ 清洁后光滑肌肤效果对比' },
    knownAcceptableUrls: [],
    allowedItems: [
      '皮肤特写对比',
      'BUV 产品使用暗示',
      '效果展示（清洁前后）',
      '自然光线',
    ],
    prohibitedItems: [
      '竞品品牌标识',
      '医疗效果声称（祛痘/治疗）',
      'Before/After 虚假对比',
      '违禁功效词',
    ],
    manualBaseline:
      '1) 皮肤纹理真实自然，无 AI 畸变' +
      '2) 痛点展示与效果对比逻辑清晰' +
      '3) 无竞品标识' +
      '4) 文案无违禁功效词' +
      '5) 节奏与参考一致（痛点→效果）',
    provider: '星河中转',
    model: 'Seedance 2.0 Fast',
    version: '2.0.0',
    seed: 3003,
    synthetic: false,
    provenance: {
      source: 'real',
      note: '参考视频 50-78s 段落（闭口展示 + 效果），同一参考视频的第三种视频结构段。',
      lastUpdated: '2026-08-05',
    },
    runsRequired: 1,
    promptVersion: 'v1.0.0 (P3 真实样例)',
    cost: {
      id: 'cost-golden-real-result-showcase',
      scope: 'sample',
      sampleId: 'golden-real-result-showcase',
      provider: '星河中转',
      model: 'Seedance 2.0 Fast',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: 3003,
      queueMs: 'unknown',
      generationMs: 'unknown',
      promptVersion: 'v1.0.0 (P3 真实样例)',
      retries: 0,
      failureReason: null,
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: 0.10,
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: 0,
    },
    qaVersion: 'v1.0.0',
    gateVersion: 'v1.0.0',
    scorecardVersion: 'v1.0.0',
  },
];

export function loadGoldenSamples(): GoldenSample[] {
  return GOLDEN_SAMPLES;
}

/** 返回所有真实（非 synthetic）黄金样例 */
export function loadRealGoldenSamples(): GoldenSample[] {
  return GOLDEN_SAMPLES.filter((s) => !s.synthetic);
}

export function findGoldenSample(id: string): GoldenSample | undefined {
  return GOLDEN_SAMPLES.find((s) => s.id === id);
}

// ==================== P3 黄金样例运行记录 ====================

/**
 * 单次真实生成运行记录（P3 质量基线 §一）
 * 每次真实运行（至少 1 次/样例）记录：模型、耗时、成本、失败原因、人工评分。
 * 存储于 DB golden_runs 表。
 */
export interface GoldenRunRecord {
  id: string;
  sampleId: string;
  runIndex: number;
  /** 生成开始时间 */
  startedAt: number;
  /** 生成完成时间 */
  completedAt: number;
  /** 总耗时 ms */
  durationMs: number;
  provider: string;
  model: string;
  modelCode: string;
  /** 实际使用的 seed */
  seed: number;
  prompt: string;
  promptVersion: string;
  /** 生成结果产物 URL */
  artifactUrl: string | null;
  /** 产物状态 */
  artifactStatus: 'present' | 'missing' | 'unverified';
  /** 技术 QA 结果 */
  techQaStatus: 'verified' | 'unverified' | 'warning' | null;
  /** 语义 QA 总体判决 */
  semanticVerdict: 'pass' | 'warning' | 'fail' | 'unverified' | null;
  /** 语义 QA 报告 JSON（ShotSemanticQaReport） */
  semanticReportJson: string | null;
  /** 估算成本（micros） */
  estimatedCostMicros: number | null;
  /** 实际成本（micros），unknown 时为 null */
  actualCostMicros: number | null;
  /** 失败原因 */
  failureReason: string | null;
  /** 重试次数 */
  retryCount: number;
  /** 人工评分（0-1），null = 未评分 */
  humanScore: number | null;
  /** 人工评分说明 */
  humanComment: string | null;
  /** 评分人 */
  humanReviewer: string | null;
  /** git commit */
  gitCommit: string;
  owner_id: string;
}

export const GOLDEN_RUN_VERSION = 'v1.0.0';

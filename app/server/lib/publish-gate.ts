/**
 * Publish gate — pure scoring, no I/O.
 * completed/publishable requires pass when mock fallback is disabled.
 * S1: 支持语义质量、evidence、unverified 状态。
 */
export const GATE_VERSION = 'v1.0.0';

export interface PublishGateInput {
  videoUrl?: string | null;
  source?: string | null;
  durationSec?: number | null;
  resolution?: string | null;
  aspectRatio?: string | null;
  hasSubtitles?: boolean;
  hasAudio?: boolean;
  isMockFallback?: boolean;
  allowMockFallback?: boolean;
  complianceWarnings?: Array<{ word?: string } | string> | null;
  narrativeBeatsPresent?: boolean;
  firstFrameSource?: string | null;
  clipCount?: number;
  qaReport?: any; // ShotQaResult
  evidence?: Record<string, any>;
}

export interface PublishReport {
  passed: boolean;
  scores: {
    productIdentity: number;
    structureCoverage: number;
    technical: number;
    compliance: number;
    semantic: number; // 新增 S1 语义质量
  };
  blockers: string[];
  warnings: string[];
  /** S1：每个 blocker 的证据来源（发布页必须解释证据，不能只显示总分） */
  blockerEvidence: Record<string, GateEvidence>;
  /** S1：每个 warning 的证据来源 */
  warningEvidence: Record<string, GateEvidence>;
  status: 'passed' | 'needs_review' | 'failed' | 'unverified';
  finalVideoUrl?: string;
  evidence?: Record<string, any>;
  scorerVersion: string;
}

/** blocker/warning 证据条目：code、证据来源、可读解释、关联产物 */
export interface GateEvidence {
  code: string;
  source: string;
  detail: string;
  artifact?: string;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 每个 gate 判断码的固定解释（发布页展示用） */
export const GATE_EXPLANATIONS: Record<string, string> = {
  mock_result_not_publishable: '产物来自 mock provider 且未授权 mock 兜底，不能作为真实成片发布',
  mock_result_demo_only: '产物来自 mock provider，仅作演示，正式发布前必须用真实 provider 重新生成',
  compliance_warnings_present: '拆解/文案阶段存在合规警示词（如违禁词），成片存在合规风险',
  missing_video_url: '没有可引用的视频产物 URL，成片缺失',
  duration_below_12s: '成片时长低于 12s（低于平台常见最低时长）',
  duration_above_35s_budget: '成片时长超过 35s 预算，可能超出模型时长分组预算',
  duration_unknown: '成片时长未知（未能探测），无法确认时长质量',
  resolution_unverified: '分辨率/比例无法验证（声明缺失或格式不支持）',
  final_first_frame_is_viral_not_product: '成片首帧来自爆款原片而非产品，未完成产品替换',
  first_frame_source_unspecified: '未声明首帧来源或首帧来源证据不可信（S0 起不接受无证据声明）',
  qa_unverified: '镜头质检未验证（远端产物或探测失败），不能默认合格',
  semantic_unverified: '语义质量未经任何评分器测量',
  technical_score_too_low: '技术质量分低于硬门禁，禁止发布',
  qa_warning: '镜头质检存在未通过项，进入人工复核',
};

/**
 * Evaluate whether a composed video is publishable.
 * S1 增强：支持语义质量、evidence、unverified 状态、firstFrameSource 必须有真实 evidence，
 * 每个 blocker/warning 携带证据来源（source/detail），发布页可解释而非只显示总分。
 */
export function evaluatePublishGate(input: PublishGateInput): PublishReport {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const blockerEvidence: Record<string, GateEvidence> = {};
  const warningEvidence: Record<string, GateEvidence> = {};
  const evidence: Record<string, any> = {};

  const source = String(input.source || '').toLowerCase();
  const isMock =
    Boolean(input.isMockFallback) ||
    source === 'mock' ||
    source.includes('mock');

  const allowMock = Boolean(input.allowMockFallback);
  const videoUrl = input.videoUrl ? String(input.videoUrl).trim() : '';
  const duration = Number(input.durationSec || 0);
  const resolution = String(input.resolution || '');
  let firstFrameSource = String(input.firstFrameSource || '');

  /** 登记 blocker 及其证据来源 */
  const addBlocker = (code: string, detailSource: string) => {
    if (!blockers.includes(code)) {
      blockers.push(code);
      blockerEvidence[code] = {
        code,
        source: detailSource,
        detail: GATE_EXPLANATIONS[code] || code,
        artifact: videoUrl || undefined,
      };
    }
  };
  const addWarning = (code: string, detailSource: string) => {
    if (!warnings.includes(code)) {
      warnings.push(code);
      warningEvidence[code] = {
        code,
        source: detailSource,
        detail: GATE_EXPLANATIONS[code] || code,
        artifact: videoUrl || undefined,
      };
    }
  };

  // --- Evidence from input ---
  evidence.input = { firstFrameSource, videoUrl, duration, resolution };
  evidence.firstFrameEvidenceUrl = input.evidence?.firstFrameEvidenceUrl || undefined;

  // --- Compliance ---
  let compliance = 1;
  if (isMock && !allowMock) {
    addBlocker('mock_result_not_publishable', `input.source=${input.source || 'mock'} / isMockFallback=${input.isMockFallback}`);
    compliance = 0;
  } else if (isMock && allowMock) {
    addWarning('mock_result_demo_only', `input.source=${input.source || 'mock'} / allowMockFallback=true`);
    compliance = 0.3;
  }

  const warningsList = Array.isArray(input.complianceWarnings)
    ? input.complianceWarnings
    : [];
  if (warningsList.length > 0) {
    compliance = Math.min(compliance, 0.4);
    addWarning('compliance_warnings_present', `input.complianceWarnings=${JSON.stringify(warningsList.slice(0, 5))}`);
  }

  // --- Technical ---
  let technical = 1;
  if (!videoUrl) {
    addBlocker('missing_video_url', 'input.videoUrl 为空');
    technical = 0;
  }
  if (duration > 0 && duration < 12) {
    addWarning('duration_below_12s', `input.durationSec=${duration}`);
    technical = Math.min(technical, 0.55);
  }
  if (duration > 0 && duration > 35) {
    addWarning('duration_above_35s_budget', `input.durationSec=${duration}`);
  }
  if (!duration || duration <= 0) {
    technical = Math.min(technical, 0.5);
    addWarning('duration_unknown', 'input.durationSec 缺失或为 0');
  }

  const resOk =
    /1080\s*[x×]\s*1920|1920\s*[x×]\s*1080|720\s*[x×]\s*1280|9:16/i.test(
      resolution + ' ' + String(input.aspectRatio || '')
    ) || Boolean(resolution);
  if (!resOk && videoUrl) {
    technical = Math.min(technical, 0.6);
    addWarning('resolution_unverified', `input.resolution=${resolution} / aspectRatio=${input.aspectRatio}`);
  }

  // --- Product identity ---
  let productIdentity = 0.55;
  let productIdentityEvidence = {};
  if (firstFrameSource === 'product_conditioned') {
    // S0 起：值只能由服务端 provenance 解析而来（resolveFirstFrameSource），
    // 客户端裸声明不会到达这里；evidence.firstFrameEvidenceUrl 为服务端校验通过的证据 URL。
    const trustedEvidenceUrl = String(input.evidence?.firstFrameEvidenceUrl || '');
    if (trustedEvidenceUrl) {
      productIdentity = 0.85;
      productIdentityEvidence = { firstFrameSource: 'product_conditioned', firstFrameEvidenceUrl: trustedEvidenceUrl };
    } else {
      // 声明存在但证据 URL 未传（防御性降级，不给假确定性）
      productIdentity = 0.7;
      productIdentityEvidence = { firstFrameSource: 'product_conditioned', warning: 'evidence_url_missing_server_side' };
      addWarning('first_frame_source_unspecified', '声明 product_conditioned 但服务端证据 URL 缺失');
    }
  } else if (firstFrameSource === 'viral_media' || firstFrameSource === 'viral_keyframe') {
    productIdentity = 0.2;
    addBlocker('final_first_frame_is_viral_not_product', `input.firstFrameSource=${firstFrameSource}`);
    productIdentityEvidence = { firstFrameSource: firstFrameSource, warning: 'viral_first_frame' };
  } else if (!firstFrameSource) {
    // Legacy: warning only, no hard fail, but unverified
    productIdentity = 0.55;
    addWarning('first_frame_source_unspecified', 'input.firstFrameSource 为空（未声明或证据不可信被 S0 provenance 解析丢弃）');
    productIdentityEvidence = { firstFrameSource: 'unspecified' };
    firstFrameSource = ''; // force unverified path
  } else {
    productIdentityEvidence = { firstFrameSource: firstFrameSource };
  }

  // --- Structure coverage ---
  let structureCoverage = input.narrativeBeatsPresent ? 0.8 : 0.55;
  if ((input.clipCount || 0) >= 3) {
    structureCoverage = Math.max(structureCoverage, 0.75);
  }

  // --- Semantic score (S1) ---
  let semantic = 0.6;
  if (input.qaReport && input.qaReport.status === 'verified') {
    semantic = 0.85;
  } else if (input.qaReport && input.qaReport.status === 'unverified') {
    semantic = 0.4;
    addWarning('qa_unverified', `qaReport.status=unverified（reason=${input.qaReport.reason || 'unknown'}）`);
  } else if (input.qaReport && input.qaReport.status === 'warning') {
    semantic = 0.5;
    addWarning('qa_warning', `qaReport.status=warning（reason=${input.qaReport.reason || 'unknown'}）`);
  } else {
    semantic = 0.55;
    addWarning('semantic_unverified', '未提供 qaReport（没有可验证的语义测量）');
  }

  const scores = {
    productIdentity: clamp01(productIdentity),
    structureCoverage: clamp01(structureCoverage),
    technical: clamp01(technical),
    compliance: clamp01(compliance),
    semantic: clamp01(semantic),
  };

  // Hard fail: only explicit viral first-frame or missing technical essentials
  if (scores.technical < 0.4) {
    if (!blockers.includes('missing_video_url')) addBlocker('technical_score_too_low', `scores.technical=${scores.technical.toFixed(2)}`);
  }

  const passed = blockers.length === 0 && scores.compliance >= 0.5 && scores.technical >= 0.4;

  let status: PublishReport['status'] = 'passed';
  if (!passed) {
    status =
      blockers.includes('missing_video_url') || blockers.includes('mock_result_not_publishable') || firstFrameSource === ''
        ? 'failed'
        : 'needs_review';
  } else if (input.qaReport && input.qaReport.status === 'unverified') {
    status = 'unverified';
  }

  return {
    passed,
    scores,
    blockers,
    warnings,
    blockerEvidence,
    warningEvidence,
    finalVideoUrl: videoUrl || undefined,
    status,
    evidence,
    scorerVersion: GATE_VERSION || 'v1.0.0',
  };
}

/**
 * Whether orchestrator may mark run as completed given gate result.
 * P0 契约修复：unverified 产物不得进入 completed —— 必须 passed 与 status==='passed'
 * 同时成立。evaluatePublishGate 在 QA 未验证时会返回 { passed: true, status: 'unverified' }，
 * 仅查 passed 会让未验证产物被标记为 completed（S0/S1 状态契约违反）。
 */
export function gateAllowsCompleted(
  report: PublishReport,
  allowMockFallback: boolean
): boolean {
  if (report.passed && report.status === 'passed') return true;
  return false;
}

/**
 * S0 provenance：product_conditioned 声明必须携带真实证据（实际用作首帧的产品图 URL）。
 * 仅有声明而无证据（例如拿爆款原片直接渲染）时降级为 undefined ——
 * 发布门禁对未声明只给 warning，不给「产品一致 0.85」的假确定性加分。
 */
export function resolveFirstFrameSource(
  claimed: string | null | undefined,
  evidenceUrls: Array<string | null | undefined>
): string | undefined {
  if (claimed !== 'product_conditioned') return claimed || undefined;
  const hasEvidence = evidenceUrls.some((url) => Boolean(url && String(url).trim()));
  return hasEvidence ? 'product_conditioned' : undefined;
}

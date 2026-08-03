/**
 * Publish gate — pure scoring, no I/O.
 * completed/publishable requires pass when mock fallback is disabled.
 */

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
}

export interface PublishReport {
  passed: boolean;
  scores: {
    productIdentity: number;
    structureCoverage: number;
    technical: number;
    compliance: number;
  };
  blockers: string[];
  warnings: string[];
  finalVideoUrl?: string;
  status: 'passed' | 'needs_review' | 'failed';
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Evaluate whether a composed video is publishable.
 */
export function evaluatePublishGate(input: PublishGateInput): PublishReport {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const source = String(input.source || '').toLowerCase();
  const isMock =
    Boolean(input.isMockFallback) ||
    source === 'mock' ||
    source.includes('mock');

  const allowMock = Boolean(input.allowMockFallback);
  const videoUrl = input.videoUrl ? String(input.videoUrl).trim() : '';
  const duration = Number(input.durationSec || 0);
  const resolution = String(input.resolution || '');
  const firstFrameSource = String(input.firstFrameSource || '');

  // --- Compliance ---
  let compliance = 1;
  if (isMock && !allowMock) {
    blockers.push('mock_result_not_publishable');
    compliance = 0;
  } else if (isMock && allowMock) {
    warnings.push('mock_result_demo_only');
    compliance = 0.3;
  }

  const warningsList = Array.isArray(input.complianceWarnings)
    ? input.complianceWarnings
    : [];
  if (warningsList.length > 0) {
    compliance = Math.min(compliance, 0.4);
    warnings.push('compliance_warnings_present');
  }

  // --- Technical ---
  let technical = 1;
  if (!videoUrl) {
    blockers.push('missing_video_url');
    technical = 0;
  }
  if (duration > 0 && duration < 12) {
    warnings.push('duration_below_12s');
    technical = Math.min(technical, 0.55);
  }
  if (duration > 0 && duration > 35) {
    warnings.push('duration_above_35s_budget');
  }
  if (!duration || duration <= 0) {
    technical = Math.min(technical, 0.5);
    warnings.push('duration_unknown');
  }

  const resOk =
    /1080\s*[x×]\s*1920|1920\s*[x×]\s*1080|720\s*[x×]\s*1280|9:16/i.test(
      resolution + ' ' + String(input.aspectRatio || '')
    ) || Boolean(resolution);
  if (!resOk && videoUrl) {
    technical = Math.min(technical, 0.6);
    warnings.push('resolution_unverified');
  }

  // --- Product identity ---
  let productIdentity = 0.55;
  if (firstFrameSource === 'product_conditioned') {
    productIdentity = 0.85;
  } else if (firstFrameSource === 'viral_media' || firstFrameSource === 'viral_keyframe') {
    productIdentity = 0.2;
    blockers.push('final_first_frame_is_viral_not_product');
  } else if (!firstFrameSource) {
    // Legacy single-image path: warning only, do not hard-fail
    productIdentity = 0.55;
    warnings.push('first_frame_source_unspecified');
  }

  // --- Structure coverage ---
  let structureCoverage = input.narrativeBeatsPresent ? 0.8 : 0.55;
  if ((input.clipCount || 0) >= 3) {
    structureCoverage = Math.max(structureCoverage, 0.75);
  }

  const scores = {
    productIdentity: clamp01(productIdentity),
    structureCoverage: clamp01(structureCoverage),
    technical: clamp01(technical),
    compliance: clamp01(compliance),
  };

  // Hard fail: only explicit viral first-frame or missing technical essentials
  if (scores.technical < 0.4) {
    if (!blockers.includes('missing_video_url')) blockers.push('technical_score_too_low');
  }


  const passed = blockers.length === 0 && scores.compliance >= 0.5 && scores.technical >= 0.4;

  let status: PublishReport['status'] = 'passed';
  if (!passed) {
    status =
      blockers.includes('missing_video_url') || blockers.includes('mock_result_not_publishable')
        ? 'failed'
        : 'needs_review';
  }

  return {
    passed,
    scores,
    blockers,
    warnings,
    finalVideoUrl: videoUrl || undefined,
    status,
  };
}

/** Whether orchestrator may mark run as completed given gate result */
export function gateAllowsCompleted(
  report: PublishReport,
  allowMockFallback: boolean
): boolean {
  if (report.passed) return true;
  // Even with mock allowed, mock is never "completed" as publishable — mark needs_review path
  if (allowMockFallback && report.warnings.includes('mock_result_demo_only')) {
    return false;
  }
  return false;
}

/**
 * FullVideoTimelineComposer
 *
 * A deep, pure module between a narrative plan and FFmpeg.  Callers provide
 * only a validated FullVideoPlan and the real duration of each generated
 * artifact.  The composer owns trimming limits, transition choices, timeline
 * math, and the conditions under which a set of clips is good enough to call
 * a complete demo rather than a raw concat.
 *
 * It deliberately has no provider, database, filesystem, or FFmpeg dependency.
 */

import type { FullVideoPlan, NarrativeBeat } from './full-video-plan';
import { getVisualSeam, type VisualContinuityPackage } from './visual-continuity';

export type VisualTransitionKind = 'match_cut' | 'dissolve' | 'fade';

export interface GeneratedVideoArtifactTiming {
  /** Stable plan order. Provider task ids are intentionally not used here. */
  shotIndex: number;
  videoUrl: string;
  /** Real ffprobe duration, never a caller-side estimate. */
  durationSec: number;
}

export interface TimelineClip {
  shotId: string;
  shotIndex: number;
  beat: NarrativeBeat;
  videoUrl: string;
  sourceDurationSec: number;
  /** Portion of the source clip that reaches the final film. */
  renderDurationSec: number;
  plannedDurationSec: number;
  timelineStartSec: number;
  timelineEndSec: number;
  continuityGroup: string;
}

export interface TimelineTransition {
  fromShotId: string;
  toShotId: string;
  kind: VisualTransitionKind;
  durationSec: number;
  reason: string;
}

export interface FullVideoTimeline {
  version: 'v1';
  targetDurationSec: number;
  expectedDurationSec: number;
  clips: TimelineClip[];
  transitions: TimelineTransition[];
  warnings: string[];
}

export interface ComposeFullVideoTimelineInput {
  plan: FullVideoPlan;
  artifacts: GeneratedVideoArtifactTiming[];
  /** Reject a source that would throw away more than this much generated video. */
  maxTrimSec?: number;
  /** A short clip beyond this tolerance is too weak to carry its narrative beat. */
  maxShortfallSec?: number;
}

export class FullVideoTimelineError extends Error {
  readonly code = 'full_video_timeline_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FullVideoTimelineError';
  }
}

const MIN_USABLE_CLIP_SEC = 2.5;
const DEFAULT_MAX_TRIM_SEC = 0.8;
const DEFAULT_MAX_SHORTFALL_SEC = 0.8;

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function plannedDurationSec(shot: FullVideoPlan['shots'][number]): number {
  return rounded((shot.targetEndMs - shot.targetStartMs) / 1000);
}

function hasFinitePositiveDuration(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function transitionFor(
  previous: FullVideoPlan['shots'][number],
  next: FullVideoPlan['shots'][number],
  visualContinuity?: VisualContinuityPackage
): Omit<TimelineTransition, 'fromShotId' | 'toShotId'> {
  const declaredSeam = getVisualSeam(visualContinuity, previous.shotIndex, next.shotIndex);
  if (declaredSeam) {
    const durationSec = declaredSeam.strategy === 'fade'
      ? 0.24
      : declaredSeam.strategy === 'dissolve'
        ? 0.18
        : 0;
    return {
      kind: declaredSeam.strategy,
      durationSec,
      reason: `visual continuity seam ${previous.shotIndex}->${next.shotIndex}: ${declaredSeam.sharedAnchors.slice(-1)[0]}`,
    };
  }
  if (previous.continuityGroup !== next.continuityGroup) {
    return {
      kind: 'fade',
      durationSec: 0.24,
      reason: 'the continuity group changes, so a short fade avoids a false visual match',
    };
  }

  if (previous.beat === 'proof' && (next.beat === 'benefit' || next.beat === 'cta')) {
    return {
      kind: 'dissolve',
      durationSec: 0.18,
      reason: 'move from observed proof into the resulting benefit without a decorative cut',
    };
  }

  if (previous.beat === 'benefit' && next.beat === 'cta') {
    return {
      kind: 'dissolve',
      durationSec: 0.16,
      reason: 'settle the benefit into the final product hold',
    };
  }

  return {
    kind: 'match_cut',
    durationSec: 0,
    reason: 'shared set, product, light, and narrative handoff require a direct match cut',
  };
}

/**
 * Derive a real, executable visual timeline.  It refuses missing/unplanned
 * clips and rejects durations which would otherwise be hidden by a synthetic
 * `clipCount * N` estimate.
 */
export function composeFullVideoTimeline(input: ComposeFullVideoTimelineInput): FullVideoTimeline {
  const maxTrimSec = input.maxTrimSec ?? DEFAULT_MAX_TRIM_SEC;
  const maxShortfallSec = input.maxShortfallSec ?? DEFAULT_MAX_SHORTFALL_SEC;
  const planShots = input.plan.shots;
  const artifactsByIndex = new Map<number, GeneratedVideoArtifactTiming>();

  for (const artifact of input.artifacts) {
    if (!Number.isInteger(artifact.shotIndex) || artifact.shotIndex < 1) {
      throw new FullVideoTimelineError(`artifact has an invalid shotIndex: ${artifact.shotIndex}`);
    }
    if (!artifact.videoUrl) {
      throw new FullVideoTimelineError(`shot ${artifact.shotIndex} has no video URL`);
    }
    if (!hasFinitePositiveDuration(artifact.durationSec)) {
      throw new FullVideoTimelineError(`shot ${artifact.shotIndex} has no real ffprobe duration`);
    }
    if (artifactsByIndex.has(artifact.shotIndex)) {
      throw new FullVideoTimelineError(`shot ${artifact.shotIndex} has duplicate generated artifacts`);
    }
    artifactsByIndex.set(artifact.shotIndex, artifact);
  }

  const plannedIndexes = new Set(planShots.map((shot) => shot.shotIndex));
  const unexpected = [...artifactsByIndex.keys()].filter((shotIndex) => !plannedIndexes.has(shotIndex));
  if (unexpected.length > 0) {
    throw new FullVideoTimelineError(`generated artifacts are outside the approved plan: ${unexpected.join(', ')}`);
  }
  const missing = planShots.filter((shot) => !artifactsByIndex.has(shot.shotIndex));
  if (missing.length > 0) {
    throw new FullVideoTimelineError(`approved plan is missing generated shots: ${missing.map((shot) => shot.shotIndex).join(', ')}`);
  }

  const warnings: string[] = [];
  const clips: TimelineClip[] = [];
  let cursorSec = 0;

  for (const shot of planShots) {
    const artifact = artifactsByIndex.get(shot.shotIndex)!;
    const plannedSec = plannedDurationSec(shot);
    const sourceSec = rounded(artifact.durationSec);
    if (sourceSec < MIN_USABLE_CLIP_SEC) {
      throw new FullVideoTimelineError(
        `shot ${shot.shotIndex} is only ${sourceSec}s; it cannot carry a meaningful narrative beat`
      );
    }
    const trimSec = Math.max(0, sourceSec - plannedSec);
    if (trimSec > maxTrimSec) {
      throw new FullVideoTimelineError(
        `shot ${shot.shotIndex} is ${sourceSec}s for a ${plannedSec}s plan slot; refusing to discard ${rounded(trimSec)}s of generated action`
      );
    }
    const shortfallSec = Math.max(0, plannedSec - sourceSec);
    if (shortfallSec > maxShortfallSec) {
      throw new FullVideoTimelineError(
        `shot ${shot.shotIndex} is ${sourceSec}s for a ${plannedSec}s plan slot; regenerate instead of padding ${rounded(shortfallSec)}s of static video`
      );
    }
    if (shortfallSec > 0) {
      warnings.push(`shot ${shot.shotIndex} is ${rounded(shortfallSec)}s shorter than planned; the final duration follows the real artifact`);
    }

    const renderSec = rounded(Math.min(sourceSec, plannedSec));
    clips.push({
      shotId: shot.shotId,
      shotIndex: shot.shotIndex,
      beat: shot.beat,
      videoUrl: artifact.videoUrl,
      sourceDurationSec: sourceSec,
      renderDurationSec: renderSec,
      plannedDurationSec: plannedSec,
      timelineStartSec: rounded(cursorSec),
      timelineEndSec: rounded(cursorSec + renderSec),
      continuityGroup: shot.continuityGroup,
    });
    cursorSec += renderSec;
  }

  const transitions: TimelineTransition[] = [];
  for (let index = 1; index < clips.length; index += 1) {
    const previousClip = clips[index - 1];
    const nextClip = clips[index];
    const desired = transitionFor(planShots[index - 1], planShots[index], input.plan.visualContinuity);
    const safeDurationSec = Math.min(
      desired.durationSec,
      Math.max(0, previousClip.renderDurationSec - 0.5),
      Math.max(0, nextClip.renderDurationSec - 0.5)
    );
    const durationSec = rounded(safeDurationSec);
    transitions.push({
      fromShotId: previousClip.shotId,
      toShotId: nextClip.shotId,
      kind: durationSec > 0 ? desired.kind : 'match_cut',
      durationSec,
      reason: desired.reason,
    });
    if (durationSec > 0) {
      nextClip.timelineStartSec = rounded(nextClip.timelineStartSec - durationSec);
      nextClip.timelineEndSec = rounded(nextClip.timelineEndSec - durationSec);
      cursorSec -= durationSec;
      for (let later = index + 1; later < clips.length; later += 1) {
        clips[later].timelineStartSec = rounded(clips[later].timelineStartSec - durationSec);
        clips[later].timelineEndSec = rounded(clips[later].timelineEndSec - durationSec);
      }
    }
  }

  const expectedDurationSec = rounded(cursorSec);
  if (expectedDurationSec < 25 || expectedDurationSec > 35) {
    throw new FullVideoTimelineError(
      `real composed duration ${expectedDurationSec}s is outside the 25-35s demo target; do not hide it with synthetic padding or truncation`
    );
  }

  return {
    version: 'v1',
    targetDurationSec: input.plan.targetDurationSec,
    expectedDurationSec,
    clips,
    transitions,
    warnings,
  };
}

/** Deterministic verifier shared by routes, renderer, and tests. */
export function validateFullVideoTimeline(timeline: FullVideoTimeline): string[] {
  const errors: string[] = [];
  if (timeline.version !== 'v1') errors.push('unsupported timeline version');
  if (timeline.clips.length < 6 || timeline.clips.length > 8) {
    errors.push('complete demo timeline must contain 6-8 clips');
  }
  if (timeline.transitions.length !== Math.max(0, timeline.clips.length - 1)) {
    errors.push('timeline transition count does not match clip boundaries');
  }
  let expected = 0;
  for (let index = 0; index < timeline.clips.length; index += 1) {
    const clip = timeline.clips[index];
    if (clip.shotIndex !== index + 1) errors.push(`timeline shot index ${index + 1} is not stable`);
    if (!hasFinitePositiveDuration(clip.sourceDurationSec) || !hasFinitePositiveDuration(clip.renderDurationSec)) {
      errors.push(`timeline shot ${clip.shotIndex} has an invalid real duration`);
    }
    if (clip.renderDurationSec - clip.sourceDurationSec > 0.001) {
      errors.push(`timeline shot ${clip.shotIndex} pads beyond the source duration`);
    }
    if (Math.abs(clip.timelineStartSec - expected) > 0.01) {
      errors.push(`timeline shot ${clip.shotIndex} starts at ${clip.timelineStartSec}s but expected ${rounded(expected)}s`);
    }
    expected += clip.renderDurationSec;
    const transition = timeline.transitions[index];
    if (transition) {
      if (transition.fromShotId !== clip.shotId || transition.toShotId !== timeline.clips[index + 1]?.shotId) {
        errors.push(`timeline transition ${index + 1} does not connect adjacent planned shots`);
      }
      if (transition.durationSec < 0 || transition.durationSec >= clip.renderDurationSec) {
        errors.push(`timeline transition ${index + 1} has an invalid duration`);
      }
      expected -= transition.durationSec;
    }
  }
  if (Math.abs(expected - timeline.expectedDurationSec) > 0.01) {
    errors.push(`timeline duration ${timeline.expectedDurationSec}s does not match its clips (${rounded(expected)}s)`);
  }
  if (timeline.expectedDurationSec < 25 || timeline.expectedDurationSec > 35) {
    errors.push('timeline duration is outside the 25-35s demo target');
  }
  return errors;
}

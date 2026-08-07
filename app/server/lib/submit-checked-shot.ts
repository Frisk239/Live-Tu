/**
 * The only paid video-submission boundary.
 *
 * Callers may identify a shot, but may not supply URLs or a provider payload.
 * This service claims the row first, optionally prepares its first frame while
 * holding that claim, reloads the row, verifies provenance + visual safety, and
 * then performs exactly one provider call.
 */
import { db } from './db';
import { resolveTrustedAssetKind } from './shot-first-frame';
import { requireVisualSafetyPass } from './visual-safety';
import {
  type VideoSubmissionPort,
  type SubmittedShotTask,
} from './video-submission-port';
import {
  type DeclaredReferenceImage,
  assertReferenceImagesAllowed,
} from '../adapters/reference-policy-guard';
import { ReferencePolicyViolationError } from '../domain/reference-policy/reference-input-policy';

export interface ClaimAndSubmitInput {
  ownerId: string;
  sessionId: string;
  shotId: string;
  modelCode?: string;
  attempt?: number;
  failureReason?: string | null;
  /** Runs only after this service has atomically claimed the shot. */
  prepareFirstFrame?: () => Promise<void>;
}

export interface ClaimAndSubmitResult {
  task: SubmittedShotTask;
  firstFrameUrl: string | null;
  firstFrameKind: 'generated_frame' | 'product_shot' | 'owned_scene_anchor';
  referenceMaterialsCount: number;
  /** True means an already-submitted task was returned; no provider call happened. */
  idempotent: boolean;
}

interface CheckedShot {
  id: string;
  session_id: string;
  owner_id: string;
  shot_index: number;
  status: string;
  video_prompt: string | null;
  first_frame_url: string | null;
  error_message: string | null;
  seedance_task_id: string | null;
}

export class SubmitConflictError extends Error {
  readonly code = 'submit_conflict' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SubmitConflictError';
  }
}

function loadShot(shotId: string, ownerId: string): CheckedShot | undefined {
  return db.prepare(
    `SELECT id, session_id, owner_id, shot_index, status, video_prompt,
            first_frame_url, error_message, seedance_task_id
       FROM shot_generation_tasks
      WHERE id = ? AND owner_id = ?`
  ).get(shotId, ownerId) as unknown as CheckedShot | undefined;
}

function trustedDeclaration(ownerId: string, url: string, label: string): DeclaredReferenceImage {
  const kind = resolveTrustedAssetKind(ownerId, url);
  if (!kind) {
    throw new ReferencePolicyViolationError(
      'source_keyframe_to_provider',
      `${label} (${url.slice(0, 120)}) is not a server-verified owned asset`
    );
  }
  return { id: `${label}-${url}`, url, kind };
}

function idempotentResult(shot: CheckedShot): ClaimAndSubmitResult | null {
  if (!shot.seedance_task_id || shot.status === 'failed') return null;
  return {
    task: {
      taskId: shot.seedance_task_id,
      status: shot.status === 'completed' ? 'completed' : 'generating',
      provider: 'seedance-relay',
    },
    firstFrameUrl: shot.first_frame_url,
    firstFrameKind: 'generated_frame',
    referenceMaterialsCount: 0,
    idempotent: true,
  };
}

function failClaim(shotId: string, message: string): void {
  db.prepare(
    `UPDATE shot_generation_tasks
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'submitting'`
  ).run(message.slice(0, 1000), shotId);
}

export async function claimAndSubmitCheckedShot(
  port: VideoSubmissionPort,
  input: ClaimAndSubmitInput
): Promise<ClaimAndSubmitResult> {
  const { ownerId, sessionId, shotId } = input;
  const initial = loadShot(shotId, ownerId);
  if (!initial) {
    throw new ReferencePolicyViolationError(
      'source_keyframe_to_provider',
      `shot ${shotId} does not belong to the current owner`
    );
  }
  if (initial.session_id !== sessionId) {
    throw new ReferencePolicyViolationError(
      'source_keyframe_to_provider',
      `shot ${shotId} does not belong to session ${sessionId}`
    );
  }
  const prior = idempotentResult(initial);
  if (prior) return prior;

  const claim = db.prepare(
    `UPDATE shot_generation_tasks SET status = 'submitting', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_id = ? AND status IN ('pending', 'failed')`
  ).run(shotId, ownerId);
  if (claim.changes === 0) {
    const current = loadShot(shotId, ownerId);
    const idempotent = current ? idempotentResult(current) : null;
    if (idempotent) return idempotent;
    throw new SubmitConflictError(
      `shot ${shotId} is already being submitted (status=${current?.status ?? 'unknown'})`
    );
  }

  try {
    await input.prepareFirstFrame?.();

    const shot = loadShot(shotId, ownerId);
    if (!shot || shot.session_id !== sessionId) {
      throw new ReferencePolicyViolationError(
        'source_keyframe_to_provider',
        `shot ${shotId} changed ownership while being prepared`
      );
    }
    if (shot.status !== 'submitting') {
      throw new SubmitConflictError(
        `shot ${shotId} left the submission claim while being prepared (status=${shot.status})`
      );
    }
    if (!shot.first_frame_url) {
      throw new ReferencePolicyViolationError(
        'source_keyframe_to_provider',
        `shot ${shotId} has no verified first frame`
      );
    }

    const firstFrame = trustedDeclaration(ownerId, shot.first_frame_url, 'first-frame');
    if (firstFrame.kind !== 'generated_frame') {
      throw new ReferencePolicyViolationError(
        'source_keyframe_to_provider',
        'the paid video provider only accepts a verified product-conditioned first frame'
      );
    }
    requireVisualSafetyPass(ownerId, firstFrame.url, 'first-frame');
    assertReferenceImagesAllowed([firstFrame], { mode: 'semantic_recreation' });

    const task = await port.submitShot({
      shotId: String(shot.id),
      runId: sessionId,
      ownerId,
      sessionId,
      shotIndex: Number(shot.shot_index),
      prompt: shot.video_prompt || 'product close-up, smooth cinematic motion, high detail',
      modelCode: input.modelCode || 'doubao-seedance-2-0-fast',
      modelCatalogId: 'Seedance 2.0 Fast',
      durationSec: 5,
      resolution: '720p',
      aspectRatio: '9:16',
      imageUrl: firstFrame.url,
      firstFrameKind: firstFrame.kind as ClaimAndSubmitResult['firstFrameKind'],
      referenceImageUrls: [],
      referencePolicy: { mode: 'semantic_recreation', images: [] },
      attempt: input.attempt ?? 1,
      failureReason: input.failureReason ?? shot.error_message,
    });

    const status = task.status === 'completed' ? 'completed' : 'generating';
    db.prepare(
      `UPDATE shot_generation_tasks
          SET status = ?, seedance_task_id = ?, video_url = ?, error_message = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'submitting'`
    ).run(status, task.taskId, task.url || null, shotId);

    return {
      task,
      firstFrameUrl: firstFrame.url,
      firstFrameKind: firstFrame.kind as ClaimAndSubmitResult['firstFrameKind'],
      referenceMaterialsCount: 0,
      idempotent: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as any)?.code === 'string' ? `${(error as any).code}: ` : '';
    failClaim(shotId, `${code}${message}`);
    throw error;
  }
}

export const submitCheckedShot = claimAndSubmitCheckedShot;

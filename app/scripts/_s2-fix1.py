# -*- coding: utf-8 -*-
import io

p = 'server/lib/workflow-controller.ts'
s = open(p, encoding='utf-8').read()

# ============ 1) DraftPayload + helpers ============
old = """interface DraftPayload {
  shots?: ShotPlanShot[];
  videoModelId?: string;
  referenceInputCount?: number;
}"""
new = """interface DraftPayload {
  shots?: ShotPlanShot[];
  videoModelId?: string;
  /** 客户端写入的参考输入数量只作展示提示；预检实际数量由服务端按 productId 真实计算（Spec 修复） */
  referenceInputCount?: number;
  productId?: string | null;
}"""
assert old in s, 'DraftPayload'
s = s.replace(old, new)

old = """  private draftVideoModelIdOf(draftJson: string | null | undefined): string | null {
    if (!draftJson) return null;
    try {
      const parsed = JSON.parse(draftJson) as { videoModelId?: string };
      return typeof parsed.videoModelId === 'string' ? parsed.videoModelId : null;
    } catch {
      return null;
    }
  }"""
new = """  private draftVideoModelIdOf(draftJson: string | null | undefined): string | null {
    if (!draftJson) return null;
    try {
      const parsed = JSON.parse(draftJson) as { videoModelId?: string };
      return typeof parsed.videoModelId === 'string' ? parsed.videoModelId : null;
    } catch {
      return null;
    }
  }

  private parseDraft(draftJson: string | null | undefined): DraftPayload {
    if (!draftJson) return {};
    try {
      const parsed = JSON.parse(draftJson) as DraftPayload;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Spec 修复：按产品真实统计可达的产品素材（assets 数量；本地文件缺失的不计入） */
  private countReachableProductAssets(ownerId: string, productId: string | null | undefined): number {
    if (!productId) return 0;
    try {
      const assets = db.prepare(
        'SELECT url FROM product_assets WHERE product_id = ? AND owner_id = ?'
      ).all(productId, ownerId) as Array<{ url: string }>;
      if (assets.length === 0) return 0;
      const uploadsDir = process.env.UPLOADS_DIR || './uploads';
      let reachable = 0;
      for (const asset of assets) {
        const url = asset.url.startsWith('/') ? asset.url : `/${asset.url}`;
        if (url.startsWith('/uploads/')) {
          const filePath = path.join(uploadsDir, url.replace(/^\\/uploads\\//, ''));
          if (fs.existsSync(filePath)) reachable += 1;
        } else {
          // 远端素材无法本机探测：按可达计（与 materialProbe 的 unverified 语义一致，
          // 由 provider 提交前可达性预检兜底）
          reachable += 1;
        }
      }
      return reachable;
    } catch (error) {
      console.warn('[workflow-controller] countReachableProductAssets failed:', error);
      return 0;
    }
  }

  /**
   * S2 P0 修复：镜头提交的原子占位（claim）。
   * 条件 UPDATE pending/failed → submitting，只有一个并发请求能成功；
   * 占用成功后调用方才能调用 provider（提交成功后落 generating/completed，失败落 failed）。
   */
  private claimShotForSubmission(shotId: string, ownerId: string): boolean {
    const result = db.prepare(
      `UPDATE shot_generation_tasks
          SET status = 'submitting', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_id = ? AND status IN ('pending', 'failed')`
    ).run(shotId, ownerId);
    return result.changes > 0;
  }

  /** 释放被拒绝/异常路径的占位（回到 failed，不产生 provider 调用） */
  private releaseShotClaim(shotId: string, ownerId: string, reason: string): void {
    db.prepare(
      `UPDATE shot_generation_tasks
          SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_id = ? AND status = 'submitting'`
    ).run(reason.slice(0, 300), shotId, ownerId);
  }"""
assert old in s, 'helpers anchor'
s = s.replace(old, new)

# ============ 2) buildPreflightInput: real reference count ============
old = """    const row = this.loadExactStateRow(ownerId, { runId: opts.runId, sessionId: opts.sessionId });
    let draft: DraftPayload = {};
    if (row?.draft_json) {
      try {
        draft = JSON.parse(row.draft_json) as DraftPayload;
      } catch {
        draft = {};
      }
    }
    const shots = draft.shots ?? [];
    const videoModelId = draft.videoModelId ?? 'Seedance 2.0 Fast';"""
new = """    const row = this.loadExactStateRow(ownerId, { runId: opts.runId, sessionId: opts.sessionId });
    const draft = this.parseDraft(row?.draft_json);
    const shots = draft.shots ?? [];
    const videoModelId = draft.videoModelId ?? 'Seedance 2.0 Fast';
    // Spec 修复：参考输入数量由服务端按当前产品的真实 product_assets 计算，
    // 忽略客户端硬编码（referenceInputCount 只作展示提示，绝不作预检依据）。
    const realReferenceCount = this.countReachableProductAssets(ownerId, draft.productId);"""
assert old in s, 'preflight draft parse'
s = s.replace(old, new)

old = """      candidateCountPerShot: 1,
      referenceInputCount: draft.referenceInputCount ?? 1,
      hasVideoProviderConfig: this.port.hasConfig(),"""
new = """      candidateCountPerShot: 1,
      referenceInputCount: realReferenceCount,
      hasVideoProviderConfig: this.port.hasConfig(),"""
assert old in s, 'preflight referenceInputCount'
s = s.replace(old, new)

# ============ 3) confirmBatchSubmit: atomic claim + draft-driven inputs ============
old = """    const shots = this.loadShots({ sessionId, runId }, ownerId).filter((s) =>
      ['pending', 'failed'].includes(s.status)
    );
    if (shots.length === 0) {
      throw new WorkflowError(409, 'no_pending_shots', '没有可提交的镜头（全部已完成或被取消）');
    }
    const modelConfigs = db
      .prepare('SELECT id, model_code, category FROM model_config')
      .all() as Array<{ id: string; model_code: string; category: string }>;
    const stateRow = this.loadExactStateRow(ownerId, { runId, sessionId });
    const draftVideoModelId = this.draftVideoModelIdOf(stateRow?.draft_json);
    const videoModel = modelConfigs.find((m) => m.id === draftVideoModelId) ??
      modelConfigs.find((m) => m.category === 'video' && m.id === 'Seedance 2.0 Fast') ??
      modelConfigs.find((m) => m.category === 'video');

    let submittedCount = 0;
    for (const shot of shots) {
      const retryCount = this.loadCostRetryCount(null, String(shot.seedance_task_id || shot.id)) + 1;
      const modelCode = videoModel?.model_code || 'doubao-seedance-2-0-fast';
      const taskRunId = runId || String(shot.session_id);
      try {
        const task = await this.port.submitShot({
          shotId: String(shot.id),
          runId: taskRunId,
          ownerId,
          sessionId: String(shot.session_id),
          shotIndex: Number(shot.shot_index),
          prompt: shot.video_prompt || 'product close-up, smooth cinematic motion, high detail',
          modelCode,
          modelCatalogId: videoModel?.id || 'Seedance 2.0 Fast',
          durationSec: 5,
          resolution: '720p',
          aspectRatio: '9:16',
          imageUrl: shot.first_frame_url || '',
          attempt: retryCount,
          failureReason: shot.error_message || null,
        });
        const status = task.status === 'completed' ? 'completed' : 'generating';
        db.prepare(
          `UPDATE shot_generation_tasks
              SET status = ?, seedance_task_id = ?, video_url = ?, error_message = NULL,
                  pipeline_run_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(status, task.taskId, task.url || null, taskRunId, shot.id);
        this.recordShotCost(ownerId, shot, taskRunId, task.taskId, task.provider, modelCode, retryCount, null, true);
        submittedCount += 1;
      } catch (error: any) {
        const reason = String(error?.code || error?.message || 'provider_error');
        db.prepare(
          `UPDATE shot_generation_tasks
              SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(reason.slice(0, 300), shot.id);
        this.recordShotCost(ownerId, shot, taskRunId, null, this.port.name, modelCode, retryCount, reason, false);
      }
    }"""
new = """    const allShots = this.loadShots({ sessionId, runId }, ownerId);
    const candidates = allShots.filter((s) => ['pending', 'failed'].includes(s.status));
    if (candidates.length === 0) {
      throw new WorkflowError(409, 'no_pending_shots', '没有可提交的镜头（全部已完成或被取消）');
    }
    const modelConfigs = db
      .prepare('SELECT id, model_code, category FROM model_config')
      .all() as Array<{ id: string; model_code: string; category: string }>;
    const stateRow = this.loadExactStateRow(ownerId, { runId, sessionId });
    const draft = this.parseDraft(stateRow?.draft_json);
    const draftVideoModelId = this.draftVideoModelIdOf(stateRow?.draft_json);
    const videoModel = modelConfigs.find((m) => m.id === draftVideoModelId) ??
      modelConfigs.find((m) => m.category === 'video' && m.id === 'Seedance 2.0 Fast') ??
      modelConfigs.find((m) => m.category === 'video');
    const draftShots = draft.shots ?? [];

    let submittedCount = 0;
    let busySkipped = 0;
    for (const shot of candidates) {
      const retryCount = this.loadCostRetryCount(null, String(shot.seedance_task_id || shot.id)) + 1;
      const modelCode = videoModel?.model_code || 'doubao-seedance-2-0-fast';
      const taskRunId = runId || String(shot.session_id);
      // P0 修复：原子占位。并发请求只有一个能 claim 成功（pending/failed → submitting），
      // 失败的请求直接跳过该镜，绝不并发调用 provider。
      if (!this.claimShotForSubmission(String(shot.id), ownerId)) {
        busySkipped += 1;
        continue;
      }
      try {
        // Spec 修复：用户在工作台的局部编辑（promptOverride / 候选首帧）必须进入实际生成。
        const draftShot = draftShots.find((d) => d.shotIndex === Number(shot.shot_index));
        const effectivePrompt = draftShot?.promptOverride || shot.video_prompt || 'product close-up, smooth cinematic motion, high detail';
        const selectedCandidate = draftShot?.candidates?.find((c) => c.id === draftShot.selectedCandidateId);
        const effectiveFirstFrame = selectedCandidate?.url || shot.first_frame_url || '';
        // 回写任务行：展示/账本与真实生成保持一致
        db.prepare(
          `UPDATE shot_generation_tasks
              SET video_prompt = ?, first_frame_url = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(effectivePrompt.slice(0, 2000), effectiveFirstFrame, shot.id);
        shot.video_prompt = effectivePrompt;
        shot.first_frame_url = effectiveFirstFrame;
        const task = await this.port.submitShot({
          shotId: String(shot.id),
          runId: taskRunId,
          ownerId,
          sessionId: String(shot.session_id),
          shotIndex: Number(shot.shot_index),
          prompt: effectivePrompt,
          modelCode,
          modelCatalogId: videoModel?.id || 'Seedance 2.0 Fast',
          durationSec: 5,
          resolution: '720p',
          aspectRatio: '9:16',
          imageUrl: effectiveFirstFrame,
          attempt: retryCount,
          failureReason: shot.error_message || null,
        });
        const status = task.status === 'completed' ? 'completed' : 'generating';
        db.prepare(
          `UPDATE shot_generation_tasks
              SET status = ?, seedance_task_id = ?, video_url = ?, error_message = NULL,
                  pipeline_run_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(status, task.taskId, task.url || null, taskRunId, shot.id);
        this.recordShotCost(ownerId, shot, taskRunId, task.taskId, task.provider, modelCode, retryCount, null, true);
        submittedCount += 1;
      } catch (error: any) {
        const reason = String(error?.code || error?.message || 'provider_error');
        this.releaseShotClaim(String(shot.id), ownerId, reason);
        this.recordShotCost(ownerId, shot, taskRunId, null, this.port.name, modelCode, retryCount, reason, false);
      }
    }"""
assert old in s, 'batch submit block'
s = s.replace(old, new)

# ============ 4) retryShot: atomic claim ============
old = """    const effectiveRunId =
      shot.pipeline_run_id || (runId === shot.session_id ? runId : runId);
    if (shot.pipeline_run_id && shot.pipeline_run_id !== runId && runId !== shot.session_id) {
      throw new WorkflowError(403, 'run_mismatch', 'runId 与镜头归属不一致');
    }
    if (!this.port.hasConfig()) {
      throw new WorkflowError(503, 'provider_unconfigured', '视频生成服务未配置，无法重试');
    }

    const modelConfigs = db
      .prepare('SELECT id, model_code, category FROM model_config')
      .all() as Array<{ id: string; model_code: string; category: string }>;
    const videoModel = modelConfigs.find((m) => m.category === 'video' && m.id === 'Seedance 2.0 Fast') ??
      modelConfigs.find((m) => m.category === 'video');
    const modelCode = videoModel?.model_code || 'doubao-seedance-2-0-fast';

    if (promptOverride !== undefined && promptOverride !== null) {
      db.prepare(
        'UPDATE shot_generation_tasks SET video_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(promptOverride.slice(0, 2000), shot.id);
      shot.video_prompt = promptOverride;
    }

    try {"""
new = """    const effectiveRunId =
      shot.pipeline_run_id || (runId === shot.session_id ? runId : runId);
    if (shot.pipeline_run_id && shot.pipeline_run_id !== runId && runId !== shot.session_id) {
      throw new WorkflowError(403, 'run_mismatch', 'runId 与镜头归属不一致');
    }
    if (!this.port.hasConfig()) {
      throw new WorkflowError(503, 'provider_unconfigured', '视频生成服务未配置，无法重试');
    }

    const modelConfigs = db
      .prepare('SELECT id, model_code, category FROM model_config')
      .all() as Array<{ id: string; model_code: string; category: string }>;
    const videoModel = modelConfigs.find((m) => m.category === 'video' && m.id === 'Seedance 2.0 Fast') ??
      modelConfigs.find((m) => m.category === 'video');
    const modelCode = videoModel?.model_code || 'doubao-seedance-2-0-fast';

    if (promptOverride !== undefined && promptOverride !== null) {
      db.prepare(
        'UPDATE shot_generation_tasks SET video_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(promptOverride.slice(0, 2000), shot.id);
      shot.video_prompt = promptOverride;
    }

    // P0 修复：原子占位。并发重试同一镜头只有一个能 claim 成功（failed → submitting），
    // 另一个立即 409（不会出现两次 provider 调用）。
    if (!this.claimShotForSubmission(shotId, ownerId)) {
      const current = db
        .prepare('SELECT status FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
        .get(shotId, ownerId) as { status: string } | undefined;
      if (current?.status === 'submitting' || current?.status === 'generating') {
        throw new WorkflowError(409, 'shot_busy', '该镜头正在生成中（并发请求已被原子占位拦截），请稍后重试');
      }
      if (current?.status === 'cancelled') {
        throw new WorkflowError(409, 'shot_cancelled', '该镜头已取消，无法重试');
      }
      throw new WorkflowError(409, 'shot_not_retryable', `当前状态（${current?.status || 'unknown'}）不可重试`);
    }

    try {"""
assert old in s, 'retryShot claim anchor'
s = s.replace(old, new)

old = """    } catch (error: any) {
      const reason = String(error?.code || error?.message || 'provider_error');
      db.prepare(
        `UPDATE shot_generation_tasks
            SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(reason.slice(0, 300), shot.id);
      this.recordShotCost(ownerId, shot, effectiveRunId, null, this.port.name, modelCode, attempt, reason, false);
      throw new WorkflowError(502, 'retry_failed', reason.slice(0, 300));
    }"""
new = """    } catch (error: any) {
      const reason = String(error?.code || error?.message || 'provider_error');
      this.releaseShotClaim(String(shot.id), ownerId, reason);
      this.recordShotCost(ownerId, shot, effectiveRunId, null, this.port.name, modelCode, attempt, reason, false);
      throw new WorkflowError(502, 'retry_failed', reason.slice(0, 300));
    }"""
assert old in s, 'retryShot failure path'
s = s.replace(old, new)

# imports
old = """import {
  createDefaultWorkbenchSettings,"""
new = """import path from 'node:path';
import fs from 'node:fs';
import {
  createDefaultWorkbenchSettings,"""
assert old in s, 'imports'
s = s.replace(old, new)

open(p, 'w', encoding='utf-8').write(s)
print('workflow-controller ok')

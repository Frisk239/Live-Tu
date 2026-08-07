/**
 * S2 工作流控制器（深模块）：confirm / retryShot / cancel / getState / saveDraft
 *
 * 边界：
 * - 只有本控制器（经 video-submission-port 端口）能发起工作台付费提交；
 * - 所有 retry 必须携带 runId、shotId、attempt、failureReason，并进入成本账本；
 * - 已成功镜头绝不重提（重提被拒），失败镜头只重试该镜；
 * - 批量付费提交前强制运行 preflight，有 blocker 绝不提交 provider；
 * - 付费授权（paidAuthorization）独立于自主模式，切换模式不改变授权；
 * - SaveState / 确认点 / 分镜草稿持久化在 workbench_state（migration v25）。
 *
 * 可测试性：注入 VideoSubmissionPort（FakeVideoPort）与 preflight deps，
 * 不触发任何真实付费调用。
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  createDefaultWorkbenchSettings,
  deriveWorkbenchPhase,
  isAutonomyMode,
  isSaveState,
  microsToUsd,
  estimateVideoShotUsdMicros,
  type AutonomyMode,
  type ConfirmResult,
  type ConfirmType,
  type PaidAuthorization,
  type PreflightResult,
  type RetryShotRequest,
  type RetryShotResult,
  type SaveState,
  type ShotPlanShot,
  type ShotRuntimeState,
  type ShotStatus,
  type WorkbenchPhase,
  type WorkbenchState,
} from '../../shared/workbench-contract';
import { recordCostEntry, queryCostLedger } from './telemetry';
import type { CostEntry } from '../../shared/cost-ledger';
import { db } from './db';
import {
  getVideoSubmissionPort,
  type VideoSubmissionPort,
} from './video-submission-port';
import {
  runSubmissionPreflight,
  type PreflightDeps,
  type PreflightInput,
} from './submission-preflight';
import { ShotQaController } from './shot-qa-controller';
import {
  ensureShotFirstFrame,
  persistShotFirstFrame,
  ShotFirstFrameError,
  hasRollingContinuityPlan,
  shotFirstFrameContextFromDraft,
  type ShotFirstFrameContext,
  type ShotFirstFrameOutcome,
} from './shot-first-frame';
import { resolveRunProductAssets } from './product-assets';
import { mapWithConcurrency } from './limited-concurrency';
import { assertIdentitySafeProviderInputs } from './identity-safe-shot-reference';
import { collectAuditTexts, lintProviderPrompt } from './prompt-guard';

export interface WorkflowControllerOptions {
  port?: VideoSubmissionPort;
  preflightDeps?: PreflightDeps;
  /** S3 首帧保障 seam（测试注入 fake；默认真实派生+预检实现） */
  ensureFirstFrameFn?: (ctx: ShotFirstFrameContext) => Promise<ShotFirstFrameOutcome>;
}

interface DraftPayload {
  shots?: ShotPlanShot[];
  videoModelId?: string;
  /** 客户端写入的参考输入数量只作展示提示；预检实际数量由服务端按 productId 真实计算（Spec 修复） */
  referenceInputCount?: number;
  productId?: string | null;
  // S3 爆款复刻上下文（一级输入：爆款视频 + 产品图；首帧为内部派生资产）
  referenceVideoUrl?: string;
  referenceKeyframes?: string[];
  productAssetUrls?: string[];
  productName?: string;
  prohibitedItems?: string[];
  allowedItems?: string[];
  referenceStructure?: string;
  /** P3 完整成片计划（6-8 镜视觉计划；含 safeVisualProxy/sourceActionAudit 等审计字段） */
  fullVideoPlan?: any;
}

const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'needs_review'];

const STEP_STATUS_LABELS: Record<string, string> = {
  pending: '等待执行',
  running: '执行中',
  waiting_external: '等待外部生成',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  stale: '已过期',
  needs_review: '待复核',
};

export class WorkflowController {
  private readonly port: VideoSubmissionPort;
  private readonly preflightDeps: PreflightDeps;
  private readonly ensureFirstFrame: (ctx: ShotFirstFrameContext) => Promise<ShotFirstFrameOutcome>;
  /** 账目 ID 序列：同一 shot 同 attempt 可能多次事件（初始失败 + 重试失败），保证唯一 */
  private costSeq = 0;

  constructor(opts: WorkflowControllerOptions = {}) {
    this.port = opts.port ?? getVideoSubmissionPort();
    this.preflightDeps = opts.preflightDeps ?? {};
    this.ensureFirstFrame = opts.ensureFirstFrameFn ?? ensureShotFirstFrame;
  }

  // ==================== 状态行（workbench_state） ====================

  private loadStateRow(
    ownerId: string,
    opts: { runId?: string | null; sessionId?: string | null }
  ): any {
    if (opts.runId) {
      const row = db
        .prepare('SELECT * FROM workbench_state WHERE owner_id = ? AND run_id = ?')
        .get(ownerId, opts.runId);
      if (row) return row;
    }
    if (opts.sessionId) {
      const row = db
        .prepare('SELECT * FROM workbench_state WHERE owner_id = ? AND session_id = ?')
        .get(ownerId, opts.sessionId);
      if (row) return row;
    }
    // 调用方显式指定了上下文时，未命中必须返回空状态，不能退回到该用户的其他会话。
    // 否则切换自主模式等写操作会把上一会话的付费授权复制到新会话，
    // 使 /autonomy 等端点变成 /paid-auth 之外的隐式授权入口。
    if (opts.runId || opts.sessionId) return null;
    // 兜底：恢复该用户最近一次工作台（刷新/重启后无需携带 runId/sessionId 也能恢复）。
    // 不优先取 pre-run 行：会话草稿更新后必须胜过更早的设置行，否则确认点拿不到 sessionId。
    return (
      db
        .prepare(
          `SELECT * FROM workbench_state
            WHERE owner_id = ?
            ORDER BY updated_at DESC, rowid DESC LIMIT 1`
        )
        .get(ownerId) ?? null
    );
  }

  /** 精确 key 行（不做 latest 兜底）：预检/提交等业务必须用调用方指定的会话/运行草稿 */
  private loadExactStateRow(
    ownerId: string,
    opts: { runId?: string | null; sessionId?: string | null }
  ): any {
    if (opts.sessionId) {
      return (
        db
          .prepare('SELECT * FROM workbench_state WHERE owner_id = ? AND session_id = ?')
          .get(ownerId, opts.sessionId) ?? null
      );
    }
    if (opts.runId) {
      return (
        db
          .prepare('SELECT * FROM workbench_state WHERE owner_id = ? AND run_id = ?')
          .get(ownerId, opts.runId) ?? null
      );
    }
    return (
      db
        .prepare(
          'SELECT * FROM workbench_state WHERE owner_id = ? AND run_id IS NULL AND session_id IS NULL'
        )
        .get(ownerId) ?? null
    );
  }

  private upsertStateRow(
    ownerId: string,
    opts: {
      runId?: string | null;
      sessionId?: string | null;
      autonomyMode?: AutonomyMode;
      paidAuthEnabled?: boolean;
      confirmsJson?: string;
      draftJson?: string | null;
      saveState?: SaveState;
    }
  ): void {
    // 只按精确 key 查现值：新建会话/运行行绝不继承其他行的付费授权（付费授权默认关闭，
    // 任何路径都不得「暗中打开」——loadStateRow 的 latest 兜底只用于 getState 恢复）。
    const existing = opts.runId
      ? db.prepare('SELECT * FROM workbench_state WHERE owner_id = ? AND run_id = ?').get(ownerId, opts.runId)
      : opts.sessionId
        ? db.prepare('SELECT * FROM workbench_state WHERE owner_id = ? AND session_id = ?').get(ownerId, opts.sessionId)
        : db.prepare(
            'SELECT * FROM workbench_state WHERE owner_id = ? AND run_id IS NULL AND session_id IS NULL'
          ).get(ownerId);
    // P0 修复（跨用户覆写）：主键只含 runId/sessionId，若目标行已存在且属于其他用户，
    // 必须先拒绝——绝不允许 ON CONFLICT 更新别人的行并保留其 owner。
    if (existing && existing.owner_id !== ownerId) {
      throw new WorkflowError(
        403,
        'workbench_owner_mismatch',
        '该工作台状态属于其他用户，拒绝写入（跨用户覆写防护）'
      );
    }
    const id = opts.runId
      ? `wb:run:${opts.runId}`
      : opts.sessionId
        ? `wb:session:${opts.sessionId}`
        : `wb:owner:${ownerId}`;
    // P0 加固：按主键 id 无 owner 过滤复查。用户 B 用用户 A 的 sessionId 时，
    // loadStateRow（WHERE owner_id = ?）查不到行、上面的 pre-check 会漏网；
    // 这里直接按 id 查，行一旦属于他人立即 403——不依赖 ON CONFLICT WHERE 的静默不更新。
    const rowById = db
      .prepare('SELECT owner_id FROM workbench_state WHERE id = ?')
      .get(id) as { owner_id: string } | undefined;
    if (rowById && rowById.owner_id !== ownerId) {
      throw new WorkflowError(
        403,
        'workbench_owner_mismatch',
        '该工作台状态属于其他用户，拒绝写入（跨用户覆写防护）'
      );
    }
    const autonomyMode = opts.autonomyMode ?? existing?.autonomy_mode ?? 'managed';
    const paidAuth =
      opts.paidAuthEnabled !== undefined
        ? opts.paidAuthEnabled
        : existing?.paid_auth_enabled === 1;
    const confirmsJson = opts.confirmsJson ?? existing?.confirms_json ?? '{}';
    const draftJson = opts.draftJson !== undefined ? opts.draftJson : existing?.draft_json ?? null;
    const saveState = opts.saveState ?? existing?.save_state ?? 'saved';
    db.prepare(
      `INSERT INTO workbench_state
         (id, owner_id, run_id, session_id, autonomy_mode, paid_auth_enabled,
          confirms_json, draft_json, save_state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         run_id = excluded.run_id,
         session_id = excluded.session_id,
         autonomy_mode = excluded.autonomy_mode,
         paid_auth_enabled = excluded.paid_auth_enabled,
         confirms_json = excluded.confirms_json,
         draft_json = excluded.draft_json,
         save_state = excluded.save_state,
         updated_at = CURRENT_TIMESTAMP
       WHERE workbench_state.owner_id = excluded.owner_id`
    ).run(
      id,
      ownerId,
      opts.runId ?? null,
      opts.sessionId ?? null,
      autonomyMode,
      paidAuth ? 1 : 0,
      confirmsJson,
      draftJson,
      saveState
    );
  }

  // ==================== 只读派生 ====================

  private loadRun(runId: string, ownerId: string): any {
    return db
      .prepare('SELECT * FROM pipeline_runs WHERE id = ? AND owner_id = ?')
      .get(runId, ownerId) as any;
  }

  private loadShots(opts: { sessionId?: string | null; runId?: string | null }, ownerId: string): any[] {
    if (opts.sessionId) {
      return db
        .prepare(
          `SELECT * FROM shot_generation_tasks
            WHERE session_id = ? AND owner_id = ?
            ORDER BY shot_index ASC`
        )
        .all(opts.sessionId, ownerId) as any[];
    }
    if (opts.runId) {
      return db
        .prepare(
          `SELECT * FROM shot_generation_tasks
            WHERE pipeline_run_id = ? AND owner_id = ?
            ORDER BY shot_index ASC`
        )
        .all(opts.runId, ownerId) as any[];
    }
    return [];
  }

  private toShotRuntimeState(row: any): ShotRuntimeState {
    // P3：加载版本列表和 QA 状态
    const versions = this.loadShotVersions(String(row.id), String(row.owner_id));
    const latestQa = this.loadLatestQaReport(String(row.id));
    const latestQaJson = latestQa ? JSON.parse(latestQa.report_json || '{}') : null;

    return {
      shotId: String(row.id),
      sessionId: String(row.session_id),
      shotIndex: Number(row.shot_index),
      status: (row.status || 'pending') as ShotStatus,
      attempt: 0,
      failureReason: row.error_message || null,
      videoUrl: row.video_url || null,
      errorMessage: row.error_message || null,
      updatedAt: String(row.updated_at || ''),
      // P3 质量闭环字段
      currentVersion: Number(row.current_version || 1),
      techQaStatus: (row.qa_status === 'verified' ? 'verified'
        : row.qa_status === 'warning' ? 'warning'
        : row.qa_status === 'unverified' ? 'unverified'
        : row.qa_status === 'pass' ? 'verified'
        : 'pending') as ShotRuntimeState['techQaStatus'],
      semanticVerdict: (latestQaJson?.semantic?.overallVerdict || 'pending') as ShotRuntimeState['semanticVerdict'],
      qaSummary: latestQaJson?.semantic?.summary || null,
      qaReportId: latestQa?.id || null,
      versions,
      // S3：selectedVersionId 指向当前版本对应的版本行（版本切换后展示关系正确）
      selectedVersionId: versions.find((v) => Number(v.version) === Number(row.current_version || 1))?.versionId ?? null,
      // S4.1（与 useVersion 同原则）：人工通过是镜头级事实——任一版本的报告有人工通过
      // 记录即为 true，不能因切回历史版本（QA 展示跟随当前版本）而丢失徽章。
      manualPassed: this.loadAnyManualPass(String(row.id)),
      autoFixCount: this.loadAutoFixCount(String(row.id)),
    };
  }

  private loadCostRetryCount(runId: string | null, shotId: string | null): number {
    if (!runId && !shotId) return 0;
    const rows = queryCostLedger(
      (runId ? { runId } : { shotId }) as { runId?: string; shotId?: string }
    );
    return rows.reduce((acc, e) => acc + (e.retries || 0), 0);
  }

  // ==================== P3 辅助查询 ====================

  private loadShotVersions(shotId: string, ownerId: string): any[] {
    try {
      const rows = db.prepare(
        `SELECT sv.*, sq.overall_verdict
         FROM shot_versions sv
         LEFT JOIN shot_qa_reports sq ON sv.qa_report_id = sq.id
         WHERE sv.shot_id = ? AND sv.owner_id = ?
         ORDER BY sv.version ASC`
      ).all(shotId, ownerId) as any[];
      return rows.map((r) => ({
        versionId: r.id,
        version: r.version,
        videoUrl: r.video_url,
        prompt: r.prompt,
        modelCode: r.model_code,
        status: r.status,
        verdict: r.overall_verdict || null,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  private loadLatestQaReport(shotId: string): any {
    try {
      // S3 修复（版本回退状态漂移）：QA 展示关系跟随当前版本。
      // 先取 current_version 对应的报告；该版本无报告时回退最新报告。
      const shot = db
        .prepare('SELECT current_version FROM shot_generation_tasks WHERE id = ?')
        .get(shotId) as { current_version: number } | undefined;
      const version = shot ? Number(shot.current_version || 1) : 1;
      return (
        db
          .prepare(
            'SELECT * FROM shot_qa_reports WHERE shot_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1'
          )
          .get(shotId, version) ??
        db
          .prepare(
            'SELECT * FROM shot_qa_reports WHERE shot_id = ? ORDER BY created_at DESC LIMIT 1'
          )
          .get(shotId)
      );
    } catch {
      return null;
    }
  }

  private loadAutoFixCount(shotId: string): number {
    try {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM cost_ledger
         WHERE shot_id = ? AND failure_reason LIKE 'semantic_fix:%'`
      ).get(shotId) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  /** 镜头级人工通过事实：任一版本的 QA 报告存在 manual_passed=1（不随版本回退丢失） */
  private loadAnyManualPass(shotId: string): boolean {
    try {
      const row = db
        .prepare('SELECT 1 FROM shot_qa_reports WHERE shot_id = ? AND manual_passed = 1 LIMIT 1')
        .get(shotId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private loadCostSummary(ownerId: string, runId: string | null): { estimatedUsd: number | 'unknown'; incurredUsd: number | 'unknown' } {
    if (!runId) return { estimatedUsd: 0, incurredUsd: 'unknown' };
    try {
      const rows = queryCostLedger({ runId });
      let estimatedMicros = 0;
      let hasUnknown = false;
      let incurredMicros = 0;
      let hasActual = false;
      for (const e of rows) {
        if (typeof e.estimatedUsd === 'number') {
          estimatedMicros += e.estimatedUsd * 1_000_000;
        }
        if (e.actualUsd !== 'unknown' && typeof e.actualUsd === 'number') {
          incurredMicros += e.actualUsd * 1_000_000;
          hasActual = true;
        } else {
          hasUnknown = true;
        }
      }
      return {
        estimatedUsd: microsToUsd(estimatedMicros),
        incurredUsd: hasActual && !hasUnknown ? microsToUsd(incurredMicros) : 'unknown',
      };
    } catch {
      return { estimatedUsd: 'unknown', incurredUsd: 'unknown' };
    }
  }

  private loadQaStats(shotStates: any[]): { passed: number; total: number } {
    let passed = 0;
    let total = shotStates.length;
    for (const s of shotStates) {
      if (s.semanticVerdict === 'pass' || s.techQaStatus === 'verified') passed++;
    }
    return { passed, total };
  }

  // ==================== getState ====================

  getState(opts: { ownerId: string; runId?: string | null; sessionId?: string | null }): WorkbenchState {
    const { ownerId, runId = null, sessionId = null } = opts;
    const row = this.loadStateRow(ownerId, { runId, sessionId });
    const run = runId ? this.loadRun(runId, ownerId) : null;
    const shots = this.loadShots({ sessionId, runId }, ownerId);

    const settings = row
      ? {
          autonomyMode: isAutonomyMode(row.autonomy_mode) ? row.autonomy_mode : 'managed',
          paidAuthorization: { enabled: row.paid_auth_enabled === 1 } as PaidAuthorization,
          saveState: isSaveState(row.save_state) ? row.save_state : 'saved',
          confirms: this.parseConfirms(row.confirms_json),
          draftJson: row.draft_json ?? null,
        }
      : {
          ...createDefaultWorkbenchSettings(),
          saveState: 'saved' as SaveState,
          draftJson: null,
        };

    let phase: WorkbenchPhase = 'setup';
    let serverPhase = 'setup';
    let elapsedMs = 0;
    let failureReason: string | null = null;
    let safeToLeave = true;
    let retryCount = 0;

    if (run) {
      const currentStep = Number(run.current_step || 1);
      const stepRow = db
        .prepare('SELECT status FROM pipeline_steps WHERE run_id = ? AND step_number = ?')
        .get(run.id, currentStep) as { status: string } | undefined;
      serverPhase = `第 ${currentStep} 步 · ${STEP_STATUS_LABELS[stepRow?.status || run.status] || run.status}`;
      const startedAt = typeof run.started_at === 'string' ? Date.parse(`${run.started_at.replace(' ', 'T')}Z`) : 0;
      elapsedMs = Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
      failureReason = run.error_message || null;
      safeToLeave =
        TERMINAL_RUN_STATUSES.includes(run.status) ||
        run.status !== 'running' ||
        process.env.PIPELINE_WORKER_DISABLED !== 'true';
      retryCount = this.loadCostRetryCount(run.id, null);
      phase = deriveWorkbenchPhase({
        runExists: true,
        runStatus: run.status,
        hasShots: shots.length > 0,
        anyShotGenerating: shots.some((s) => s.status === 'generating'),
        allShotsCompleted: shots.length > 0 && shots.every((s) => s.status === 'completed'),
        batchConfirmed: Boolean(settings.confirms.batch_submit),
      });
    } else if (shots.length > 0) {
      serverPhase = `镜头生成 · ${shots.filter((s) => s.status === 'completed').length}/${shots.length} 已完成`;
      elapsedMs = 0;
      phase = deriveWorkbenchPhase({
        runExists: false,
        runStatus: 'queued',
        hasShots: true,
        anyShotGenerating: shots.some((s) => s.status === 'generating'),
        allShotsCompleted: shots.length > 0 && shots.every((s) => s.status === 'completed'),
        batchConfirmed: Boolean(settings.confirms.batch_submit),
      });
    }

    const shotStates = shots.map((s) => ({
      ...this.toShotRuntimeState(s),
      attempt: this.loadCostRetryCount(null, String(s.seedance_task_id || s.id)),
    }));

    // P3：成本汇总和 QA 统计
    const costSummary = this.loadCostSummary(ownerId, run?.id || null);
    const qaStats = this.loadQaStats(shotStates);
    const waitEstimate = phase === 'generating'
      ? { minSec: 60, maxSec: 240 }
      : null;

    return {
      ownerId,
      runId: runId || (run?.id ?? null) || (row?.run_id ?? null),
      sessionId: sessionId || (row?.session_id ?? null) || (shots[0]?.session_id ?? null),
      autonomyMode: settings.autonomyMode,
      paidAuthorization: settings.paidAuthorization,
      saveState: settings.saveState,
      confirms: settings.confirms,
      draftJson: settings.draftJson,
      phase,
      serverPhase,
      elapsedMs,
      retryCount,
      failureReason,
      estimatedCostUsd: costSummary.estimatedUsd,
      incurredCostUsd: costSummary.incurredUsd,
      qaPassedShots: qaStats.passed,
      qaTotalShots: qaStats.total,
      waitEstimate,
      safeToLeave,
      shotStates,
      updatedAt: String(row?.updated_at || new Date().toISOString()),
    };
  }

  private parseConfirms(json: string): Record<ConfirmType, boolean> {
    try {
      const parsed = JSON.parse(json || '{}');
      return {
        deconstruction: parsed.deconstruction === true,
        shot_plan: parsed.shot_plan === true,
        batch_submit: parsed.batch_submit === true,
      };
    } catch {
      return { deconstruction: false, shot_plan: false, batch_submit: false };
    }
  }

  private draftVideoModelIdOf(draftJson: string | null | undefined): string | null {
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
          const filePath = path.join(uploadsDir, url.replace(/^\/uploads\//, ''));
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

  /**
   * 释放被拒绝/异常路径的占位（回到 failed，不产生 provider 调用）。
   */
  private releaseShotClaim(shotId: string, ownerId: string, reason: string): void {
    db.prepare(
      `UPDATE shot_generation_tasks
          SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_id = ? AND status = 'submitting'`
    ).run(reason.slice(0, 300), shotId, ownerId);
  }

  // ==================== saveDraft / setAutonomyMode ====================

  /** 持久化草稿 + 自主模式 + 付费授权 + SaveState（服务端真实保存） */
  saveDraft(opts: {
    ownerId: string;
    runId?: string | null;
    sessionId?: string | null;
    draftJson?: string | null;
    autonomyMode?: AutonomyMode;
    saveState?: SaveState;
  }): WorkbenchState {
    const { ownerId, runId = null, sessionId = null } = opts;
    if (opts.draftJson !== undefined && opts.draftJson !== null) {
      try {
        JSON.parse(opts.draftJson);
      } catch {
        throw new WorkflowError(400, 'invalid_draft', '草稿必须是合法 JSON');
      }
    }
    if (opts.autonomyMode !== undefined && !isAutonomyMode(opts.autonomyMode)) {
      throw new WorkflowError(400, 'invalid_autonomy_mode', `未知自主模式: ${opts.autonomyMode}`);
    }
    if (opts.saveState !== undefined && !isSaveState(opts.saveState)) {
      throw new WorkflowError(400, 'invalid_save_state', `未知 SaveState: ${opts.saveState}`);
    }
    // 未提供 draftJson 时必须保留已持久化的草稿（不允许把草稿清空）
    const existing = this.loadStateRow(ownerId, { runId, sessionId });
    // P1-2 修复：saveDraft 不接受 paidAuthEnabled——付费授权只能经 /paid-auth 独立入口修改，
    // 旧客户端/脚本/陈旧请求无法借草稿接口改写授权状态。
    this.upsertStateRow(ownerId, {
      runId,
      sessionId,
      autonomyMode: opts.autonomyMode,
      draftJson: opts.draftJson !== undefined ? opts.draftJson : (existing?.draft_json ?? null),
      saveState: opts.saveState,
    });
    return this.getState({ ownerId, runId, sessionId });
  }

  /**
   * 切换自主模式：绝不改动付费授权（S2 证据 #1）。
   */
  setAutonomyMode(opts: {
    ownerId: string;
    runId?: string | null;
    sessionId?: string | null;
    autonomyMode: AutonomyMode;
  }): WorkbenchState {
    const { ownerId, runId = null, sessionId = null, autonomyMode } = opts;
    if (!isAutonomyMode(autonomyMode)) {
      throw new WorkflowError(400, 'invalid_autonomy_mode', `未知自主模式: ${autonomyMode}`);
    }
    const row = this.loadStateRow(ownerId, { runId, sessionId });
    // 付费授权取现值，原样保留
    const paidAuthEnabled = row ? row.paid_auth_enabled === 1 : false;
    this.upsertStateRow(ownerId, {
      runId,
      sessionId,
      autonomyMode,
      paidAuthEnabled,
    });
    return this.getState({ ownerId, runId, sessionId });
  }

  /** 开关付费授权（独立于自主模式） */
  setPaidAuthorization(opts: {
    ownerId: string;
    runId?: string | null;
    sessionId?: string | null;
    enabled: boolean;
  }): WorkbenchState {
    const { ownerId, runId = null, sessionId = null, enabled } = opts;
    const row = this.loadStateRow(ownerId, { runId, sessionId });
    this.upsertStateRow(ownerId, {
      runId,
      sessionId,
      autonomyMode: row ? (isAutonomyMode(row.autonomy_mode) ? row.autonomy_mode : 'managed') : 'managed',
      paidAuthEnabled: enabled,
    });
    return this.getState({ ownerId, runId, sessionId });
  }

  // ==================== preflight ====================

  private buildPreflightInput(ownerId: string, opts: { runId?: string | null; sessionId?: string | null }): PreflightInput {
    // 预检只认调用方指定会话/运行的草稿（latest 兜底仅用于 getState 恢复，避免串用其他会话的分镜）
    const row = this.loadExactStateRow(ownerId, { runId: opts.runId, sessionId: opts.sessionId });
    const draft = this.parseDraft(row?.draft_json);
    const shots = draft.shots ?? [];
    const videoModelId = draft.videoModelId ?? 'Seedance 2.0 Fast';
    // Spec 修复：参考输入数量由服务端按当前产品的真实 product_assets 计算，
    // 忽略客户端硬编码（referenceInputCount 只作展示提示，绝不作预检依据）。
    const realReferenceCount = this.countReachableProductAssets(ownerId, draft.productId);
    const modelConfigs = (db.prepare(
      'SELECT id, model_code, category, enabled FROM model_config'
    ).all() as Array<{ id: string; model_code: string; category: string; enabled: number }>).map(
      (m) => ({
        id: m.id,
        modelCode: m.model_code,
        category: m.category as 'text' | 'image' | 'video',
        enabled: m.enabled ? (1 as const) : (0 as const),
      })
    );
    return {
      ownerId,
      runId: opts.runId,
      sessionId: opts.sessionId,
      shots,
      videoModelId,
      modelConfigs,
      candidateCountPerShot: 1,
      referenceInputCount: realReferenceCount,
      // S3：首帧派生计划（新输入模型——用户不提供首帧；预检改验派生上下文）。
      // 兜底：草稿被旧客户端/测试重建而丢失 referenceKeyframes 时，从镜头行
      // （step2 系统登记的 reference_keyframe_url）恢复派生上下文，避免误拦
      // first_frame_missing；首帧提交前的独立预检仍做最终把关。
      derivedFirstFramePlan:
        Array.isArray(draft.referenceKeyframes) && draft.referenceKeyframes.length > 0
          ? {
              referenceKeyframes: draft.referenceKeyframes,
              productAssetUrls:
                Array.isArray(draft.productAssetUrls) && draft.productAssetUrls.length > 0
                  ? draft.productAssetUrls
                  : [],
            }
          : (() => {
              const shotRows = this.loadShots({ sessionId: opts.sessionId, runId: opts.runId }, ownerId);
              const refs = [
                ...new Set(
                  shotRows
                    .map((s: any) => s.reference_keyframe_url)
                    .filter((u: unknown): u is string => typeof u === 'string' && u.length > 0)
                ),
              ];
              return refs.length > 0 ? { referenceKeyframes: refs, productAssetUrls: [] } : null;
            })(),
      hasVideoProviderConfig: this.port.hasConfig(),
      providerName: this.port.name,
      supportsPaidAcceleration: this.port.supportsPaidAcceleration(),
    };
  }

  async runPreflight(opts: {
    ownerId: string;
    runId?: string | null;
    sessionId?: string | null;
  }): Promise<PreflightResult> {
    const input = this.buildPreflightInput(opts.ownerId, opts);
    if (input.shots.length === 0) {
      throw new WorkflowError(409, 'draft_shot_plan_missing', '缺少分镜草稿：请先完成拆解并保存分镜计划');
    }
    return runSubmissionPreflight(input, this.preflightDeps);
  }

  // ==================== S3 首帧保障（派生 + 预检） ====================

  /**
   * 付费提交前为单镜准备「产品条件化首帧」：
   * - 参考上下文来自工作台草稿（referenceKeyframes 系统自动提取 / productAssetUrls 产品图）；
   * - 首帧 = 参考关键帧（构图基座）+ 产品图（包装参考）派生的内部资产（derivedFirstFrameUrl）；
   * - 预检不通过 → 抛 ShotFirstFrameError（可读原因），调用方不得提交 provider。
   */
  private async prepareShotFirstFrame(
    ownerId: string,
    shot: any,
    draft: DraftPayload,
    runId: string | null,
    fixGuidance?: string[]
  ): Promise<{ firstFrameUrl: string; referenceImageUrls: string[]; firstFrameKind: 'generated_frame' }> {
    // 产品图兜底：草稿未携带时从产品资产表解析（远程素材按可达计）
    const draftProductUrls =
      Array.isArray(draft.productAssetUrls) && draft.productAssetUrls.length > 0
        ? draft.productAssetUrls
        : resolveRunProductAssets({ productId: draft.productId ?? null, productAssetIds: [] })
            .map((a) => a.url)
            .filter(Boolean);
    const ctx = shotFirstFrameContextFromDraft({
      ownerId,
      runId,
      shot,
      draft: { ...draft, productAssetUrls: draftProductUrls },
      fixGuidance,
    });
    const outcome = await this.ensureFirstFrame(ctx);
    persistShotFirstFrame(String(shot.id), outcome);
    return {
      firstFrameUrl: outcome.firstFrameUrl,
      // The viral keyframe is an input to the image-conditioning boundary only.
      // Never forward it to Seedance as a reference image: it can retain the source
      // video's face, watermark, subtitles, or other copyrighted visual identity.
      // The reviewed, product-conditioned first frame is the sole visual input to
      // the paid video provider; composition/motion intent is already represented
      // by that frame and the generated prompt.
      referenceImageUrls: [],
      // P5 强制出口 2：首帧来源声明——ensureShotFirstFrame 只产出「本系统生成的
      // 条件化首帧」（派生或经过 provenance 核验的复用），故可信声明为 generated_frame。
      firstFrameKind: 'generated_frame',
    };
  }

  // ==================== confirm ====================

  async confirm(opts: {
    ownerId: string;
    runId?: string | null;
    sessionId?: string | null;
    type: ConfirmType;
  }): Promise<ConfirmResult> {
    const { ownerId, runId = null, sessionId = null, type } = opts;
    if (type === 'deconstruction' || type === 'shot_plan') {
      return this.confirmSimple(ownerId, runId, sessionId, type);
    }
    return this.confirmBatchSubmit(ownerId, runId, sessionId);
  }

  private confirmSimple(
    ownerId: string,
    runId: string | null,
    sessionId: string | null,
    type: ConfirmType
  ): ConfirmResult {
    const row = this.loadStateRow(ownerId, { runId, sessionId });
    if (!runId && !sessionId) {
      throw new WorkflowError(409, 'confirm_context_missing', `确认「${type}」需要 runId 或 sessionId（先保存草稿）`);
    }
    const confirms = row ? this.parseConfirms(row.confirms_json) : { deconstruction: false, shot_plan: false, batch_submit: false };
    confirms[type] = true;
    this.upsertStateRow(ownerId, {
      runId,
      sessionId,
      confirmsJson: JSON.stringify(confirms),
      autonomyMode: row ? (isAutonomyMode(row.autonomy_mode) ? row.autonomy_mode : 'managed') : 'managed',
      paidAuthEnabled: row ? row.paid_auth_enabled === 1 : false,
    });
    return { type, confirmed: true, state: this.getState({ ownerId, runId, sessionId }) };
  }

  /**
   * 批量付费提交（确认点 #3）：
   * 1) 付费授权必须显式开启（与自主模式无关）；
   * 2) preflight 有任何 blocker → 拒绝提交 provider（证据 #2）；
   * 3) 只提交 pending/failed 镜头，成功镜头绝不重提；
   * 4) 每镜 cost 账目带 retries 与失败原因。
   */
  private async confirmBatchSubmit(
    ownerId: string,
    runId: string | null,
    sessionId: string | null
  ): Promise<ConfirmResult> {
    const state = this.getState({ ownerId, runId, sessionId });
    if (!state.paidAuthorization.enabled) {
      throw new WorkflowError(
        409,
        'paid_auth_required',
        '「允许 AI 自动提交付费生成」未开启：请在设置中显式授权后再批量提交'
      );
    }
    if (!this.port.hasConfig()) {
      throw new WorkflowError(409, 'provider_unconfigured', '视频生成服务未配置，无法执行付费提交');
    }
    const preflight = await this.runPreflight({ ownerId, runId, sessionId });
    if (!preflight.canSubmit) {
      throw new WorkflowError(409, 'preflight_blocked', '预检存在阻断项，未提交任何 provider', preflight);
    }
    const allShots = this.loadShots({ sessionId, runId }, ownerId);
    const candidates = allShots
      .filter((s) => ['pending', 'failed'].includes(s.status))
      .sort((a, b) => Number(a.shot_index) - Number(b.shot_index));
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
    // Ordinary batches may submit independent shots concurrently.  A 6-8 shot
    // quality plan is different: shot N+1 conditions its first frame on the
    // server-verified frame of shot N, so preparation/submission order is one
    // by one.  Video jobs remain asynchronous after submission; this only
    // trades a few seconds of request ordering for a concrete visual hand-off.
    // A failed predecessor does not fabricate an anchor; its successor uses
    // the normal safe anchor and the final sequence gate remains authoritative.
    const configuredShotConcurrency = Math.max(
      1,
      Math.floor(Number(process.env.WORKBENCH_SHOT_CONCURRENCY || 2)) || 2
    );
    const shotConcurrency = hasRollingContinuityPlan(draft) ? 1 : configuredShotConcurrency;
    const shotTimeoutMs = Number(process.env.WORKBENCH_SHOT_SUBMIT_TIMEOUT_MS || 0) || 0;
    const submitOutcomes = await mapWithConcurrency(
      candidates,
      shotConcurrency,
      async (shot: any) => {
        const retryCount = this.loadCostRetryCount(null, String(shot.seedance_task_id || shot.id)) + 1;
        const modelCode = videoModel?.model_code || 'doubao-seedance-2-0-fast';
        const taskRunId = runId || String(shot.session_id);
        try {
          // Spec 修复：用户在工作台的局部编辑（promptOverride / 候选首帧）必须进入实际生成。
          const draftShot = draftShots.find((d) => d.shotIndex === Number(shot.shot_index));
          const effectivePrompt = draftShot?.promptOverride || shot.video_prompt || 'product close-up, smooth cinematic motion, high detail';

          // S3 首帧保障：派生（参考关键帧 + 产品图）+ 预检。失败 → 不调用 provider，
          // 镜头标记失败并记录可读原因（预检不通过/缺上下文）。
          let effectiveFirstFrame = shot.first_frame_url || '';
        // P5 三轮收口：付费提交只经 claimAndSubmitCheckedShot——原子 claim（并发防重）、
        // 服务端 provenance + 视觉安全复核、task 回写、失败释放全部在服务内完成。
        const { claimAndSubmitCheckedShot, SubmitConflictError } = await import('../lib/submit-checked-shot');
        let checked;
        try {
          checked = await claimAndSubmitCheckedShot(this.port, {
            ownerId,
            sessionId: String(shot.session_id),
            shotId: String(shot.id),
            modelCode,
            attempt: retryCount,
            failureReason: shot.error_message || null,
            prepareFirstFrame: async () => {
              const prep = await this.prepareShotFirstFrame(ownerId, shot, draft, taskRunId);
              effectiveFirstFrame = prep.firstFrameUrl;
              assertIdentitySafeProviderInputs({ providerReferenceImageUrls: prep.referenceImageUrls });
              // P3 稳定性修复（计划 1）：provider prompt 与首帧结构 prompt 不得包含
              // 源素材审计文本（字幕/标签/引号文字）——lint 失败 = 不调用 provider。
              lintProviderPrompt({
                prompt: effectivePrompt,
                auditTexts: collectAuditTexts(draft?.fullVideoPlan, draft),
              });
              db.prepare(
                `UPDATE shot_generation_tasks
                    SET video_prompt = ?, first_frame_url = ?, updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?`
              ).run(effectivePrompt.slice(0, 2000), effectiveFirstFrame, shot.id);
              shot.video_prompt = effectivePrompt;
              shot.first_frame_url = effectiveFirstFrame;
            },
          });
        } catch (submitErr: any) {
          if (submitErr instanceof SubmitConflictError) {
            // 并发：其他请求正在提交该镜（或已提交）——跳过，不标失败、不重复付费
            return { shotIndex: Number(shot.shot_index), submitted: false };
          }
          throw submitErr;
        }
        const task = checked.task;
        if (checked.idempotent) {
          return { shotIndex: Number(shot.shot_index), submitted: false };
        }
        const status = task.status === 'completed' ? 'completed' : 'generating';
        this.recordShotCost(ownerId, shot, taskRunId, task.taskId, task.provider, modelCode, retryCount, null, true);
        // P3：创建版本记录（shot_versions）——版本号 = 已有版本行数 + 1
        // （current_version 列 DEFAULT 1，不能直接 +1，否则首版会写成 2）
        const existingVersionCount = (db.prepare(
          'SELECT COUNT(*) AS cnt FROM shot_versions WHERE shot_id = ?'
        ).get(String(shot.id)) as { cnt: number }).cnt;
        const version = existingVersionCount + 1;
        const vid = `sv-${shot.id}-v${version}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        db.prepare(
          `INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, prompt, model_code, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        ).run(vid, String(shot.id), taskRunId, ownerId, version, task.url || null, effectivePrompt.slice(0, 2000), modelCode, status);
          db.prepare('UPDATE shot_generation_tasks SET current_version = ? WHERE id = ?').run(version, shot.id);
          return { shotIndex: Number(shot.shot_index), submitted: true };
        } catch (error: any) {
          const reason = String(error?.code || error?.message || 'provider_error');
          this.recordShotCost(ownerId, shot, taskRunId, null, this.port.name, modelCode, retryCount, reason, false);
          return { shotIndex: Number(shot.shot_index), submitted: false, reason };
        }
      },
      { timeoutMs: shotTimeoutMs }
    );
    for (const outcome of submitOutcomes) {
      if (outcome.status === 'fulfilled' && outcome.value?.submitted) submittedCount += 1;
    }
    // 可观测性（P3 质量闭环修复）：每镜提交明细必须回到调用方。全部镜头失败时
    // 不再以 200 假成功返回——明确报错（不写入 batch_submit 确认，前端可展示原因），
    // 避免「镜头全失败、UI 只能轮询超时」的黑洞。
    const results = submitOutcomes
      .filter((outcome) => outcome.status === 'fulfilled')
      .map((outcome) => outcome.value as { shotIndex: number; submitted: boolean; reason?: string });
    if (candidates.length > 0 && submittedCount === 0) {
      const firstReason = results.find((r) => !r.submitted)?.reason || 'unknown';
      throw new WorkflowError(
        502,
        'all_shots_submission_failed',
        `全部 ${candidates.length} 个镜头提交失败，未确认批量提交。首个失败原因：${String(firstReason).slice(0, 400)}`
      );
    }
    const row = this.loadStateRow(ownerId, { runId, sessionId });
    const confirms = row ? this.parseConfirms(row.confirms_json) : { deconstruction: false, shot_plan: false, batch_submit: false };
    confirms.batch_submit = true;
    this.upsertStateRow(ownerId, {
      runId,
      sessionId,
      confirmsJson: JSON.stringify(confirms),
      autonomyMode: row ? (isAutonomyMode(row.autonomy_mode) ? row.autonomy_mode : 'managed') : 'managed',
      paidAuthEnabled: row ? row.paid_auth_enabled === 1 : false,
      saveState: 'saved',
    });
    return {
      type: 'batch_submit',
      confirmed: true,
      submittedCount,
      results,
      preflight,
      state: this.getState({ ownerId, runId, sessionId }),
    };
  }

  // ==================== retryShot ====================

  /**
   * 单镜局部重试：只重试该镜；成功镜头拒绝重提（证据 #5）；
   * runId/shotId/attempt/failureReason 全部进入成本账本（证据 #5/#6）。
   */
  async retryShot(opts: { ownerId: string } & RetryShotRequest): Promise<RetryShotResult> {
    const { ownerId, runId, shotId, attempt, failureReason, promptOverride, fixGuidance } = opts;
    if (!shotId) throw new WorkflowError(400, 'missing_shot_id', '缺少 shotId');
    if (!runId) throw new WorkflowError(400, 'missing_run_id', '缺少 runId');
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new WorkflowError(400, 'invalid_attempt', 'attempt 必须为正整数（重试序号进入成本账本）');
    }
    if (!failureReason || typeof failureReason !== 'string') {
      throw new WorkflowError(400, 'missing_failure_reason', '缺少 failureReason（必须携带并进入成本账本）');
    }
    const shot = db
      .prepare('SELECT * FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
      .get(shotId, ownerId) as any;
    if (!shot) throw new WorkflowError(404, 'shot_not_found', '未找到该镜头任务');
    if (shot.status === 'completed') {
      return {
        shotId,
        shotIndex: Number(shot.shot_index),
        attempt,
        status: 'completed',
        submitted: false,
        rejectedReason: '成功镜头不可重提（不会重复付费）',
        videoUrl: shot.video_url || null,
        costLedgerId: null,
      };
    }
    const effectiveRunId =
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
    // P5 三轮收口：原子 claim 由 claimAndSubmitCheckedShot 统一完成（并发防重）。
    // 此处先做状态预检（可重试性），不再自行 claim。
    {
      const current = db
        .prepare('SELECT status, seedance_task_id FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
        .get(shotId, ownerId) as { status: string; seedance_task_id: string | null } | undefined;
      if (current?.status === 'submitting' || current?.status === 'generating') {
        throw new WorkflowError(409, 'shot_busy', '该镜头正在生成中（并发请求已被原子占位拦截），请稍后重试');
      }
      if (current?.status === 'cancelled') {
        throw new WorkflowError(409, 'shot_cancelled', '该镜头已取消，无法重试');
      }
      if (current?.status !== 'failed' && current?.status !== 'pending') {
        throw new WorkflowError(409, 'shot_not_retryable', `当前状态（${current?.status || 'unknown'}）不可重试`);
      }
    }

    try {
      // S3 首帧保障（重试同样守卫）：复用已派生首帧并预检；失败则不调用 provider。
      let effectiveFirstFrame = shot.first_frame_url || '';
      const stateRow = this.loadExactStateRow(ownerId, { runId: effectiveRunId, sessionId: String(shot.session_id) });
      const draft = this.parseDraft(stateRow?.draft_json);
      // 付费提交只经 claimAndSubmitCheckedShot（原子 claim + 复核 + 回写 + 释放）
      const { claimAndSubmitCheckedShot, SubmitConflictError } = await import('../lib/submit-checked-shot');
      let checked;
      try {
        checked = await claimAndSubmitCheckedShot(this.port, {
          ownerId,
          sessionId: String(shot.session_id),
          shotId: String(shot.id),
          modelCode,
          attempt,
          failureReason,
          prepareFirstFrame: async () => {
            const prep = await this.prepareShotFirstFrame(ownerId, shot, draft, effectiveRunId, fixGuidance);
            effectiveFirstFrame = prep.firstFrameUrl;
            assertIdentitySafeProviderInputs({ providerReferenceImageUrls: prep.referenceImageUrls });
          },
        });
      } catch (submitErr: any) {
        if (submitErr instanceof SubmitConflictError) {
          throw new WorkflowError(409, 'shot_busy', '该镜头正在被其他请求提交，请稍后重试');
        }
        throw submitErr;
      }
      const task = checked.task;
      if (checked.idempotent) {
        return {
          shotId,
          shotIndex: Number(shot.shot_index),
          attempt,
          status: task.status === 'completed' ? 'completed' : 'generating',
          submitted: false,
          rejectedReason: '镜头已提交，未创建重复版本或成本账目',
          videoUrl: task.url || null,
          costLedgerId: null,
        };
      }
      const status = task.status === 'completed' ? 'completed' : 'generating';
      // P3：创建版本记录（retry 为新版本）——版本号 = 已有版本行数 + 1
      const existingVersionCount = (db.prepare(
        'SELECT COUNT(*) AS cnt FROM shot_versions WHERE shot_id = ?'
      ).get(shotId) as { cnt: number }).cnt;
      const newVersion = existingVersionCount + 1;
      const vid = `sv-${shotId}-v${newVersion}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(
        `INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, prompt, model_code, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(vid, shotId, effectiveRunId, ownerId, newVersion, task.url || null, shot.video_prompt || null, modelCode, status);
      db.prepare('UPDATE shot_generation_tasks SET current_version = ? WHERE id = ?').run(newVersion, shotId);
      // 成功条目不写失败原因（失败已由失败条目录入）；本次 retry 的失败原因仍由请求携带
      const costLedgerId = this.recordShotCost(
        ownerId,
        shot,
        effectiveRunId,
        task.taskId,
        task.provider,
        modelCode,
        attempt,
        null,
        true
      );
      return {
        shotId,
        shotIndex: Number(shot.shot_index),
        attempt,
        status,
        submitted: true,
        videoUrl: task.url || null,
        costLedgerId,
      };
    } catch (error: any) {
      // 首帧保障失败已在内部完成成本记录，直接透传可读原因（不重复记账）
      if (error instanceof WorkflowError && error.status === 422) throw error;
      if (error instanceof WorkflowError && error.status === 409) throw error;
      if (error instanceof ShotFirstFrameError) {
        this.recordShotCost(ownerId, shot, effectiveRunId, null, this.port.name, modelCode, attempt, error.code, false);
        throw new WorkflowError(422, error.code, error.message.slice(0, 1000));
      }
      if (error?.name === 'ReferencePolicyViolationError' || error?.code === 'asset_safety_not_passed') {
        this.recordShotCost(ownerId, shot, effectiveRunId, null, this.port.name, modelCode, attempt, error.code || 'reference_policy', false);
        throw new WorkflowError(422, error.code || 'reference_policy', String(error.message || error).slice(0, 1000));
      }
      const reason = String(error?.code || error?.message || 'provider_error');
      this.recordShotCost(ownerId, shot, effectiveRunId, null, this.port.name, modelCode, attempt, reason, false);
      // 保留完整错误信息（node:sqlite 的 code=ERR_SQLITE_ERROR 会吞掉具体 SQLite 消息）
      const detail = error?.code === 'ERR_SQLITE_ERROR' && error?.message
        ? `${error.code}: ${error.message}`
        : reason;
      throw new WorkflowError(502, 'retry_failed', detail.slice(0, 400));
    }
  }

  private recordShotCost(
    ownerId: string,
    shot: any,
    runId: string,
    taskId: string | null,
    provider: string,
    modelCode: string,
    retries: number,
    failureReason: string | null,
    submitted: boolean
  ): string | null {
    this.costSeq += 1;
    const id = `cost-workbench-${taskId || shot.id}-retry-${retries}-e${this.costSeq}`;
    const estimatedMicros = estimateVideoShotUsdMicros(modelCode, 1);
    const entry: CostEntry = {
      id,
      scope: 'shot',
      runId,
      shotId: taskId || String(shot.id),
      provider,
      model: modelCode,
      modelVersion: modelCode,
      seed: null,
      promptVersion: 'v1.0.0 (S2 工作台)',
      queueMs: 'unknown',
      generationMs: submitted ? 0 : 'unknown',
      retries,
      failureReason: failureReason ? (failureReason as CostEntry['failureReason']) : null,
      billing: submitted ? [{ unit: 'videos', amount: 1 }] : [],
      estimatedUsd: microsToUsd(estimatedMicros),
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: 'v1.0.0',
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: Date.now(),
    };
    try {
      recordCostEntry(entry, ownerId);
      return id;
    } catch (error) {
      console.warn('[workflow-controller] cost ledger write failed:', error);
      return null;
    }
  }

  // ==================== cancel ====================

  cancel(opts: { ownerId: string; runId?: string | null; sessionId?: string | null }): WorkbenchState {
    const { ownerId, runId = null, sessionId = null } = opts;
    if (runId) {
      const run = this.loadRun(runId, ownerId);
      if (run && !TERMINAL_RUN_STATUSES.includes(run.status)) {
        db.prepare(
          `UPDATE pipeline_runs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(runId);
        db.prepare(
          `UPDATE pipeline_steps SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
            WHERE run_id = ? AND status IN ('pending', 'queued', 'running', 'waiting_external')`
        ).run(runId);
      }
    }
    const shots = this.loadShots({ sessionId, runId }, ownerId);
    for (const shot of shots) {
      if (!['completed', 'failed', 'cancelled'].includes(shot.status)) {
        db.prepare(
          `UPDATE shot_generation_tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(shot.id);
      }
    }
    // 已完成镜头保持原状（不删除、不回滚、不重复付费）
    return this.getState({ ownerId, runId, sessionId });
  }
}

/**
 * 服务启动恢复：把悬挂的 submitting 占位标记为失败（绝不自动重提——provider 调用可能已发生，
 * 沿用编排器 AMBIGUOUS_SUBMISSION 哲学，由用户显式重试接管）。
 */
export function recoverStaleShotClaims(): number {
  try {
    const result = db.prepare(
      `UPDATE shot_generation_tasks
          SET status = 'failed',
              error_message = '提交状态不确定（服务重启），请确认后重试',
              updated_at = CURRENT_TIMESTAMP
        WHERE status = 'submitting' AND seedance_task_id IS NULL`
    ).run();
    const changes = Number(result.changes);
    if (changes > 0) {
      console.warn(`[workflow-controller] recover: ${changes} 个悬挂 submitting 占位已标记为失败`);
    }
    return changes;
  } catch (error) {
    console.warn('[workflow-controller] recoverStaleShotClaims failed:', error);
    return 0;
  }
}

/** 控制器业务错误：带 HTTP status + 可选 preflight 载荷 */
export class WorkflowError extends Error {
  readonly status: number;
  readonly code: string;
  readonly preflight?: PreflightResult;
  constructor(status: number, code: string, message: string, preflight?: PreflightResult) {
    super(message);
    this.status = status;
    this.code = code;
    this.preflight = preflight;
  }
}

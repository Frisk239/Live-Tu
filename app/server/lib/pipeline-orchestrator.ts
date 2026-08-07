import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import { internalWorkerHeaders } from './auth';
import { buildShotMigrationPlan } from './migration-plan';
import { resolveRunProductAssets } from './product-assets';
import { evaluatePublishGate, gateAllowsCompleted } from './publish-gate';
import { mapWithConcurrency } from './limited-concurrency';
// S0：状态类型单一来源（run-state.ts 同时驱动 SQLite CHECK 约束，防止契约漂移）
import type { RunStatus, StepStatus } from '../../shared/run-state';
export type { RunStatus, StepStatus } from '../../shared/run-state';

export type StartPipelineInput = {
  ownerId: string;
  idempotencyKey: string;
  productId?: string;
  productInfo?: unknown;
  productAssetIds?: string[];
  /** When 'viral', require ≥1 product visual asset (dual-input contract) */
  directOutMode?: 'viral' | 'legacy' | string;
  pipelineData: Record<string, any>;
};

/** viral_recreation_v2 属于直出模式家族（双输入强制、step2 多镜提交语义一致） */
export function isViralDirectOutMode(input: StartPipelineInput): boolean {
  const mode =
    input.directOutMode ||
    input.pipelineData?.directOutMode ||
    input.pipelineData?.mode;
  // viral_recreation_v2：爆款复刻 v2（虚构人物控制图，无 UGC 帧进 provider）。
  // 与 viral/viral_direct_out 一样要求双输入（爆款素材 + 产品图），
  // step2 提交在 submit-shot 端点按模式分支走虚构人物首帧派生。
  return mode === 'viral' || mode === 'viral_direct_out' || mode === 'viral_recreation_v2';
}

/** viral_recreation_v2 模式显式判定（供 orchestor/step2 分支使用） */
export function isViralRecreationV2Mode(input: StartPipelineInput): boolean {
  const mode =
    input.directOutMode ||
    input.pipelineData?.directOutMode ||
    input.pipelineData?.mode;
  return mode === 'viral_recreation_v2';
}

/**
 * Enforce dual-input for viral direct-out: viral media + ≥1 product asset.
 * Exported for unit tests.
 */
export function assertViralDualInput(input: StartPipelineInput): void {
  if (!isViralDirectOutMode(input)) return;

  const mediaUrl =
    input.pipelineData?.step1?.inputs?.mediaUrl ||
    input.pipelineData?.step1?.inputs?.imageUrl ||
    '';
  if (!mediaUrl) {
    const err = new Error('爆款直出模式需要上传爆款素材（step1.inputs.mediaUrl）') as Error & {
      status?: number;
      code?: string;
    };
    err.status = 400;
    err.code = 'MISSING_VIRAL_MEDIA';
    throw err;
  }

  const assetIds =
    input.productAssetIds ||
    input.pipelineData?.productAssetIds ||
    input.pipelineData?.step1?.inputs?.productAssetIds ||
    [];
  const assets = resolveRunProductAssets({
    productId: input.productId || input.pipelineData?.productId,
    productAssetIds: Array.isArray(assetIds) ? assetIds : [],
  });

  if (!assets.length) {
    const err = new Error(
      '爆款直出模式需要至少 1 张产品图（product assets）。请先在产品知识库上传产品图。'
    ) as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'MISSING_PRODUCT_ASSETS';
    throw err;
  }
}

export type PipelineRunSnapshot = {
  id: string;
  ownerId: string;
  status: RunStatus;
  currentStep: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  steps: Array<{
    step: number;
    status: StepStatus;
    attempt: number;
    output?: unknown;
    errorCode?: string;
    errorMessage?: string;
    updatedAt: string;
  }>;
};

type StepExecutorResult = {
  data: any;
  source: string;
  modelUsed?: string;
};

export interface StepExecutor {
  execute(step: number, body: unknown): Promise<StepExecutorResult>;
  pollSeedance(taskId: string): Promise<any>;
  pollShotSession(sessionId: string): Promise<any>;
  /** S1.3：单镜 Seedance 提交（每镜独立 HTTP 请求，付费 POST 由编排器控制重试次数） */
  submitShot(
    sessionId: string,
    shotIndex: number,
    model?: string,
    ownerId?: string,
    runId?: string,
    retryCount?: number
  ): Promise<any>;
}

class HttpStepExecutor implements StepExecutor {
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init?: RequestInit): Promise<any> {
    const maxAttempts = !init?.method || init.method === 'GET' ? 5 : 1;
    // Step2 多镜头提交包含逐镜 LLM + Seedance 提交，中转繁忙时可超过 3 分钟
    const timeoutMs =
      Number(process.env.PIPELINE_STEP_REQUEST_TIMEOUT_MS || 0) ||
      (init?.method === 'POST' && path.endsWith('/step2') ? 300_000 : 190_000);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            ...internalWorkerHeaders(),
            ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init?.headers || {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok || json.success === false) {
          const error = new Error(json.error || `HTTP ${response.status}`) as Error & {
            status?: number;
          };
          error.status = response.status;
          throw error;
        }
        return json;
      } catch (error) {
        lastError = error;
        const classified = classifyError(error);
        if (!classified.retryable || attempt === maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, attempt * 750)));
      }
    }
    throw lastError;
  }

  async execute(step: number, body: unknown): Promise<StepExecutorResult> {
    const json = await this.request(`/api/pipeline/step${step}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!json.data) throw new Error(`Step ${step} 未返回产物`);
    return {
      data: json.data,
      source: String(json.source || 'unknown'),
      modelUsed: json.modelUsed ? String(json.modelUsed) : undefined,
    };
  }

  async pollSeedance(taskId: string): Promise<any> {
    return this.pollWithResilience(`/api/seedance/generations/${encodeURIComponent(taskId)}`);
  }

  async pollShotSession(sessionId: string): Promise<any> {
    return this.pollWithResilience(`/api/pipeline/shot-tasks/${encodeURIComponent(sessionId)}`);
  }

  async submitShot(
    sessionId: string,
    shotIndex: number,
    model: string | undefined,
    ownerId: string | undefined,
    runId: string | undefined,
    retryCount: number | undefined
  ): Promise<any> {
    const json = await this.request(`/api/pipeline/step2/submit-shot`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, shotIndex, model, _ownerId: ownerId, _runId: runId, _retryCount: retryCount }),
    });
    return json.data;
  }

  private async pollWithResilience(path: string): Promise<any> {
    let lastError: unknown;
    for (let cycle = 1; cycle <= 6; cycle++) {
      try {
        return await this.request(path);
      } catch (error) {
        lastError = error;
        if (!classifyError(error).retryable || cycle === 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, cycle * 2_000));
      }
    }
    throw lastError;
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function classifyError(error: any): { code: string; retryable: boolean; message: string } {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || '未知错误');
  if (status === 429) return { code: 'PROVIDER_RATE_LIMIT', retryable: true, message };
  if (status >= 500 || status === 0) return { code: 'PROVIDER_TEMPORARY', retryable: true, message };
  if (status === 401 || status === 403) {
    return { code: 'PROVIDER_AUTH', retryable: false, message };
  }
  if (/timeout|timed out|fetch failed|ECONNRESET|ENOTFOUND/i.test(message)) {
    return { code: 'PROVIDER_TEMPORARY', retryable: true, message };
  }
  return { code: 'STEP_FAILED', retryable: false, message };
}

function isSafeSubmissionRetry(error: any): boolean {
  return Number(error?.status || 0) === 429;
}

function artifactUri(output: any): string | null {
  return (
    output?.videoUrl ||
    output?.previewVideoUrl ||
    output?.concatenatedVideoUrl ||
    output?.imageUrl ||
    output?.bgm_recommendation?.audioSampleUrl ||
    null
  );
}

export class PipelineOrchestrator {
  private readonly executor: StepExecutor;
  private readonly active = new Set<string>();
  private readonly scheduled = new Set<string>();
  private readonly maxConcurrency: number;

  constructor(baseUrl: string, executor?: StepExecutor) {
    this.executor = executor || new HttpStepExecutor(baseUrl);
    this.maxConcurrency = Math.max(1, Number(process.env.PIPELINE_WORKER_CONCURRENCY || 1));
  }

  start(input: StartPipelineInput): PipelineRunSnapshot {
    if (!input.ownerId || !input.idempotencyKey || !input.pipelineData?.step1?.inputs) {
      throw new Error('ownerId、idempotencyKey 和 pipelineData.step1.inputs 必填');
    }

    // Dual-input contract for viral direct-out
    assertViralDualInput(input);

    const existing = db.prepare(
      'SELECT id FROM pipeline_runs WHERE owner_id = ? AND idempotency_key = ?'
    ).get(input.ownerId, input.idempotencyKey) as { id: string } | undefined;
    if (existing) {
      this.schedule(existing.id);
      return this.get(existing.id, input.ownerId, true);
    }

    const productAssetIds =
      input.productAssetIds ||
      input.pipelineData?.productAssetIds ||
      input.pipelineData?.step1?.inputs?.productAssetIds ||
      [];

    const id = randomUUID();
    // S0 产物可追溯：Run 创建时定格绑定产品的单调递增 revision（products.revision）。
    // 不用 updated_at —— 它是秒级时间戳，同秒内修改产品版本不变，旧成片仍能通过版本校验。
    // 后续所有 Artifact 都继承该版本；产品被编辑/切换后即可判定旧产物过期。
    // 注意：绑定前必须 String() —— node:sqlite 把 number 绑进 TEXT 列会存成 '0.0'，
    // 与整数 revision 的文本形式 '0' 不一致，导致版本比较恒不等。
    const productVersion = input.productId
      ? ((db.prepare('SELECT revision FROM products WHERE id = ?').get(input.productId) as
          | { revision: number | null }
          | undefined)?.revision ?? null)
      : null;
    const productVersionText = productVersion == null ? null : String(productVersion);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO pipeline_runs (
          id, owner_id, product_id, product_version, status, current_step, input_json, idempotency_key
        ) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?)`
      ).run(
        id,
        input.ownerId,
        input.productId || null,
        productVersionText,
        JSON.stringify({
          pipelineData: input.pipelineData,
          productId: input.productId,
          productInfo: input.productInfo,
          productAssetIds,
          directOutMode: input.directOutMode || input.pipelineData?.directOutMode,
          _ownerId: input.ownerId,
        }),
        input.idempotencyKey
      );
      const insertStep = db.prepare(
        `INSERT INTO pipeline_steps (id, run_id, step_number, status, input_json)
         VALUES (?, ?, ?, 'pending', '{}')`
      );
      for (let step = 1; step <= 5; step++) {
        insertStep.run(randomUUID(), id, step);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    this.schedule(id);
    return this.get(id, input.ownerId, true);
  }

  get(id: string, ownerId: string, isAdmin = false): PipelineRunSnapshot {
    const run = (isAdmin
      ? db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id)
      : db.prepare('SELECT * FROM pipeline_runs WHERE id = ? AND owner_id = ?').get(id, ownerId)
    ) as any;
    if (!run) throw Object.assign(new Error('流水线任务不存在'), { status: 404 });

    const steps = db.prepare(
      'SELECT * FROM pipeline_steps WHERE run_id = ? ORDER BY step_number'
    ).all(id) as any[];
    return {
      id: run.id,
      ownerId: run.owner_id,
      status: run.status,
      currentStep: run.current_step,
      errorCode: run.error_code || undefined,
      errorMessage: run.error_message || undefined,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      steps: steps.map((step) => ({
        step: step.step_number,
        status: step.status,
        attempt: step.attempt,
        output: parseJson(step.output_json, undefined),
        errorCode: step.error_code || undefined,
        errorMessage: step.error_message || undefined,
        updatedAt: step.updated_at,
      })),
    };
  }

  cancel(id: string, ownerId: string, isAdmin = false): PipelineRunSnapshot {
    const access = this.get(id, ownerId, isAdmin);
    if (['completed', 'cancelled'].includes(access.status)) return access;
    db.prepare(
      `UPDATE pipeline_runs
          SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(id);
    db.prepare(
      `UPDATE pipeline_steps
          SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND status NOT IN ('completed', 'cancelled')`
    ).run(id);
    return this.get(id, ownerId, isAdmin);
  }

  retryStep(id: string, ownerId: string, stepNumber: number, isAdmin = false): PipelineRunSnapshot {
    this.get(id, ownerId, isAdmin);
    if (stepNumber < 1 || stepNumber > 5) {
      throw Object.assign(new Error('step 必须为 1–5'), { status: 400 });
    }

    const externalStep = db.prepare(
      `SELECT provider_task_id, output_json
         FROM pipeline_steps
        WHERE run_id = ? AND step_number = ?`
    ).get(id, stepNumber) as
      | { provider_task_id: string | null; output_json: string | null }
      | undefined;
    const canResumeExternal = Boolean(externalStep?.provider_task_id && externalStep?.output_json);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE pipeline_steps
            SET status = CASE WHEN step_number = ? THEN ? ELSE 'stale' END,
                output_json = CASE
                  WHEN step_number = ? AND ? = 0 THEN NULL
                  ELSE output_json
                END,
                provider_task_id = CASE
                  WHEN step_number = ? AND ? = 0 THEN NULL
                  ELSE provider_task_id
                END,
                attempt = CASE WHEN step_number = ? THEN attempt + 1 ELSE attempt END,
                error_code = NULL,
                error_message = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ? AND step_number >= ?`
      ).run(
        stepNumber,
        canResumeExternal ? 'waiting_external' : 'pending',
        stepNumber,
        canResumeExternal ? 1 : 0,
        stepNumber,
        canResumeExternal ? 1 : 0,
        stepNumber,
        id,
        stepNumber
      );
      db.prepare('DELETE FROM artifacts WHERE run_id = ? AND step_number >= ?').run(id, stepNumber);
      db.prepare(
        `UPDATE pipeline_runs
            SET status = 'queued', current_step = ?, error_code = NULL, error_message = NULL,
                completed_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(stepNumber, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    this.schedule(id);
    return this.get(id, ownerId, isAdmin);
  }

  recover() {
    db.prepare(
      `UPDATE pipeline_steps
          SET status = 'failed',
              error_code = 'AMBIGUOUS_SUBMISSION',
              error_message = 'Service restarted while this step was running; automatic resubmission was blocked to prevent duplicate provider charges.',
              completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'`
    ).run();
    db.prepare(
      `UPDATE pipeline_runs
          SET status = 'failed',
              error_code = 'AMBIGUOUS_SUBMISSION',
              error_message = 'Service restarted during a provider submission; retry this step manually after checking the provider.',
              completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'`
    ).run();
    db.prepare(
      `UPDATE pipeline_runs
          SET status = 'queued', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'waiting_external'`
    ).run();
    const rows = db.prepare(
      "SELECT id FROM pipeline_runs WHERE status = 'queued' ORDER BY created_at"
    ).all() as Array<{ id: string }>;
    for (const row of rows) this.schedule(row.id);
  }

  private schedule(runId: string) {
    if (process.env.PIPELINE_WORKER_DISABLED === 'true') return;
    if (this.active.has(runId) || this.scheduled.has(runId)) return;
    this.scheduled.add(runId);
    queueMicrotask(() => {
      this.scheduled.delete(runId);
      void this.drain(runId);
    });
  }

  private async drain(runId: string) {
    if (this.active.has(runId)) return;
    if (this.active.size >= this.maxConcurrency) {
      setTimeout(() => this.schedule(runId), 500);
      return;
    }
    this.active.add(runId);
    try {
      await this.executeRun(runId);
    } catch (error) {
      console.error(`[pipeline-orchestrator] run ${runId} crashed:`, error);
    } finally {
      this.active.delete(runId);
    }
  }

  private isCancelled(runId: string): boolean {
    const row = db.prepare('SELECT status FROM pipeline_runs WHERE id = ?').get(runId) as
      | { status: RunStatus }
      | undefined;
    return !row || row.status === 'cancelled';
  }

  private async executeRun(runId: string) {
    const run = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId) as any;
    if (!run || ['completed', 'cancelled'].includes(run.status)) return;

    db.prepare(
      `UPDATE pipeline_runs
          SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(runId);

    const input = {
      ...parseJson<any>(run.input_json, {}),
      _ownerId: run.owner_id,
    };
    for (let stepNumber = 1; stepNumber <= 5; stepNumber++) {
      if (this.isCancelled(runId)) return;
      const step = db.prepare(
        'SELECT * FROM pipeline_steps WHERE run_id = ? AND step_number = ?'
      ).get(runId, stepNumber) as any;
      if (step?.status === 'completed') continue;

      try {
        const output = step?.status === 'waiting_external'
          ? await this.resumeExternal(runId, step)
          : await this.executeStep(runId, stepNumber, input);
        if (this.isCancelled(runId)) return;
        this.completeStep(runId, stepNumber, output.data, output.source);
      } catch (error: any) {
        if (this.isCancelled(runId)) return;
        const classified = classifyError(error);
        db.prepare(
          `UPDATE pipeline_steps
              SET status = 'failed', error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = ? AND step_number = ?`
        ).run(classified.code, classified.message.slice(0, 1000), runId, stepNumber);
        db.prepare(
          `UPDATE pipeline_runs
              SET status = 'failed', current_step = ?, error_code = ?, error_message = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(stepNumber, classified.code, classified.message.slice(0, 1000), runId);
        return;
      }
    }

    // Publish gate 使用单一白名单契约：只有 passed=true 且 status='passed' 才能 completed。
    // 缺失、未知或自相矛盾的报告一律 needs_review，避免新增状态绕过黑名单。
    const step5Output = this.previousOutput(runId, 5);
    const publishReport = step5Output?.publishReport;
    if (!publishReport || !gateAllowsCompleted(publishReport, false)) {
      const gateStatus = publishReport?.status || 'missing';
      db.prepare(
        `UPDATE pipeline_steps
            SET status = 'needs_review', error_code = 'PUBLISH_NEEDS_REVIEW',
                error_message = '成片已生成但未通过发布门禁（${gateStatus}），需人工审核',
                updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ? AND step_number = 5`
      ).run(runId);
      db.prepare(
        `UPDATE pipeline_runs
            SET status = 'needs_review', current_step = 5, completed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(runId);
      return;
    }

    db.prepare(
      `UPDATE pipeline_runs
          SET status = 'completed', current_step = 5, completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(runId);
  }

  private previousOutput(runId: string, stepNumber: number): any {
    const row = db.prepare(
      'SELECT output_json FROM pipeline_steps WHERE run_id = ? AND step_number = ?'
    ).get(runId, stepNumber) as { output_json: string | null } | undefined;
    return parseJson(row?.output_json, {});
  }

  private buildStepBody(runId: string, stepNumber: number, input: any): any {
    const pipelineData = input.pipelineData || {};
    const productAssetIds =
      input.productAssetIds ||
      pipelineData.productAssetIds ||
      pipelineData.step1?.inputs?.productAssetIds ||
      [];
    const productAssets = resolveRunProductAssets({
      productId: input.productId,
      productAssetIds: Array.isArray(productAssetIds) ? productAssetIds : [],
    });
    const productHeroUrl = productAssets[0]?.url || '';
    const product = {
      productId: input.productId,
      productInfo: input.productInfo,
      productAssetIds: productAssets.map((a) => a.id),
      productAssets,
      _ownerId: input._ownerId || input.ownerId,
      _runId: runId,
    };
    const out1 = this.previousOutput(runId, 1);
    const out2 = this.previousOutput(runId, 2);
    const out3 = this.previousOutput(runId, 3);
    const out4 = this.previousOutput(runId, 4);
    const inheritedPipelineData = {
      ...pipelineData,
      productAssetIds: product.productAssetIds,
      directOutMode: input.directOutMode || pipelineData.directOutMode,
      step1: { ...(pipelineData.step1 || {}), output: out1 },
      step2: { ...(pipelineData.step2 || {}), output: out2 },
      step3: { ...(pipelineData.step3 || {}), output: out3 },
      step4: { ...(pipelineData.step4 || {}), output: out4 },
    };

    if (stepNumber === 1) {
      return {
        ...(pipelineData.step1?.inputs || {}),
        productAssets,
        ...product,
      };
    }
    if (stepNumber === 2) {
      // Product-conditioned first frame — NEVER use viral mediaUrl as final i2v frame
      let migrationPlan = out1.migrationPlan;
      if (!migrationPlan && productAssets.length > 0) {
        try {
          migrationPlan = buildShotMigrationPlan(out1, productAssets, {
            productName:
              (input.productInfo as any)?.name ||
              productHeroUrl,
          });
        } catch {
          migrationPlan = undefined;
        }
      }
      const productFirstFrame =
        migrationPlan?.productHeroUrl ||
        out1.productHeroFrameUrl ||
        productHeroUrl ||
        pipelineData.step2?.inputs?.imageUrl ||
        '';

      return {
        ...(pipelineData.step2?.inputs || {}),
        static_image_prompt: out1.static_image_prompt,
        // Final first frame is product-derived, not viral media
        imageUrl: productFirstFrame,
        mediaUrl: productFirstFrame,
        viralMediaUrl: pipelineData.step1?.inputs?.mediaUrl,
        firstFrameSource: productFirstFrame ? 'product_conditioned' : undefined,
        productFirstFrameUrl: productFirstFrame,
        productAssets,
        migrationPlan,
        shotList: migrationPlan?.shots || out1.shotList,
        pipelineData: inheritedPipelineData,
        ...product,
      };
    }
    if (stepNumber === 3) {
      return {
        ...(pipelineData.step3?.inputs || {}),
        videoPrompt: out2.video_prompt || out1.static_image_prompt,
        originalScript: out1.originalScript,
        pipelineData: inheritedPipelineData,
        ...product,
      };
    }
    if (stepNumber === 4) {
      return {
        ...(pipelineData.step4?.inputs || {}),
        copywritingTitle: out3.title,
        audioAnalysis: out1.audioAnalysis,
        pipelineData: inheritedPipelineData,
        ...product,
      };
    }
    return {
      ...(pipelineData.step5?.inputs || {}),
      title: out3.title,
      hook: out3.hook,
      cta: out3.cta,
      videoSourceUrl:
        out2.previewVideoUrl ||
        out2.concatenatedVideoUrl ||
        out2.multiShotResult?.concatenatedVideoUrl,
      audioSourceUrl: out4.bgm_recommendation?.audioSampleUrl,
      shotList: out1.shotList,
      step2Output: out2,
      step3Output: out3,
      firstFrameSource: out2.firstFrameSource || 'product_conditioned',
      pipelineData: inheritedPipelineData,
      ...product,
    };
  }

  private async executeStep(runId: string, stepNumber: number, input: any): Promise<StepExecutorResult> {
    const body = this.buildStepBody(runId, stepNumber, input);
    db.prepare(
      `UPDATE pipeline_steps
          SET status = 'running', attempt = attempt + 1, input_json = ?,
              started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND step_number = ?`
    ).run(JSON.stringify(body), runId, stepNumber);
    db.prepare(
      `UPDATE pipeline_runs
          SET status = 'running', current_step = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(stepNumber, runId);

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const startedAt = Date.now();
      try {
        let result = await this.executor.execute(stepNumber, body);
        db.prepare(
          `INSERT INTO provider_calls (
            id, run_id, step_number, provider, model_code, status, duration_ms
          ) VALUES (?, ?, ?, ?, ?, 'completed', ?)`
        ).run(
          randomUUID(),
          runId,
          stepNumber,
          result.source,
          result.modelUsed || null,
          Date.now() - startedAt
        );
        if (stepNumber === 2) {
          this.assertStep2SubmittedVideo(result);
          // S1.3：多镜头模式下 step2 只持久化 pending 镜头，
          // 编排器在此逐镜提交 Seedance（每镜独立 HTTP 请求，失败重试 1 次，单镜失败不拖垮其他镜头）。
          const multi = result.data?.multiShotResult;
          if (multi?.sessionId && Array.isArray(multi.shots) && multi.shots.length > 0) {
            result = await this.submitAllShots(runId, result, multi, body);
          }
          return this.waitForStep2External(runId, result);
        }
        return result;
      } catch (error: any) {
        lastError = error;
        const classified = classifyError(error);
        db.prepare(
          `INSERT INTO provider_calls (
            id, run_id, step_number, provider, status, duration_ms, error_code
          ) VALUES (?, ?, ?, 'pipeline-http', 'failed', ?, ?)`
        ).run(randomUUID(), runId, stepNumber, Date.now() - startedAt, classified.code);
        if (!isSafeSubmissionRetry(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    throw lastError;
  }

  /**
   * Step2 must actually submit video generation — otherwise steps 1-4 "succeed"
   * and step5 dies with a confusing missing-video-source error. Fail fast here
   * with an actionable message instead.
   */
  private assertStep2SubmittedVideo(result: StepExecutorResult): void {
    const data: any = result.data || {};
    const hasVideoPath = Boolean(
      data.previewVideoUrl ||
        data.concatenatedVideoUrl ||
        data.multiShotResult?.concatenatedVideoUrl ||
        data.seedanceTaskId ||
        data.multiShotResult?.sessionId
    );
    if (hasVideoPath) return;
    const noSubmitStates = [
      'awaiting_image_input',
      'awaiting_public_image',
      'submit_failed',
      'unconfigured',
    ];
    if (
      noSubmitStates.includes(String(data.seedanceStatus || '')) &&
      process.env.ALLOW_MOCK_FALLBACK !== 'true'
    ) {
      const err = new Error(
        data.seedanceError ||
          data.seedanceHint ||
          'Step 2 未能提交视频生成：缺少 Seedance 可下载的产品首帧图'
      ) as Error & { status?: number };
      err.status = 422;
      throw err;
    }
  }

  /**
   * S1.3 + S3：多镜头逐镜提交。每镜一个独立 HTTP 请求（POST /step2/submit-shot），
   * 同一轮独立镜头允许受限并发（默认 2，PIPELINE_SHOT_CONCURRENCY 可调），
   * Promise.allSettled——单镜失败/超时不拖垮其他镜头；
   * 每镜失败重试 1 次后仍失败则标记 failed（不允许假完成）。
   * 付费防重：items 中每个镜头只出现一次（同镜重复提交由 submit-shot 端点的
   * 原子 claim + 幂等检查兜底），并发只作用于不同镜头。
   */
  private async submitAllShots(
    runId: string,
    result: StepExecutorResult,
    multi: any,
    stepBody: any
  ): Promise<StepExecutorResult> {
    const sessionId = String(multi.sessionId);
    const ownerRow = db
      .prepare('SELECT owner_id FROM pipeline_runs WHERE id = ?')
      .get(runId) as { owner_id: string } | undefined;
    const ownerId = ownerRow?.owner_id;
    // step2 body 是扁平 inputs（buildStepBody 展开），videoModel 为模型显示名（如 'Seedance 2.0 Fast'）
    const videoModel = String(stepBody?.videoModel || '');
    const model = videoModel.includes('Fast')
      ? 'doubao-seedance-2-0-fast'
      : 'doubao-seedance-2-0';
    const shotConcurrency = Math.max(
      1,
      Math.floor(Number(process.env.PIPELINE_SHOT_CONCURRENCY || 2)) || 2
    );
    const perShotTimeoutMs = Number(process.env.PIPELINE_SHOT_SUBMIT_TIMEOUT_MS || 0) || 0;

    const updatedShots: any[] = [];
    const outcomes = await mapWithConcurrency(
      multi.shots,
      shotConcurrency,
      async (shot: any) => {
        let submitted: any = null;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            submitted = await this.executor.submitShot(
              sessionId,
              shot.shotIndex,
              model,
              ownerId,
              runId,
              attempt
            );
            break;
          } catch (error) {
            lastError = error;
            if (attempt === 0) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            } else {
              console.warn(
                `[orchestrator] shot ${shot.shotIndex} submit failed after retry:`,
                (error as Error).message
              );
            }
          }
        }
        return { shot, submitted, lastError };
      },
      { timeoutMs: perShotTimeoutMs }
    );

    for (const outcome of outcomes) {
      const shot: any = outcome.value?.shot ?? multi.shots[outcome.index];
      if (outcome.status === 'rejected' || !outcome.value?.submitted) {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason || '');
        updatedShots.push({
          ...shot,
          status: 'failed',
          error_message: reason || 'Seedance 提交失败（重试后仍失败），请重跑 Step2 或单镜重试',
        });
      } else {
        updatedShots.push({ ...shot, ...outcome.value.submitted });
      }
    }
    // 结果按 shotIndex 排序，保持确定性
    updatedShots.sort((a, b) => Number(a.shotIndex) - Number(b.shotIndex));
    return {
      ...result,
      data: {
        ...result.data,
        multiShotResult: { ...multi, shots: updatedShots },
      },
    };
  }

  private async waitForStep2External(
    runId: string,
    result: StepExecutorResult
  ): Promise<StepExecutorResult> {
    const sessionId = result.data?.multiShotResult?.sessionId;
    const seedanceTaskId = result.data?.seedanceTaskId;
    if (!sessionId && (!seedanceTaskId || result.data?.previewVideoUrl)) return result;

    // Multi-shot session where no shot was actually submitted to Seedance:
    // polling would spin for the full external timeout. Fail fast instead.
    if (sessionId) {
      const shots: any[] = result.data?.multiShotResult?.shots || [];
      const submitted = shots.filter((shot) => shot.seedanceTaskId);
      const completedWithUrl = shots.filter(
        (shot) => shot.video_url && shot.status === 'completed'
      );
      if (shots.length > 0 && submitted.length === 0 && completedWithUrl.length === 0) {
        const firstError = shots.find((shot) => shot.error_message)?.error_message;
        const err = new Error(
          firstError || '多镜头视频全部未提交（缺少 Seedance 可下载的产品首帧图）'
        ) as Error & { status?: number };
        err.status = 422;
        throw err;
      }
    }

    const providerTaskId = sessionId ? `shots:${sessionId}` : `seedance:${seedanceTaskId}`;
    db.prepare(
      `UPDATE pipeline_steps
          SET status = 'waiting_external', output_json = ?, provider_task_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND step_number = 2`
    ).run(JSON.stringify({ ...result.data, _source: result.source }), providerTaskId, runId);
    db.prepare(
      `UPDATE pipeline_runs
          SET status = 'waiting_external', current_step = 2, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(runId);
    return this.pollExternal(runId, providerTaskId, result.data, result.source);
  }

  private async resumeExternal(runId: string, step: any): Promise<StepExecutorResult> {
    const partial = parseJson<any>(step.output_json, {});
    return this.pollExternal(
      runId,
      String(step.provider_task_id || ''),
      partial,
      String(partial._source || 'seedance')
    );
  }

  private async pollExternal(
    runId: string,
    providerTaskId: string,
    partial: any,
    source: string
  ): Promise<StepExecutorResult> {
    const deadline = Date.now() + Number(process.env.PIPELINE_EXTERNAL_TIMEOUT_MS || 15 * 60_000);
    while (Date.now() < deadline) {
      if (this.isCancelled(runId)) throw new Error('任务已取消');

      if (providerTaskId.startsWith('shots:')) {
        const response = await this.executor.pollShotSession(providerTaskId.slice(6));
        const data = response.data || {};
        const failed = data.shots?.find((shot: any) => shot.status === 'failed');
        if (failed) throw new Error(failed.error_message || '多镜头生成失败');
        if (data.completedShots === data.totalShots && data.concatenatedVideoUrl) {
          return {
            data: {
              ...partial,
              concatenatedVideoUrl: data.concatenatedVideoUrl,
              multiShotResult: { ...(partial.multiShotResult || {}), ...data },
            },
            source,
          };
        }
      } else if (providerTaskId.startsWith('seedance:') || providerTaskId.startsWith('yunshu:')) {
        // yunshu: 前缀同样走 GET /api/seedance/generations/:id，路由内部按前缀分派轮询端点
        const isYunshu = providerTaskId.startsWith('yunshu:');
        const prefix = isYunshu ? 'yunshu:' : 'seedance:';
        const response = await this.executor.pollSeedance(providerTaskId.slice(prefix.length));
        const task = response.data || {};
        if (task.url) {
          return {
            data: {
              ...partial,
              previewVideoUrl: task.url,
              seedanceStatus: task.status || 'success',
              ...(isYunshu ? { seedanceProvider: 'yunshu', seedanceFallbackUsed: true } : {}),
            },
            source,
          };
        }
        if (['failed', 'error'].includes(String(task.status || '').toLowerCase())) {
          throw new Error(task.error || 'Seedance 视频生成失败');
        }
      } else {
        throw new Error('外部任务标识无效');
      }

      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error('等待视频生成超时');
  }

  private completeStep(runId: string, stepNumber: number, output: any, source: string) {
    const sanitizedOutput = { ...output };
    delete sanitizedOutput._source;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE pipeline_steps
            SET status = 'completed', output_json = ?, error_code = NULL, error_message = NULL,
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ? AND step_number = ?`
      ).run(JSON.stringify(sanitizedOutput), runId, stepNumber);
      // S0 产物 provenance：每个 Artifact 记录绑定产品/版本、参考版本、模型、prompt、来源 Run，
      // 供「切换产品后旧产物禁止发布」与质量回归追溯使用。
      const run = db
        .prepare('SELECT product_id, product_version, id FROM pipeline_runs WHERE id = ?')
        .get(runId) as { product_id: string | null; product_version: string | null; id: string } | undefined;
      const stepInput = parseJson<any>(
        (
          db
            .prepare('SELECT input_json FROM pipeline_steps WHERE run_id = ? AND step_number = ?')
            .get(runId, stepNumber) as { input_json: string } | undefined
        )?.input_json,
        {}
      );
      const model =
        sanitizedOutput?.modelInfo?.modelCode ||
        sanitizedOutput?.modelUsed ||
        sanitizedOutput?.imageModel ||
        sanitizedOutput?.videoModel ||
        sanitizedOutput?.textModel ||
        stepInput?.videoModel ||
        stepInput?.imageModel ||
        stepInput?.textModel ||
        stepInput?.model ||
        null;
      const prompt =
        sanitizedOutput?.video_prompt ||
        sanitizedOutput?.static_image_prompt ||
        sanitizedOutput?.image_prompt ||
        sanitizedOutput?.prompt ||
        sanitizedOutput?.copywriting ||
        null;
      const referenceVersion =
        sanitizedOutput?.referenceVersion ||
        sanitizedOutput?.mediaRef?.version ||
        sanitizedOutput?.sourceVideoVersion ||
        null;
      db.prepare(
        `INSERT INTO artifacts (
          id, run_id, step_number, artifact_type, uri, content_json, content_hash, source,
          product_id, product_version, reference_version, model, prompt, source_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        runId,
        stepNumber,
        `step${stepNumber}_output`,
        artifactUri(sanitizedOutput),
        JSON.stringify(sanitizedOutput),
        createHash('sha256').update(JSON.stringify(sanitizedOutput)).digest('hex'),
        source.includes('mock') ? 'mock' : 'real',
        run?.product_id ?? null,
        run?.product_version ?? null,
        referenceVersion,
        model,
        prompt ? String(prompt).slice(0, 2000) : null,
        run?.id ?? null
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

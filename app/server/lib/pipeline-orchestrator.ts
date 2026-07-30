import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import { internalWorkerHeaders } from './auth';

type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_external'
  | 'completed'
  | 'failed'
  | 'cancelled';
type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_external'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

export type StartPipelineInput = {
  ownerId: string;
  idempotencyKey: string;
  productId?: string;
  productInfo?: unknown;
  pipelineData: Record<string, any>;
};

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
}

class HttpStepExecutor implements StepExecutor {
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init?: RequestInit): Promise<any> {
    const maxAttempts = !init?.method || init.method === 'GET' ? 5 : 1;
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
          signal: AbortSignal.timeout(190_000),
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

    const existing = db.prepare(
      'SELECT id FROM pipeline_runs WHERE owner_id = ? AND idempotency_key = ?'
    ).get(input.ownerId, input.idempotencyKey) as { id: string } | undefined;
    if (existing) {
      this.schedule(existing.id);
      return this.get(existing.id, input.ownerId, true);
    }

    const id = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO pipeline_runs (
          id, owner_id, product_id, status, current_step, input_json, idempotency_key
        ) VALUES (?, ?, ?, 'queued', 1, ?, ?)`
      ).run(
        id,
        input.ownerId,
        input.productId || null,
        JSON.stringify({
          pipelineData: input.pipelineData,
          productId: input.productId,
          productInfo: input.productInfo,
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
    const product = {
      productId: input.productId,
      productInfo: input.productInfo,
      _ownerId: input._ownerId,
    };
    const out1 = this.previousOutput(runId, 1);
    const out2 = this.previousOutput(runId, 2);
    const out3 = this.previousOutput(runId, 3);
    const out4 = this.previousOutput(runId, 4);
    const inheritedPipelineData = {
      ...pipelineData,
      step1: { ...(pipelineData.step1 || {}), output: out1 },
      step2: { ...(pipelineData.step2 || {}), output: out2 },
      step3: { ...(pipelineData.step3 || {}), output: out3 },
      step4: { ...(pipelineData.step4 || {}), output: out4 },
    };

    if (stepNumber === 1) return { ...(pipelineData.step1?.inputs || {}), ...product };
    if (stepNumber === 2) {
      return {
        ...(pipelineData.step2?.inputs || {}),
        static_image_prompt: out1.static_image_prompt,
        imageUrl: pipelineData.step1?.inputs?.mediaUrl,
        shotList: out1.shotList,
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
      videoSourceUrl: out2.previewVideoUrl || out2.concatenatedVideoUrl,
      audioSourceUrl: out4.bgm_recommendation?.audioSampleUrl,
      shotList: out1.shotList,
      step2Output: out2,
      step3Output: out3,
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
        const result = await this.executor.execute(stepNumber, body);
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
        if (stepNumber === 2) return this.waitForStep2External(runId, result);
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

  private async waitForStep2External(
    runId: string,
    result: StepExecutorResult
  ): Promise<StepExecutorResult> {
    const sessionId = result.data?.multiShotResult?.sessionId;
    const seedanceTaskId = result.data?.seedanceTaskId;
    if (!sessionId && (!seedanceTaskId || result.data?.previewVideoUrl)) return result;

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
      } else if (providerTaskId.startsWith('seedance:')) {
        const response = await this.executor.pollSeedance(providerTaskId.slice('seedance:'.length));
        const task = response.data || {};
        if (task.url) {
          return {
            data: {
              ...partial,
              previewVideoUrl: task.url,
              seedanceStatus: task.status || 'success',
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
      db.prepare(
        `INSERT INTO artifacts (
          id, run_id, step_number, artifact_type, uri, content_json, content_hash, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        runId,
        stepNumber,
        `step${stepNumber}_output`,
        artifactUri(sanitizedOutput),
        JSON.stringify(sanitizedOutput),
        createHash('sha256').update(JSON.stringify(sanitizedOutput)).digest('hex'),
        source.includes('mock') ? 'mock' : 'real'
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

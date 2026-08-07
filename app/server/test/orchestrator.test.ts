import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-orchestrator-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';

const { db, initDatabase } = await import('../lib/db');
const { PipelineOrchestrator } = await import('../lib/pipeline-orchestrator');
type StepExecutor = import('../lib/pipeline-orchestrator').StepExecutor;
const PASSED_PUBLISH_REPORT = { passed: true, status: 'passed', blockers: [], warnings: [] };

before(() => {
  initDatabase();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES ('test-owner', 'owner', 'not-used', 'operator')`
  ).run();
});

after(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function waitForStatus(orchestrator: InstanceType<typeof PipelineOrchestrator>, id: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const snapshot = orchestrator.get(id, 'test-owner');
    if (['completed', 'failed', 'cancelled', 'needs_review'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('orchestrator test timed out');
}

test('durably executes all five steps and deduplicates start requests', async () => {
  const calls: number[] = [];
  const fakeExecutor: StepExecutor = {
    async execute(step) {
      calls.push(step);
      const outputs: Record<number, any> = {
        1: { static_image_prompt: 'prompt', shotList: [] },
        2: { video_prompt: 'motion', previewVideoUrl: '/uploads/renders/preview.mp4' },
        3: { title: 'title', hook: 'hook', cta: 'cta' },
        4: {
          bgm_recommendation: {
            track_name: 'track',
            audioSampleUrl: '/uploads/bgm/track.mp3',
          },
        },
        5: { videoUrl: '/uploads/renders/final.mp4', publishReport: PASSED_PUBLISH_REPORT },
      };
      return { data: outputs[step], source: 'fake' };
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
      throw new Error('not expected');
    },
    async submitShot() {
      throw new Error('not expected');
    },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  const input = {
    ownerId: 'test-owner',
    idempotencyKey: 'same-request',
    productId: 'prod_buv_cleanser',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  };

  const first = orchestrator.start(input);
  const duplicate = orchestrator.start(input);
  assert.equal(duplicate.id, first.id);

  const completed = await waitForStatus(orchestrator, first.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(calls, [1, 2, 3, 4, 5]);
  assert.equal(completed.steps.every((step) => step.status === 'completed'), true);
  assert.equal(
    (completed.steps[4].output as { videoUrl: string }).videoUrl,
    '/uploads/renders/final.mp4'
  );

  const artifacts = db.prepare(
    'SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ?'
  ).get(first.id) as { count: number };
  assert.equal(artifacts.count, 5);
});

test('retries from the failed step without re-running completed upstream steps', async () => {
  let failStep3 = true;
  const calls: number[] = [];
  const fakeExecutor: StepExecutor = {
    async execute(step) {
      calls.push(step);
      if (step === 3 && failStep3) {
        throw Object.assign(new Error('invalid copy input'), { status: 400 });
      }
      return {
        data:
          step === 1
            ? { static_image_prompt: 'prompt' }
            : step === 2
              ? { video_prompt: 'motion', previewVideoUrl: '/uploads/renders/preview.mp4' }
              : step === 3
                ? { title: 'title', hook: 'hook', cta: 'cta' }
                : step === 4
                  ? { bgm_recommendation: { track_name: 'track' } }
                  : { videoUrl: '/uploads/renders/final.mp4', publishReport: PASSED_PUBLISH_REPORT },
        source: 'fake',
      };
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
      throw new Error('not expected');
    },
    async submitShot() {
      throw new Error('not expected');
    },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  const run = orchestrator.start({
    ownerId: 'test-owner',
    idempotencyKey: 'retry-request',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });

  const failed = await waitForStatus(orchestrator, run.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.currentStep, 3);
  assert.deepEqual(calls, [1, 2, 3]);

  failStep3 = false;
  orchestrator.retryStep(run.id, 'test-owner', 3);
  const completed = await waitForStatus(orchestrator, run.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(calls, [1, 2, 3, 3, 4, 5]);
});

test('preserves the complete provider task id while polling Seedance', async () => {
  const expectedTaskId = '1083bb7f-2f79-483f-a133-e882dafb1db8';
  const polledTaskIds: string[] = [];
  const fakeExecutor: StepExecutor = {
    async execute(step) {
      if (step === 1) return { data: { static_image_prompt: 'prompt' }, source: 'fake' };
      if (step === 2) {
        return {
          data: { video_prompt: 'motion', seedanceTaskId: expectedTaskId },
          source: 'fake',
        };
      }
      if (step === 3) return { data: { title: 'title', hook: 'hook', cta: 'cta' }, source: 'fake' };
      if (step === 4) {
        return { data: { bgm_recommendation: { track_name: 'track' } }, source: 'fake' };
      }
      return {
        data: { videoUrl: '/uploads/renders/final.mp4', publishReport: PASSED_PUBLISH_REPORT },
        source: 'fake',
      };
    },
    async pollSeedance(taskId) {
      polledTaskIds.push(taskId);
      return { data: { status: 'completed', url: '/uploads/renders/provider.mp4' } };
    },
    async pollShotSession() {
      throw new Error('not expected');
    },
    async submitShot() {
      throw new Error('not expected');
    },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  const run = orchestrator.start({
    ownerId: 'test-owner',
    idempotencyKey: 'provider-id-request',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });

  const completed = await waitForStatus(orchestrator, run.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(polledTaskIds, [expectedTaskId]);
});

test('does not automatically resubmit on ambiguous provider 5xx', async () => {
  let submissionAttempts = 0;
  const fakeExecutor: StepExecutor = {
    async execute() {
      submissionAttempts += 1;
      throw Object.assign(new Error('provider accepted outcome unknown'), { status: 500 });
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
      throw new Error('not expected');
    },
    async submitShot() {
      throw new Error('not expected');
    },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  const run = orchestrator.start({
    ownerId: 'test-owner',
    idempotencyKey: 'unknown-outcome-request',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });

  const failed = await waitForStatus(orchestrator, run.id);
  assert.equal(failed.status, 'failed');
  assert.equal(submissionAttempts, 1);
});

test('does not automatically resubmit a running step after process recovery', async () => {
  let submissions = 0;
  const fakeExecutor: StepExecutor = {
    async execute() {
      submissions += 1;
      return { data: {}, source: 'fake' };
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
      throw new Error('not expected');
    },
    async submitShot() {
      throw new Error('not expected');
    },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  process.env.PIPELINE_WORKER_DISABLED = 'true';
  const run = orchestrator.start({
    ownerId: 'test-owner',
    idempotencyKey: 'crash-recovery-request',
    pipelineData: {
      step1: { inputs: {} },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });
  delete process.env.PIPELINE_WORKER_DISABLED;
  db.prepare(
    `UPDATE pipeline_runs
        SET status = 'running', completed_at = NULL
      WHERE id = ?`
  ).run(run.id);
  db.prepare(
    `UPDATE pipeline_steps
        SET status = 'running'
      WHERE run_id = ? AND step_number = 1`
  ).run(run.id);

  orchestrator.recover();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const recovered = orchestrator.get(run.id, 'test-owner');
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.errorCode, 'AMBIGUOUS_SUBMISSION');
  assert.equal(recovered.steps[0].status, 'failed');
  assert.equal(recovered.steps[0].errorCode, 'AMBIGUOUS_SUBMISSION');
  assert.equal(submissions, 0);
});

test('cancelled runs do not commit late step results', async () => {
  const fakeExecutor: StepExecutor = {
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { data: { static_image_prompt: 'late-result' }, source: 'fake' };
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
      throw new Error('not expected');
    },
    async submitShot() {
      throw new Error('not expected');
    },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  const run = orchestrator.start({
    ownerId: 'test-owner',
    idempotencyKey: 'cancel-request',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });
  orchestrator.cancel(run.id, 'test-owner');
  await new Promise((resolve) => setTimeout(resolve, 150));

  const cancelled = orchestrator.get(run.id, 'test-owner');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.steps.some((step) => step.status === 'completed'), false);
});

test('S1.3 submits multi-shot shots one-by-one via submitShot before polling', async () => {
  const submitted: Array<{
    sessionId: string;
    shotIndex: number;
    model?: string;
    ownerId?: string;
    runId?: string;
    retryCount?: number;
  }> = [];
  let pollCount = 0;
  const fakeExecutor: StepExecutor = {
    async execute(step) {
      if (step === 1) return { data: { static_image_prompt: 'prompt', shotList: [] }, source: 'fake' };
      if (step === 2) {
        return {
          data: {
            video_prompt: 'motion',
            isMultiShot: true,
            multiShotResult: {
              sessionId: 'shot_sess_s13',
              totalShots: 2,
              shots: [
                { id: 't1', shotIndex: 1, status: 'pending', video_prompt: 'p1', keyframeUrl: '/uploads/materials/a.png' },
                { id: 't2', shotIndex: 2, status: 'pending', video_prompt: 'p2', keyframeUrl: '/uploads/materials/b.png' },
              ],
            },
          },
          source: 'fake',
        };
      }
      if (step === 3) return { data: { title: 'title', hook: 'hook', cta: 'cta' }, source: 'fake' };
      if (step === 4) {
        return { data: { bgm_recommendation: { track_name: 'track' } }, source: 'fake' };
      }
      return {
        data: { videoUrl: '/uploads/renders/final.mp4', publishReport: PASSED_PUBLISH_REPORT },
        source: 'fake',
      };
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
      pollCount += 1;
      return {
        data: {
          totalShots: 2,
          completedShots: 2,
          concatenatedVideoUrl: '/uploads/renders/concat.mp4',
          shots: [
            { id: 't1', shotIndex: 1, status: 'completed', seedanceTaskId: 'seed-1', video_url: '/uploads/renders/s1.mp4' },
            { id: 't2', shotIndex: 2, status: 'completed', seedanceTaskId: 'seed-2', video_url: '/uploads/renders/s2.mp4' },
          ],
        },
      };
    },
    async submitShot(sessionId, shotIndex, model, ownerId, runId, retryCount) {
      submitted.push({ sessionId, shotIndex, model, ownerId, runId, retryCount });
      return { shotIndex, status: 'generating', seedanceTaskId: `seed-${shotIndex}` };
    },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  const run = orchestrator.start({
    ownerId: 'test-owner',
    idempotencyKey: 'multi-shot-submit-request',
    productId: 'prod_buv_cleanser',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: { videoModel: 'Seedance 2.0 Fast' } },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });

  const completed = await waitForStatus(orchestrator, run.id);
  assert.equal(completed.status, 'completed');
  // 每镜独立提交一次，owner 从 run 透传
  assert.deepEqual(
    submitted.map((s) => ({
      shotIndex: s.shotIndex,
      model: s.model,
      ownerId: s.ownerId,
      runId: s.runId,
      retryCount: s.retryCount,
    })),
    [
      {
        shotIndex: 1,
        model: 'doubao-seedance-2-0-fast',
        ownerId: 'test-owner',
        runId: run.id,
        retryCount: 0,
      },
      {
        shotIndex: 2,
        model: 'doubao-seedance-2-0-fast',
        ownerId: 'test-owner',
        runId: run.id,
        retryCount: 0,
      },
    ]
  );
  assert.ok(pollCount >= 1, '提交完成后应轮询 shot session');
  const step2Output = completed.steps[1].output as any;
  assert.equal(step2Output.multiShotResult.shots[0].seedanceTaskId, 'seed-1');
});

test('S0 soft gate: step5 publishReport needs_review lands on needs_review without CHECK failure', async () => {
  let publishReport: any = { status: 'needs_review', passed: false, blockers: ['duration_below_12s'] };
  const fakeExecutor: StepExecutor = {
    async execute(step) {
      if (step === 1) return { data: { static_image_prompt: 'prompt', shotList: [] }, source: 'fake' };
      if (step === 2) return { data: { video_prompt: 'motion', previewVideoUrl: '/uploads/renders/preview.mp4' }, source: 'fake' };
      if (step === 3) return { data: { title: 'title', hook: 'hook', cta: 'cta' }, source: 'fake' };
      if (step === 4) return { data: { bgm_recommendation: { track_name: 'track' } }, source: 'fake' };
      return {
        data: {
          videoUrl: '/uploads/renders/final.mp4',
          // 软门禁：成片已生成但未达发布标准 → 编排器必须落到 needs_review，不得静默 completed
          publishReport,
        },
        source: 'fake',
      };
    },
    async pollSeedance() { throw new Error('not expected'); },
    async pollShotSession() { throw new Error('not expected'); },
    async submitShot() { throw new Error('not expected'); },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  const run = orchestrator.start({
    ownerId: 'test-owner',
    idempotencyKey: 'soft-gate-needs-review-request',
    productId: 'prod_buv_cleanser',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: { videoModel: 'Seedance 2.0 Fast' } },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });

  const snapshot = await waitForStatus(orchestrator, run.id);
  assert.equal(snapshot.status, 'needs_review');
  assert.equal(snapshot.steps[4].status, 'needs_review');
  assert.equal(snapshot.steps[4].errorCode, 'PUBLISH_NEEDS_REVIEW');

  // S0 provenance：run 与 artifacts 都记录绑定产品与版本；step2 产物记录实际生成的视频模型
  const runRow = db.prepare('SELECT product_id, product_version FROM pipeline_runs WHERE id = ?').get(run.id) as {
    product_id: string | null;
    product_version: string | null;
  };
  assert.equal(runRow.product_id, 'prod_buv_cleanser');
  assert.ok(runRow.product_version, 'run 应定格绑定产品的 updated_at 作为 product_version');

  const artifact = db
    .prepare('SELECT product_id, product_version, model FROM artifacts WHERE run_id = ? AND step_number = 2')
    .get(run.id) as { product_id: string | null; product_version: string | null; model: string | null };
  assert.equal(artifact.product_id, 'prod_buv_cleanser');
  assert.equal(artifact.product_version, runRow.product_version);
  assert.equal(artifact.model, 'Seedance 2.0 Fast');

  // 防御性白名单：即使 status 字符串写成 passed，只要 passed=false 也不得 completed。
  publishReport = { status: 'passed', passed: false, blockers: ['inconsistent_gate_contract'] };
  const inconsistent = orchestrator.start({
    ownerId: 'test-owner',
    idempotencyKey: 'soft-gate-inconsistent-report-request',
    productId: 'prod_buv_cleanser',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: { videoModel: 'Seedance 2.0 Fast' } },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });
  const inconsistentSnapshot = await waitForStatus(orchestrator, inconsistent.id);
  assert.equal(inconsistentSnapshot.status, 'needs_review');
  assert.equal(inconsistentSnapshot.steps[4].status, 'needs_review');
});

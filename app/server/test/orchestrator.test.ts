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
    if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
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
        5: { videoUrl: '/uploads/renders/final.mp4' },
      };
      return { data: outputs[step], source: 'fake' };
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
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
                  : { videoUrl: '/uploads/renders/final.mp4' },
        source: 'fake',
      };
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
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
      return { data: { videoUrl: '/uploads/renders/final.mp4' }, source: 'fake' };
    },
    async pollSeedance(taskId) {
      polledTaskIds.push(taskId);
      return { data: { status: 'completed', url: '/uploads/renders/provider.mp4' } };
    },
    async pollShotSession() {
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

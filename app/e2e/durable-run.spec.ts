import { expect, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';
const PUBLIC_IMAGE =
  process.env.E2E_PUBLIC_IMAGE ||
  'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80';

test.skip(
  process.env.E2E_ALLOW_PAID !== 'true',
  'Set E2E_ALLOW_PAID=true to authorize or resume a real provider pipeline'
);

test('durable orchestrator completes all five real steps', async ({ request }) => {
  test.setTimeout(12 * 60_000);

  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { username: 'haini', password: '888' },
  });
  expect(login.ok()).toBeTruthy();

  const readiness = await (await request.get(`${BASE}/api/ready`)).json();
  test.skip(readiness.status !== 'ready', 'Production dependencies are not all ready');

  const existingRuns = (await (await request.get(`${BASE}/api/runs`)).json()).data || [];
  let run = existingRuns.find(
    (candidate: any) =>
      candidate.status === 'completed' &&
      (candidate.steps?.[4]?.output?.output?.videoUrl ||
        candidate.steps?.[4]?.output?.output?.downloadUrl)
  );
  const alreadyCompleted = Boolean(run);
  if (!run) run = existingRuns.find(
    (candidate: any) =>
      candidate.status === 'failed' &&
      candidate.currentStep === 2 &&
      candidate.steps?.[1]?.output?.seedanceTaskId
  );
  let idempotencyKey = '';

  if (run && !alreadyCompleted) {
    const retry = await request.post(`${BASE}/api/runs/${run.id}/retry`, {
      data: { step: 2 },
    });
    expect(retry.status()).toBe(202);
    run = (await retry.json()).data;
  } else if (!run) {
    idempotencyKey = `e2e-real-${Date.now()}`;
    const create = await request.post(`${BASE}/api/runs`, {
      headers: { 'Idempotency-Key': idempotencyKey },
      data: {
      productInfo: {
        id: 'prod_buv_cleanser',
        name: '薄荷绿泥清洁面膜',
        category: '护肤',
        sellingPoints: ['深层清洁', '温和不拔干'],
      },
      pipelineData: {
        step1: {
          inputs: {
            mediaUrl: PUBLIC_IMAGE,
            platform: 'xiaohongshu',
            bloggerType: 'daily_seeding',
            viralReason: 'production durable orchestrator acceptance',
          },
        },
        step2: {
          inputs: {
            videoTone: 'xiaohongshu_healing',
            durationSec: 5,
            videoModel: 'Seedance 2.0 Fast',
          },
        },
        step3: { inputs: { platform: 'xiaohongshu' } },
        step4: { inputs: {} },
        step5: { inputs: { aspectRatio: '9:16', subtitleStyle: '黄字黑边' } },
      },
      },
    });
    expect(create.status()).toBe(202);
    run = (await create.json()).data;
    expect(run.id).toBeTruthy();

    const duplicate = await request.post(`${BASE}/api/runs`, {
      headers: { 'Idempotency-Key': idempotencyKey },
      data: {
        pipelineData: { step1: { inputs: { mediaUrl: PUBLIC_IMAGE } } },
      },
    });
    expect((await duplicate.json()).data.id).toBe(run.id);
  }

  const deadline = Date.now() + 10 * 60_000;
  while (!['completed', 'failed', 'cancelled'].includes(run.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    run = (await (await request.get(`${BASE}/api/runs/${run.id}`)).json()).data;
  }

  expect(run.status, run.errorMessage).toBe('completed');
  expect(run.steps).toHaveLength(5);
  expect(run.steps.every((step: { status: string }) => step.status === 'completed')).toBe(true);
  const finalVideoUrl =
    run.steps[4]?.output?.output?.videoUrl || run.steps[4]?.output?.output?.downloadUrl;
  expect(finalVideoUrl).toBeTruthy();
  const videoResponse = await request.get(
    String(finalVideoUrl).startsWith('http') ? finalVideoUrl : `${BASE}${finalVideoUrl}`
  );
  expect(videoResponse.ok()).toBeTruthy();
  expect(videoResponse.headers()['content-type']).toMatch(/^video\//);
  expect((await videoResponse.body()).byteLength).toBeGreaterThan(1024);
});

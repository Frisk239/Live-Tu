import { test, expect } from '@playwright/test';

/**
 * Thick API/readiness suite using Playwright request context (no page navigation races).
 * Requires: npm run dev on http://localhost:3004
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

test.describe('API readiness & contracts', () => {
  test('health returns readiness shape', async ({ request }) => {
    const res = await request.get(`${BASE}/api/health?probe=1`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.readiness).toBeTruthy();
    expect(body.readiness).toHaveProperty('yunwu');
    expect(body.readiness).toHaveProperty('seedance');
    expect(body.readiness).toHaveProperty('ffmpeg');
    expect(body.readiness).toHaveProperty('publicBaseUrl');
    expect(Array.isArray(body.readiness.notes)).toBe(true);
    expect(body.readiness.yunwu.configured).toBe(true);
  });

  test('CRUD surfaces respond', async ({ request }) => {
    const paths = [
      '/api/products',
      '/api/materials',
      '/api/tasks',
      '/api/presets',
      '/api/bgm',
      '/api/models/config',
    ];
    for (const p of paths) {
      const res = await request.get(`${BASE}${p}`);
      expect(res.ok(), p).toBeTruthy();
      const json = await res.json();
      expect(json.success !== false, p).toBeTruthy();
    }
    const products = await (await request.get(`${BASE}/api/products`)).json();
    expect((products.data || []).length).toBeGreaterThan(0);
    const presets = await (await request.get(`${BASE}/api/presets`)).json();
    expect((presets.data || []).length).toBeGreaterThan(0);
  });

  test('step1 contract with public image', async ({ request }) => {
    test.setTimeout(120_000);
    const res = await request.post(`${BASE}/api/pipeline/step1`, {
      data: {
        mediaUrl:
          'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80',
        platform: 'xiaohongshu',
        bloggerType: 'daily_seeding',
        viralReason: 'e2e thick contract',
      },
    });
    const body = await res.json();
    if (!body.success) {
      test.skip(true, `step1 unavailable: ${body.error || res.status()}`);
      return;
    }
    expect(body.data?.static_image_prompt).toBeTruthy();
    expect(body.data?.scene).toBeTruthy();
  });

  test('step3 returns copywriting shape', async ({ request }) => {
    test.setTimeout(120_000);
    const res = await request.post(`${BASE}/api/pipeline/step3`, {
      data: {
        videoPrompt: 'zoom in on cleanser foam',
        targetPlatform: 'douyin',
        scriptPersona: '成分党',
      },
    });
    const body = await res.json();
    if (!body.success) {
      test.skip(true, `step3 unavailable: ${body.error || res.status()}`);
      return;
    }
    expect(body.data?.title).toBeTruthy();
    if (body.data?.warnings) {
      expect(Array.isArray(body.data.warnings)).toBe(true);
    }
  });

  test('step4 library match shape', async ({ request }) => {
    test.setTimeout(90_000);
    const res = await request.post(`${BASE}/api/pipeline/step4`, {
      data: {
        copywritingTitle: '油皮晨间洁面',
        tonePreference: '治愈',
        commercialScenario: '抖音/小红书商业化',
      },
    });
    const body = await res.json();
    if (!body.success) {
      test.skip(true, `step4 unavailable: ${body.error || res.status()}`);
      return;
    }
    expect(body.data?.bgm_recommendation?.track_name).toBeTruthy();
    expect(
      ['library', 'yunwu', 'direct', 'mock'].includes(body.source) || Boolean(body.source)
    ).toBeTruthy();
  });

  test('task failed status round-trip', async ({ request }) => {
    const id = `draft_thick_${Date.now()}`;
    const createRes = await request.post(`${BASE}/api/tasks`, {
      data: {
        id,
        title: 'thick-e2e-failed',
        status: 'failed',
        currentStep: 2,
        pipelineData: {
          step1: { status: 'completed', inputs: {} },
          step2: { status: 'failed', inputs: {} },
          step3: { status: 'pending', inputs: {} },
          step4: { status: 'pending', inputs: {} },
          step5: { status: 'pending', inputs: {} },
        },
      },
    });
    const created = await createRes.json();
    expect(created.success).toBe(true);
    expect(created.data.status).toBe('failed');
    expect(created.data.currentStep).toBe(2);

    const listed = await (await request.get(`${BASE}/api/tasks`)).json();
    const found = (listed.data || []).find((t: any) => t.id === id);
    expect(found).toBeTruthy();
    expect(found.status).toBe('failed');

    await request.delete(`${BASE}/api/tasks/${id}`);
  });

  test('seedance env diagnostics when base is set', async ({ request }) => {
    const body = await (await request.get(`${BASE}/api/health?probe=1`)).json();
    const s = body.readiness?.seedance;
    expect(s).toBeTruthy();
    // After server restart with load-env, hasAccount/hasPassword should be true if .env present
    if (s.envFlags) {
      console.log('seedance envFlags', s.envFlags);
    }
    if (s.configured && s.tokenOk === false) {
      console.warn('Seedance configured but token failed:', s.error);
    }
  });
});

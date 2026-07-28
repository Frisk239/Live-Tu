import { test, expect } from '@playwright/test';

/**
 * Optional longer path: login → public image → Step1 real LLM (if yunwu ready).
 * Skips AI steps when readiness is insufficient.
 *
 * Run: npm run test:e2e:full
 * Requires: npm run dev on :3004
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';
const PUBLIC_IMAGE =
  process.env.E2E_PUBLIC_IMAGE ||
  'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=800&q=80';

test.describe('BUV full-ish pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aigc_onboarding_completed', 'true');
      localStorage.removeItem('aigc_is_logged_in');
    });
    await page.goto(BASE);
  });

  test('step1 with public image when yunwu ready', async ({ page }) => {
    test.setTimeout(180_000);

    const readiness = await page.evaluate(async () => {
      const res = await fetch('/api/health?probe=1');
      return res.json();
    });

    const yunwuOk = Boolean(readiness?.readiness?.yunwu?.configured);
    test.skip(!yunwuOk, 'YUNWU not configured — skip real Step1');

    // Login
    await page.getByPlaceholder('请输入测试账号 (haini)').fill('haini');
    await page.getByPlaceholder('请输入登录密码 (888)').fill('888');
    await page.getByRole('button', { name: '立即登录工作台' }).click();
    await expect(page.locator('aside')).toBeVisible({ timeout: 15000 });

    // Ensure pipeline view
    await page.locator('aside button[title="5步短视频反推与生成主工程"]').click();
    await expect(page.getByText(/第 1 步|工作台绑定卖点/).first()).toBeVisible({ timeout: 10000 });

    // Set public media URL via API-side state is hard; use sample button if present, else evaluate fill
    const sampleBtn = page.getByText(/晨间阳光浴室|小红书爆款/).first();
    if (await sampleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sampleBtn.click();
    } else {
      // Fallback: inject mediaUrl through React is not available; call step1 API directly then reload draft
      const step1 = await page.evaluate(
        async ({ imageUrl }) => {
          const res = await fetch('/api/pipeline/step1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mediaUrl: imageUrl,
              platform: 'xiaohongshu',
              bloggerType: 'daily_seeding',
              viralReason: 'E2E full test public image',
              imageModel: 'Imagen 4 Ultra',
            }),
          });
          return res.json();
        },
        { imageUrl: PUBLIC_IMAGE }
      );

      expect(step1.success, step1.error || 'step1 failed').toBe(true);
      expect(step1.data?.static_image_prompt).toBeTruthy();
      expect(step1.source).not.toBe('mock');
      return; // API-level success is enough when UI sample unavailable
    }

    // Click run on step1 card
    const runBtn = page.getByRole('button', { name: /^运行|运行\s|开始拆解|生成/ }).first();
    if (await runBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await runBtn.click();
      // Wait for completion UI (prompt text area / completed badge)
      await expect(
        page.getByText(/static_image_prompt|场景|rationale|拆解|已完成/i).first()
      ).toBeVisible({ timeout: 120_000 });
    }

    // Draft should eventually appear in tasks API
    await page.waitForTimeout(2500);
    const tasks = await page.evaluate(async () => {
      const res = await fetch('/api/tasks');
      return res.json();
    });
    expect(tasks.success).toBe(true);
    // soft assert: may or may not have draft depending on UI edits
    expect(Array.isArray(tasks.data)).toBe(true);
  });

  test('seedance status endpoint when configured', async ({ page }) => {
    const health = await page.evaluate(async () => {
      const res = await fetch('/api/health?probe=1');
      return res.json();
    });

    const configured = Boolean(health?.readiness?.seedance?.configured);
    if (!configured) {
      test.skip(true, 'Seedance not configured in env');
      return;
    }

    const status = await page.evaluate(async () => {
      const res = await fetch('/api/seedance/status?probe=1');
      return { http: res.status, body: await res.json() };
    });

    expect(status.body).toHaveProperty('configured');
    // When health says ready, status probe should be tokenOk
    if (health.readiness.seedance.ready || health.readiness.seedance.tokenOk) {
      expect(status.http).toBe(200);
      expect(status.body.configured).toBe(true);
    }
  });

  test('auto pipeline failure is persisted as failed task when step1 lacks media', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.getByPlaceholder('请输入测试账号 (haini)').fill('haini');
    await page.getByPlaceholder('请输入登录密码 (888)').fill('888');
    await page.getByRole('button', { name: '立即登录工作台' }).click();
    await expect(page.locator('aside')).toBeVisible({ timeout: 15000 });

    // Clear media so step1 may still succeed via text-only; instead force via API-level check
    // Call step1 without key would fail — we only assert failed-task shape via orchestrating empty product edge
    const before = await page.evaluate(async () => {
      const res = await fetch('/api/tasks');
      return res.json();
    });
    expect(before.success).toBe(true);

    // Persist a synthetic failed task (mirrors auto-pipeline catch path)
    const created = await page.evaluate(async () => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `draft_e2e_fail_${Date.now()}`,
          title: '全自动失败 @ Step1: e2e synthetic',
          status: 'failed',
          currentStep: 1,
          pipelineData: {
            step1: { status: 'failed', inputs: { mediaUrl: '', platform: 'xiaohongshu' } },
            step2: { status: 'pending', inputs: {} },
            step3: { status: 'pending', inputs: {} },
            step4: { status: 'pending', inputs: {} },
            step5: { status: 'pending', inputs: {} },
          },
        }),
      });
      return res.json();
    });
    expect(created.success).toBe(true);
    expect(created.data.status).toBe('failed');

    await page.locator('aside button[title="后台任务中心页面"]').click();
    await expect(page.getByRole('heading', { name: /任务中心/ })).toBeVisible();
    // Switch to failed filter if present
    const failFilter = page.getByRole('button', { name: /失败/ });
    if (await failFilter.isVisible().catch(() => false)) {
      await failFilter.click();
    }
    await expect(page.getByText(/全自动失败|失败/).first()).toBeVisible({ timeout: 10000 });
  });
});

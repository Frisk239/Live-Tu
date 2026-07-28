import { test, expect } from '@playwright/test';

/**
 * Phase smoke: login + navigation + APIs (no long AI / Seedance waits).
 * Requires: npm run dev on http://localhost:3004
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

test.describe('BUV workbench smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aigc_onboarding_completed', 'true');
      localStorage.removeItem('aigc_is_logged_in');
    });
    await page.goto(BASE);
  });

  async function login(page: import('@playwright/test').Page) {
    await page.getByPlaceholder('请输入测试账号 (haini)').fill('haini');
    await page.getByPlaceholder('请输入登录密码 (888)').fill('888');
    await page.getByRole('button', { name: '立即登录工作台' }).click();
    const closeGuide = page.locator('button[title="关闭引导"]');
    if (await closeGuide.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeGuide.click();
    }
    await expect(page.locator('aside')).toBeVisible({ timeout: 15000 });
  }

  test('login and core sidebar views', async ({ page }) => {
    await expect(page).toHaveTitle(/爆款视频/);
    await login(page);

    await expect(page.getByText(/5步反推生成工作台/).first()).toBeVisible();

    // Wait bootstrap products so Knowledge page has data
    await page.waitForFunction(async () => {
      const res = await fetch('/api/products');
      const json = await res.json();
      return Array.isArray(json.data) && json.data.length > 0;
    }, { timeout: 15000 });

    const health = await page.evaluate(async () => {
      const res = await fetch('/api/health');
      return res.json();
    });
    expect(health.status).toBe('ok');
    expect(health.readiness?.yunwu).toBeTruthy();

    // Use title attributes on sidebar buttons for stable navigation
    const pages: Array<{ title: string; heading: RegExp }> = [
      { title: '视频素材库页面', heading: /爆款短视频与图片素材库/ },
      { title: '后台任务中心页面', heading: /后台渲染与反推任务中心/ },
      { title: '爆款视频与反推预设', heading: /爆款短视频模版与反推预设库/ },
      { title: '大模型与提示词配置页面', heading: /大模型与提示词规则配置中心/ },
      { title: '确权 BGM 曲库管理', heading: /确权 BGM 曲库/ },
      { title: '卖点库与品牌知识中心', heading: /品牌卖点与知识资产库/ },
    ];

    for (const p of pages) {
      await page.locator(`aside button[title="${p.title}"]`).click();
      await expect(page.getByRole('heading', { name: p.heading })).toBeVisible({ timeout: 10000 });
    }

    await page.locator('aside button[title="5步短视频反推与生成主工程"]').click();
    await expect(page.getByText(/工作台绑定卖点|第 1 步/).first()).toBeVisible({ timeout: 10000 });

    const apis = await page.evaluate(async () => {
      const [prod, pr, t, b] = await Promise.all([
        fetch('/api/products').then((r) => r.json()),
        fetch('/api/presets').then((r) => r.json()),
        fetch('/api/tasks').then((r) => r.json()),
        fetch('/api/bgm').then((r) => r.json()),
      ]);
      return {
        products: prod.data?.length ?? 0,
        ok: prod.success && pr.success && t.success && b.success,
      };
    });
    expect(apis.ok).toBe(true);
    expect(apis.products).toBeGreaterThan(0);
  });

  test('load preset into pipeline', async ({ page }) => {
    await login(page);

    await page.locator('aside button[title="爆款视频与反推预设"]').click();
    await expect(page.getByRole('heading', { name: /反推预设库/ })).toBeVisible({ timeout: 10000 });

    const loadBtn = page.getByText('载入流水线').first();
    if (await loadBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await loadBtn.click();
      await expect(page.getByText(/工作台绑定卖点|第 1 步/).first()).toBeVisible({ timeout: 10000 });
    }
  });
});

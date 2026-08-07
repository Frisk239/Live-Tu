import { test, expect } from '@playwright/test';

/**
 * Phase smoke: login + navigation + APIs (no long AI / Seedance waits).
 * Requires: npm run dev on http://localhost:3004
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

test.describe('BUV workbench smoke', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => console.log(`[browser console] ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', (err) => console.error(`[browser error] ${err.message}`));
    await page.addInitScript(() => {
      localStorage.setItem('aigc_onboarding_completed', 'true');
      localStorage.removeItem('aigc_is_logged_in');
    });
    await page.goto(BASE);
  });

  async function login(page: import('@playwright/test').Page) {
    // The development fixture uses haini/888 for operator checks and admin/888
    // for this full-module smoke flow.
    await page.getByPlaceholder('请输入账号').fill('admin');
    await page.getByPlaceholder('请输入登录密码').fill('888');
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

    const pages: Array<{ title: string; heading: RegExp }> = [
      { title: '确权 BGM 曲库管理', heading: /确权 BGM 曲库/ },
      { title: '视频素材库页面', heading: /爆款短视频与素材库/ },
      { title: '后台任务中心页面', heading: /后台渲染与反推任务中心/ },
      { title: '8 大黄金爆款示范模板库与 AI 全链路反推', heading: /黄金爆款示范模板库/ },
      { title: '大模型与提示词配置页面', heading: /大模型与提示词规则配置中心/ },
      { title: '卖点库与品牌知识中心', heading: /品牌卖点与知识资产库/ },
    ];

    for (const p of pages) {
      const btn = page.locator(`aside button[title="${p.title}"]`).first();
      await btn.scrollIntoViewIfNeeded();
      await btn.click({ force: true });
      await page.waitForTimeout(500);
      await expect(page.locator('h1').filter({ hasText: p.heading }).first()).toBeVisible({ timeout: 10000 });
      if (p.title === '后台任务中心页面') {
        await expect(page.getByRole('heading', { name: '生产运行记录' })).toBeVisible();
        // 隔离数据库没有任何历史 run（S0：测试不依赖开发库残留状态）。
        // 创建一个 queued run（服务器 PIPELINE_WORKER_DISABLED=true，不会产生真实付费调用），
        // 再点「刷新」让 Step x/5 渲染确定存在。
        await page.evaluate(async () => {
          await fetch('/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `smoke-${Date.now()}` },
            body: JSON.stringify({
              pipelineData: {
                step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
                step2: { inputs: {} },
                step3: { inputs: {} },
                step4: { inputs: {} },
                step5: { inputs: {} },
              },
              productId: 'prod_buv_cleanser',
            }),
          });
        });
        await page.getByRole('button', { name: '刷新' }).click();
        await expect(page.getByText(/Step [1-5]\/5/).first()).toBeVisible();
      }
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

    await page.locator('aside button[title="8 大黄金爆款示范模板库与 AI 全链路反推"]').click();
    await expect(page.getByRole('heading', { name: /黄金爆款示范模板库/ })).toBeVisible({ timeout: 10000 });

    const loadBtn = page.getByText('载入流水线').first();
    if (await loadBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await loadBtn.click();
      await expect(page.getByText(/工作台绑定卖点|第 1 步/).first()).toBeVisible({ timeout: 10000 });
    }
  });
});

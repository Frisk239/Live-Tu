import { test, expect } from '@playwright/test';

/**
 * S0 P0 回归：API 故障绝不能静默表现为「数据被清空」。
 * 场景：首次 bootstrap 时素材接口 500 ——
 *   1. 必须出现显式错误 banner（不静默空态）；
 *   2. banner 提供「重试加载」入口；重试真正重跑 bootstrap（产品接口成功 → 产品数据写回）；
 *   3. 失败的素材接口不写回，同时 banner 持续可见。
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

test.describe('S0 API 故障显式提示 + 重试 (P0)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aigc_onboarding_completed', 'true');
      localStorage.removeItem('aigc_is_logged_in');
    });
  });

  test('素材接口 500：错误 banner 出现、重试可用、产品数据不被清空', async ({ page }) => {
    // 素材接口一律 500（从首次 bootstrap 起），产品等其他接口正常
    // bootstrap 实际走 /api/v1/materials 别名，拦截两种前缀（'**/materials' 通配）
    await page.route('**/materials', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"error":"injected 500"}' })
    );

    await page.goto(BASE);
    await page.getByPlaceholder('请输入账号').fill('admin');
    await page.getByPlaceholder('请输入登录密码').fill('888');
    await page.getByRole('button', { name: '立即登录工作台' }).click();

    // P0 断言 1：错误 banner 显式出现（绝不静默渲染成「素材被清空」）
    const banner = page.getByText(/部分数据加载失败/).first();
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/素材库/).first()).toBeVisible();

    // P0 断言 2：重试入口可用；重试会重跑 bootstrap ——
    // 产品接口成功 → 产品数据写回（侧栏产品选择器出现），banner 仍可见（素材仍失败）
    await page.getByRole('button', { name: '重试加载' }).click();
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(page.locator('aside select').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('aside select option').first()).toHaveText(/BUV/);

    // P0 断言 3：失败接口不写回 —— 素材页不显示「清空」后的静默态，而是保留 banner 提示
    await page.locator('aside button[title="视频素材库页面"]').click();
    await expect(page.locator('h1').filter({ hasText: /爆款短视频与素材库/ })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/部分数据加载失败/).first()).toBeVisible();
  });
});

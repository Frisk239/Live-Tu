import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

/**
 * UI: Step5 blockers + draft chip navigation.
 */
test.describe('Step5 readiness & draft UX', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('aigc_onboarding_completed', 'true');
    });
    await page.goto(BASE);
    await page.getByPlaceholder('请输入账号').fill('haini');
    await page.getByPlaceholder('请输入登录密码').fill('888');
    await page.getByRole('button', { name: '立即登录工作台' }).click();
    await expect(page.locator('aside')).toBeVisible({ timeout: 15000 });
  });

  test('step5 shows blockers without video source', async ({ page }) => {
    // Jump to step 5 via progress strip
    await page.getByRole('button', { name: /第 5 步/ }).first().click();
    await expect(page.getByText(/第 5 步：视频|合成输出成品|聚合全链路/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Expect blocker banner (no Step2 video on fresh pipeline)
    const blocker = page.getByText(/合成前置条件未满足|缺少 Step2 视频源|未检测到 FFmpeg/i);
    await expect(blocker.first()).toBeVisible({ timeout: 10000 });

    // Target the Step5 card primary action only (not step strip / other "运行")
    const runBtn = page.getByRole('button', { name: '运行合成' });
    await expect(runBtn).toBeVisible({ timeout: 5000 });
    await expect(runBtn).toBeDisabled();
  });

  test('draft save label opens the persisted task center', async ({ page }) => {
    const sample = page.getByRole('button', { name: /晨间阳光浴室/ });
    await expect(sample).toBeVisible({ timeout: 10_000 });
    await sample.click();

    const chip = page.getByRole('button', { name: /草稿已保存/ });
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.click();
    await expect(page.getByRole('heading', { name: /任务中心/ })).toBeVisible({
      timeout: 10_000,
    });
  });
});

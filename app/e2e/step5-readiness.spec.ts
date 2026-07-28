import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

/**
 * UI: Step5 blockers + draft chip navigation.
 */
test.describe('Step5 readiness & draft UX', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aigc_onboarding_completed', 'true');
      localStorage.removeItem('aigc_is_logged_in');
    });
    await page.goto(BASE);
    await page.getByPlaceholder('请输入测试账号 (haini)').fill('haini');
    await page.getByPlaceholder('请输入登录密码 (888)').fill('888');
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

  test('draft save label can open tasks when present', async ({ page }) => {
    // Trigger a draft by setting media via sample if available
    const sample = page.getByText(/晨间阳光浴室|小红书爆款/).first();
    if (await sample.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sample.click();
      // wait debounce draft
      await page.waitForTimeout(2500);
      const chip = page.getByRole('button', { name: /草稿已保存/ });
      if (await chip.isVisible({ timeout: 5000 }).catch(() => false)) {
        await chip.click();
        await expect(page.getByRole('heading', { name: /任务中心/ })).toBeVisible({ timeout: 10000 });
      }
    } else {
      test.skip(true, 'no sample media to trigger draft');
    }
  });
});

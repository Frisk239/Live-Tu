import { expect, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

test.describe('production UX accessibility gates', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aigc_onboarding_completed', 'true');
      localStorage.removeItem('aigc_is_logged_in');
    });
    await page.goto(BASE);
  });

  test('login form has correct semantics, focus order and error announcement', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    const username = page.getByLabel('账号 (Username)');
    const password = page.getByLabel('密码 (Password)');
    await expect(username).toHaveAttribute('autocomplete', 'username');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');

    await page.keyboard.press('Tab');
    await expect(username).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(password).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '立即登录工作台' })).toBeFocused();

    await username.fill('missing-user');
    await password.fill('wrong-password');
    await page.getByRole('button', { name: '立即登录工作台' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test('mobile layout has no horizontal overflow and interactive buttons are named', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('账号 (Username)').fill('haini');
    await page.getByLabel('密码 (Password)').fill('888');
    await page.getByRole('button', { name: '立即登录工作台' }).click();
    await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });

    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      unnamedButtons: [...document.querySelectorAll('button')].filter(
        (button) =>
          !(button.getAttribute('aria-label') ||
            button.getAttribute('title') ||
            button.textContent ||
            '').trim()
      ).length,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.unnamedButtons).toBe(0);
  });

  test('workspace dialog traps focus, closes with Escape and restores focus', async ({ page }) => {
    await page.getByLabel('账号 (Username)').fill('haini');
    await page.getByLabel('密码 (Password)').fill('888');
    await page.getByRole('button', { name: '立即登录工作台' }).click();
    await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });

    const opener = page.getByRole('button', { name: /会话与历史工作区/ });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: /工作台会话管理中心/ });
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await expect(dialog.getByRole('button', { name: '新建工作区' })).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  });
});

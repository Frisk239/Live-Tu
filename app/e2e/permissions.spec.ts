import { expect, Page, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

type MockUser = {
  id: string;
  username: string;
  role: 'admin' | 'operator';
  permissions: string[];
};

async function installAuthApiMock(page: Page, user: MockUser) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname.endsWith('/auth/me')) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: '请先登录' }),
      });
      return;
    }
    if (pathname.endsWith('/auth/login')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, user }),
      });
      return;
    }
    if (pathname.endsWith('/auth/logout')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
      return;
    }
    if (pathname.endsWith('/models/config')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          textModels: [],
          imageModels: [],
          videoModels: [],
        }),
      });
      return;
    }
    if (pathname.endsWith('/health')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', readiness: {} }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });
}

async function login(page: Page, user: MockUser, persistedView: string = 'pipeline') {
  await page.addInitScript((view) => {
    localStorage.setItem('aigc_onboarding_completed', 'true');
    localStorage.setItem('aigc_active_view', view);
  }, persistedView);
  await installAuthApiMock(page, user);
  await page.goto(BASE);
  await page.getByLabel('账号 (Username)').fill(user.username);
  await page.getByLabel('密码 (Password)').fill('permission-test-password');
  await page.getByRole('button', { name: '立即登录工作台' }).click();
  await expect(page.locator('aside')).toBeVisible();
}

test.describe('permission-driven frontend module gates', () => {
  test('operator only sees modules explicitly granted and forbidden persisted view falls back', async ({
    page,
  }) => {
    await login(
      page,
      {
        id: 'operator-limited',
        username: 'operator-limited',
        role: 'operator',
        permissions: [
          'module.pipeline.read',
          'module.pipeline.write',
          'module.materials.read',
          'module.tasks.read',
          'module.presets.read',
        ],
      },
      'models'
    );

    await expect(page.getByRole('button', { name: /5步反推生成工作台/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /视频素材库/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /历史会话全集/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /8大爆款模版库/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /模型配置中心/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /卖点库 & AI润色/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /BGM 确权曲库/ })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('aigc_active_view'))).toBe(
      'pipeline'
    );
  });

  test('admin role alone does not grant modules omitted from permissions', async ({ page }) => {
    await login(page, {
      id: 'admin-limited',
      username: 'admin-limited',
      role: 'admin',
      permissions: ['module.pipeline.read'],
    });

    await expect(page.getByRole('button', { name: /5步反推生成工作台/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /模型配置中心/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /卖点库 & AI润色/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /BGM 确权曲库/ })).toHaveCount(0);
  });

  test('operator can see a privileged module when its read permission is explicitly granted', async ({
    page,
  }) => {
    await login(page, {
      id: 'operator-models',
      username: 'operator-models',
      role: 'operator',
      permissions: ['module.pipeline.read', 'module.models.read'],
    });

    await expect(page.getByRole('button', { name: /模型配置中心/ })).toBeVisible();
  });
});

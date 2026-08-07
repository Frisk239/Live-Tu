import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Materials UX 验收（Roadmap P1-1 S4.1/S4.2/S4.4）：
 *  - 单素材上传 → 预览 → X 删除 → 工作台清空 + 后端文件/记录同步消失
 *  - 批量队列上传多文件 → 队列项实时入队 → 删除单项同步后端、其余项保留
 * Requires: npm run dev on http://localhost:3004（login haini/888）
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';
const FIXTURE_A = fileURLToPath(new URL('./fixtures/ux-sample.png', import.meta.url));
const FIXTURE_B = fileURLToPath(new URL('./fixtures/ux-sample-2.png', import.meta.url));

async function login(page: Page) {
  // 跳过登录后的新手引导弹窗（避免遮挡点击）
  await page.addInitScript(() => {
    localStorage.setItem('aigc_onboarding_completed', 'true');
  });
  await page.goto(BASE);
  await page.getByPlaceholder('请输入账号').fill('haini');
  await page.getByPlaceholder('请输入登录密码').fill('888');
  await page.getByRole('button', { name: '立即登录工作台' }).click();
  await expect(page.locator('aside button[title="5步短视频反推与生成主工程"]')).toBeVisible();
}

/** page.request 与浏览器上下文共享 session cookie，可用于 API 断言 */
async function findMaterial(page: Page, name: string) {
  const res = await page.request.get(`${BASE}/api/materials`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return (body.data || []).find((m: any) => m.name === name);
}

test.describe('素材上传/删除 UX 链路', () => {
  test('单素材：上传 → 预览 → X 删除 → 空态 + 后端文件消失', async ({ page }) => {
    const name = `ux-e2e-single-${Date.now()}.png`;
    await login(page);

    // 单素材模式上传（Step1 默认视图；S2 工作台首页也有 video/* 输入框，须精确定位 Step1 单素材输入）
    await page
      .getByTestId('step1-single-upload-input')
      .setInputFiles({ name, mimeType: 'image/png', buffer: fs.readFileSync(FIXTURE_A) });

    // 预览出现（上传完成后 mediaUrl 注入）
    await expect(page.locator('img[alt="Uploaded source"]')).toBeVisible({ timeout: 15_000 });
    // 后端素材行存在
    expect(await findMaterial(page, name)).toBeTruthy();

    // X 删除（本地上传 → 同步删后端文件）
    await page.locator('button[title="移除素材（本地上传将同时删除文件）"]').click();
    await expect(page.getByText('拖拽视频/图片至此，或点击本地上传')).toBeVisible();

    // 后端记录已删除（轮询等待异步删除完成，避免竞态 flaky）
    await expect
      .poll(async () => (await findMaterial(page, name)) === undefined, {
        timeout: 10_000,
        message: '删除请求完成后后端素材记录应消失',
      })
      .toBe(true);
  });

  test('批量队列：多文件上传 → 删除单项同步后端、其余保留', async ({ page }) => {
    const nameA = `ux-e2e-batch-a-${Date.now()}.png`;
    const nameB = `ux-e2e-batch-b-${Date.now()}.png`;
    await login(page);

    // 切到批量模式并上传两个文件
    await page.getByRole('button', { name: /批量并发反推/ }).click();
    await page
      .locator('input[accept="video/*,image/*"][multiple]')
      .setInputFiles([
        { name: nameA, mimeType: 'image/png', buffer: fs.readFileSync(FIXTURE_A) },
        { name: nameB, mimeType: 'image/png', buffer: fs.readFileSync(FIXTURE_B) },
      ]);

    // 两项上传完成后均为「等待处理」（精确匹配，排除统计面板的「等待处理 (N)」标签）
    await expect(page.getByText('可视化任务队列明细')).toBeVisible();
    await expect(page.getByText('等待处理', { exact: true })).toHaveCount(2, {
      timeout: 15_000,
    });

    // 删除第一项（本地上传项 → 同步删后端文件）
    await page
      .locator('button[title="从队列删除（本地上传文件将一并删除）"]')
      .first()
      .click();
    await expect(page.getByText('等待处理', { exact: true })).toHaveCount(1);

    // 后端：第一项消失、第二项保留
    expect(await findMaterial(page, nameA)).toBeFalsy();
    expect(await findMaterial(page, nameB)).toBeTruthy();
  });
});

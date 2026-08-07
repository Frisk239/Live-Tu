import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * S2 工作台 E2E 门禁（跑在独立服务器：FAKE_VIDEO_PROVIDER=true + FAKE_VIDEO_FAIL_NEXT=1
 * + PIPELINE_WORKER_DISABLED=true，绝不触发真实付费调用）：
 * - 双上传起点（主 CTA 只保留「上传爆款视频 / 上传我的产品」，预设为次级入口）；
 * - 三档自主模式与独立付费授权（默认关闭，切换模式不改变授权）；
 * - 拆片/分镜确认点、提交前预检（成本/余额/等待/能力/素材/策略）、批量提交；
 * - 单镜失败局部重试（成功镜头不回滚）；
 * - 刷新恢复（服务端真实状态）；保存失败阻止切换（offline_retry + 重试保存）；
 * - 移动端底部导航 + 无横向溢出；关键路径键盘操作 + axe critical/serious = 0。
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

async function login(page: import('@playwright/test').Page) {
  await page.getByPlaceholder('请输入账号').fill('admin');
  await page.getByPlaceholder('请输入登录密码').fill('888');
  await page.getByRole('button', { name: '立即登录工作台' }).click();
  await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
}

/** 上传 fixture 图片 → 返回 material url（本地文件，预检可 verified） */
async function uploadFixtureMaterial(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.post(`${BASE}/api/materials/upload-file`, {
    multipart: {
      file: { name: 'workbench-e2e.png', mimeType: 'image/png', buffer: await readFixture() },
    },
  });
  const json = await res.json();
  expect(json.success).toBe(true);
  const url = json.data?.url;
  expect(typeof url).toBe('string');
  return url;
}

async function readFixture(): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  return readFile(path.resolve(process.cwd(), 'e2e/fixtures/ux-sample.png'));
}

/** 通过 step2 多镜头分支创建 pending 镜头任务（LLM 不可用时自动回落默认 prompt） */
async function createShotTasks(
  page: import('@playwright/test').Page,
  frameUrl: string,
  count = 2
): Promise<string> {
  const shotList = Array.from({ length: count }, (_, i) => ({
    shotIndex: i + 1,
    shotType: i === 0 ? 'close-up' : 'wide',
    cameraMovement: 'push-in',
    description: `e2e shot ${i + 1}`,
    keyframeUrl: frameUrl,
  }));
  const res = await page.request.post(`${BASE}/api/pipeline/step2`, {
    data: { productInfo: { name: 'E2E Product' }, shotList },
  });
  const json = await res.json();
  expect(res.status(), JSON.stringify(json)).toBe(200);
  const sessionId = json.data?.multiShotResult?.sessionId;
  expect(typeof sessionId).toBe('string');
  return sessionId;
}

/** 创建产品 + 附加 1 个产品资产（Spec2：服务端按真实 product_assets 做预检计数） */
async function createProductWithAsset(
  page: import('@playwright/test').Page,
  frameUrl: string
): Promise<string> {
  const res = await page.request.post(`${BASE}/api/products`, {
    data: { name: 'E2E 测试产品', positioning: '卖点', price: '¥99' },
  });
  const json = await res.json();
  expect(res.ok(), JSON.stringify(json)).toBe(true);
  const productId = json.data?.id ?? json.id;
  expect(typeof productId).toBe('string');
  const attach = await page.request.post(`${BASE}/api/products/${productId}/assets`, {
    data: { url: frameUrl, role: 'hero' },
  });
  const attachJson = await attach.json();
  expect(attach.status(), JSON.stringify(attachJson)).toBe(201);
  return productId;
}

/** 保存工作台草稿到服务端（分镜计划 + 候选 + 模型），刷新后由服务端草稿恢复 */
async function saveServerDraft(
  page: import('@playwright/test').Page,
  opts: { sessionId: string; frameUrl: string; count?: number; autonomyMode?: string; productId?: string }
) {
  const shots = Array.from({ length: opts.count ?? 2 }, (_, i) => ({
    shotIndex: i + 1,
    startTime: i * 5,
    endTime: (i + 1) * 5,
    shotSize: i === 0 ? 'close_up' : 'wide',
    cameraPosition: 'front',
    cameraMovement: 'push_in',
    lighting: 'soft',
    dialogue: [],
    soundEffects: [],
    mustKeep: ['产品包装'],
    mustReplace: ['竞品 logo'],
    generationMode: 'image_to_video',
    capabilityConstraints: {
      maxDurationSec: 5,
      minDurationSec: 3,
      supportedAspectRatios: ['9:16'],
      supportedResolutions: ['720p'],
      requiredReferenceInputs: 1,
    },
    status: 'pending',
    blockers: [],
    warnings: [],
    evidence: [],
    candidates: [
      { id: `cand-${i + 1}`, url: opts.frameUrl, prompt: 'e2e frame', model: 'GPT Image 2', createdAt: Date.now() },
    ],
    selectedCandidateId: `cand-${i + 1}`,
    promptOverride: null,
    modelId: 'Seedance 2.0 Fast',
  }));
  const res = await page.request.post(`${BASE}/api/workbench/draft`, {
    data: {
      sessionId: opts.sessionId,
      draftJson: JSON.stringify({
        shots,
        videoModelId: 'Seedance 2.0 Fast',
        referenceInputCount: 1,
        productId: opts.productId ?? null,
      }),
      autonomyMode: opts.autonomyMode ?? 'confirm_key_points',
    },
  });
  const json = await res.json();
  expect(res.status(), JSON.stringify(json)).toBe(200);
  return shots;
}

test.describe('S2 爆款复刻工作台', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aigc_onboarding_completed', 'true');
      localStorage.removeItem('aigc_is_logged_in');
    });
    await page.goto(BASE);
  });

  test('双上传起点：主 CTA 只有两个，预设/素材库为次级入口', async ({ page }) => {
    await login(page);
    const home = page.getByTestId('workbench-home');
    await expect(home).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('upload-viral-cta')).toBeVisible();
    await expect(page.getByTestId('upload-product-cta')).toBeVisible();
    // 次级入口存在但不抢占主路径
    await expect(page.getByTestId('preset-secondary-entry')).toBeVisible();
    await expect(home.getByText('上传爆款视频，生成你的专属复刻成片')).toBeVisible();
  });

  test('三档自主模式与独立付费授权：切换模式绝不改变授权，服务端持久化（刷新恢复）', async ({
    page,
  }) => {
    await login(page);
    const toggle = page.getByTestId('paid-auth-toggle');
    // 默认关闭（独立授权）
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    // 选「逐步控制」→ 付费授权保持关闭
    await page.getByLabel('自主模式').getByText('逐步控制').click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    // 显式开启付费授权 → 切换「关键节点确认」→ 授权保持开启
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('自主模式').getByText('关键节点确认').click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // 服务端持久化：直接查询 API 验证
    const state = await page.evaluate(async () => {
      const res = await fetch('/api/workbench/state');
      return res.json();
    });
    expect(state.data.autonomyMode).toBe('confirm_key_points');
    expect(state.data.paidAuthorization.enabled).toBe(true);
    // 刷新恢复（证据 #7）
    await page.reload();
    await expect(page.getByTestId('paid-auth-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('自主模式').getByText('关键节点确认')).toBeChecked();
  });

  test('完整旅程：拆解/分镜确认 → 预检（成本/余额/等待/能力/素材/策略）→ 批量提交 → 单镜重试 → 刷新恢复', async ({
    page,
  }) => {
    await login(page);
    const frameUrl = await uploadFixtureMaterial(page);
    // Spec2：预检按真实 product_assets 计数——先建产品并附加资产（否则 missing_product_asset 阻断）
    const productId = await createProductWithAsset(page, frameUrl);
    const sessionId = await createShotTasks(page, frameUrl, 2);
    // Spec3：三档差异——逐步控制 = 三个确认点全显式（本测试手动走完每个确认点）；
    // （confirm_key_points 会自动确认拆解结果，不适合手动点击流程）
    await saveServerDraft(page, { sessionId, frameUrl, count: 2, productId, autonomyMode: 'step_by_step' });
    // 刷新：分镜计划从服务端草稿恢复（不依赖 localStorage）
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });

    // 拆解结果确认点
    const confirmDeconstruction = page.getByTestId('confirm-deconstruction');
    await expect(confirmDeconstruction).toBeVisible();
    await page.getByTestId('confirm-deconstruction-btn').scrollIntoViewIfNeeded();
    await page.getByTestId('confirm-deconstruction-btn').click();
    await expect(confirmDeconstruction).toBeHidden();

    // 分镜计划确认点
    await expect(page.getByTestId('shot-plan-table')).toBeVisible();
    await page.getByTestId('confirm-shot-plan').scrollIntoViewIfNeeded();
    await page.getByTestId('confirm-shot-plan').click();
    await expect(page.getByText('已确认', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    // 提交前预检：成本逐镜 + 合计（2 镜 × $0.18 = $0.36）、unknown 实际成本、余额、等待、能力、素材、策略
    await page.getByTestId('run-preflight').scrollIntoViewIfNeeded();
    await page.getByTestId('run-preflight').click();
    const panel = page.getByTestId('preflight-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('preflight-can-submit')).toContainText('可以提交');
    await expect(page.getByTestId('shot-cost-1')).toContainText('$0.18');
    await expect(page.getByTestId('shot-cost-2')).toContainText('$0.18');
    await expect(page.getByTestId('preflight-total-cost')).toContainText('$0.36');
    await expect(page.getByTestId('preflight-actual-cost')).toContainText('unknown');
    await expect(page.getByTestId('balance-status')).toContainText('无法验证余额');
    await expect(page.getByTestId('wait-estimate')).toContainText('分钟');
    await expect(panel.getByText('减成本策略')).toBeVisible();
    // provider 不支持的策略禁用并解释（不展示假能力）
    await expect(panel.getByText(/免费排队/)).toBeVisible();
    await expect(panel.getByText(/不支持：provider 不支持免费排队通道/)).toBeVisible();
    await expect(panel.getByText(/付费加速/)).toBeVisible();
    await expect(panel.getByText(/不支持：provider 不支持付费加速/)).toBeVisible();

    // 批量提交需要付费授权（默认关闭时按钮禁用）
    await expect(page.getByTestId('confirm-batch-submit')).toBeDisabled();
    await page.getByTestId('paid-auth-toggle').scrollIntoViewIfNeeded();
    await page.getByTestId('paid-auth-toggle').click();
    await expect(page.getByTestId('paid-auth-toggle')).toHaveAttribute('aria-checked', 'true');

    // 预检后继续编辑：批量提交必须先保存最新草稿，再调用 confirm。
    const paidWriteOrder: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST') return;
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith('/workbench/draft')) paidWriteOrder.push('draft');
      if (pathname.endsWith('/workbench/confirm')) paidWriteOrder.push('confirm');
    });
    await page.getByTestId('shot-row-2').scrollIntoViewIfNeeded();
    await page.getByTestId('shot-row-2').click();
    await page.getByTestId('shot-detail-2').getByText('高级：编辑该镜生成参数（JSON/prompt 默认折叠）').click();
    await page.getByTestId('shot-detail-2').getByText('编辑 prompt').click();
    await page.getByTestId('shot-detail-2').getByLabel('第 2 镜 prompt').fill('e2e latest prompt before submit');
    await page.getByTestId('shot-detail-2').getByText('应用修改').click();
    await page.getByTestId('shot-row-2').click();

    // 批量提交（FAKE_VIDEO_FAIL_NEXT=1：第 1 镜失败、第 2 镜成功）
    await page.getByTestId('confirm-batch-submit').scrollIntoViewIfNeeded();
    await page.getByTestId('confirm-batch-submit').click();
    await expect(page.getByText(/批量提交完成/).first()).toBeVisible({ timeout: 15_000 });
    expect(paidWriteOrder.slice(-2)).toEqual(['draft', 'confirm']);
    // 第 2 镜成功，第 1 镜失败 → 仅重试第 1 镜（成功镜头不回滚）
    await page.getByTestId('shot-row-2').scrollIntoViewIfNeeded();
    await page.getByTestId('shot-row-2').click();
    await expect(page.getByText('已生成成功，不会因其他镜头失败回滚').first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('shot-row-1').scrollIntoViewIfNeeded();
    await page.getByTestId('shot-row-1').click();
    const retryButton = page.getByTestId('retry-shot-1');
    await expect(retryButton).toBeVisible({ timeout: 15_000 });
    await retryButton.scrollIntoViewIfNeeded();
    await retryButton.click();
    await expect(page.getByTestId('retry-shot-1')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId('shot-detail-1').getByText('已生成成功，不会因其他镜头失败回滚')).toBeVisible({ timeout: 15_000 });

    // 服务端状态核对：全部 completed，且成功镜头未重复提交（fake seam 捕获）
    const state = await page.evaluate(async (sid) => {
      const res = await fetch(`/api/workbench/state?sessionId=${encodeURIComponent(sid)}`);
      const json = await res.json();
      return { shots: json.data.shotStates, confirms: json.data.confirms };
    }, sessionId);
    expect(state.shots.map((s: any) => s.status).sort()).toEqual(['completed', 'completed']);
    expect(state.confirms.deconstruction).toBe(true);
    expect(state.confirms.shot_plan).toBe(true);
    expect(state.confirms.batch_submit).toBe(true);

    // 刷新恢复：镜头状态与确认点来自服务端真实状态（证据 #7）
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('shot-row-1').scrollIntoViewIfNeeded();
    await page.getByTestId('shot-row-1').click();
    await expect(page.getByText('已生成成功，不会因其他镜头失败回滚').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('safe-to-leave')).toContainText('可安全离开');
  });

  test('保存失败阻止切换 + offline_retry 重试保存（保留旧数据，不闪空态）', async ({ page }) => {
    await login(page);
    const frameUrl = await uploadFixtureMaterial(page);
    const sessionId = await createShotTasks(page, frameUrl, 1);
    // step_by_step：无自动确认动作，保证「刷新后不触发自动保存」的确定性
    await saveServerDraft(page, { sessionId, frameUrl, count: 1, autonomyMode: 'step_by_step' });
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });

    // 让工作台草稿保存失败（500；glob 匹配浏览器实际请求 URL——VITE_API_BASE_URL=/api/v1）
    await page.route('**/api/v1/workbench/draft', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: '模拟保存故障' }) })
    );
    // 先做一次分镜局部编辑（标记 dirty）→ 再切换产品触发保存守卫
    await page.getByTestId('shot-row-1').scrollIntoViewIfNeeded();
    await page.getByTestId('shot-row-1').click();
    await page.getByTestId('shot-detail-1').getByText('高级：编辑该镜生成参数（JSON/prompt 默认折叠）').scrollIntoViewIfNeeded();
    await page.getByTestId('shot-detail-1').getByText('高级：编辑该镜生成参数（JSON/prompt 默认折叠）').click();
    await page.getByTestId('shot-detail-1').getByText('编辑 prompt').scrollIntoViewIfNeeded();
    await page.getByTestId('shot-detail-1').getByText('编辑 prompt').click();
    await page.getByTestId('shot-detail-1').getByLabel('第 1 镜 prompt').fill('e2e edited prompt');
    await page.getByTestId('shot-detail-1').getByText('应用修改').click();
    // 切换产品 → saveCurrentDraftBeforeTransition → ensureSaved（此时 draft 保存被拦截）
    await page.locator('select').filter({ hasText: /切换产品: / }).first().selectOption({ index: 1 });
    // 保存失败必须阻止切换：SaveState = offline_retry + 错误提示 + 仍停留在工作台（证据 #8）
    await expect(page.getByTestId('save-state-badge')).toContainText('保存失败，等待重试', { timeout: 10_000 });
    await expect(page.getByText(/工作台草稿尚未保存，已取消切换/).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('shot-plan-table')).toBeVisible();
    await expect(page.getByTestId('workbench-home')).toBeVisible();
    // 恢复后重试保存 → saved（移除全部路由拦截）
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: '重试保存' }).click();
    await expect(page.getByTestId('save-state-badge')).toContainText('已保存', { timeout: 10_000 });
  });

  test('Spec3：三档自主模式真实差异——managed 授权后自动预检提交；confirm_key_points 只自动拆解；step_by_step 全显式', async ({
    page,
  }) => {
    await login(page);
    const frameUrl = await uploadFixtureMaterial(page);
    const productId = await createProductWithAsset(page, frameUrl);
    const readConfirms = async (sid: string) => {
      const res = await fetch(`/api/workbench/state?sessionId=${encodeURIComponent(sid)}`);
      return (await res.json()).data.confirms;
    };

    // ---- managed：拆解/分镜自动确认；未授权绝不自动花钱 ----
    const sidManaged = await createShotTasks(page, frameUrl, 1);
    await saveServerDraft(page, { sessionId: sidManaged, frameUrl, count: 1, productId, autonomyMode: 'managed' });
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(readConfirms, sidManaged)).toMatchObject({
      deconstruction: true,
      shot_plan: true,
      batch_submit: false,
    });
    // 授权未开：运行预检后批量提交按钮仍禁用（managed 也不会绕开授权）
    await page.getByTestId('run-preflight').scrollIntoViewIfNeeded();
    await page.getByTestId('run-preflight').click();
    await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('confirm-batch-submit')).toBeDisabled({ timeout: 10_000 });
    // 开启授权 → managed 自动预检 + 批量提交（全自动闭环，无需手动点确认）
    await page.getByTestId('paid-auth-toggle').scrollIntoViewIfNeeded();
    await page.getByTestId('paid-auth-toggle').click();
    await expect
      .poll(() => page.evaluate(readConfirms, sidManaged), { timeout: 15_000 })
      .toMatchObject({ batch_submit: true });
    const managedState = await page.evaluate(async (sid) => {
      const res = await fetch(`/api/workbench/state?sessionId=${encodeURIComponent(sid)}`);
      return (await res.json()).data;
    }, sidManaged);
    expect(managedState.shotStates.every((s: any) => s.status === 'completed')).toBe(true);

    // ---- confirm_key_points：只自动确认拆解结果；分镜计划仍等用户 ----
    const sidCkp = await createShotTasks(page, frameUrl, 1);
    await saveServerDraft(page, { sessionId: sidCkp, frameUrl, count: 1, productId, autonomyMode: 'confirm_key_points' });
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(readConfirms, sidCkp)).toMatchObject({
      deconstruction: true,
      shot_plan: false,
    });

    // ---- step_by_step：三个确认点全部等待用户显式确认 ----
    const sidSbs = await createShotTasks(page, frameUrl, 1);
    await saveServerDraft(page, { sessionId: sidSbs, frameUrl, count: 1, productId, autonomyMode: 'step_by_step' });
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('confirm-deconstruction')).toBeVisible({ timeout: 10_000 });
    const sbsConfirms = await page.evaluate(readConfirms, sidSbs);
    expect(sbsConfirms).toMatchObject({ deconstruction: false, shot_plan: false });
  });

  test('Spec4：页面切换（侧栏）保存失败必须阻断，不丢失工作台', async ({ page }) => {
    await login(page);
    const frameUrl = await uploadFixtureMaterial(page);
    const sessionId = await createShotTasks(page, frameUrl, 1);
    await saveServerDraft(page, { sessionId, frameUrl, count: 1, autonomyMode: 'step_by_step' });
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });

    // 拦截草稿保存 → 500
    await page.route('**/api/v1/workbench/draft', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: '模拟保存故障' }) })
    );
    // 做一次局部编辑（标记 dirty）→ 点击侧栏「素材库」离开流水线
    await page.getByTestId('shot-row-1').scrollIntoViewIfNeeded();
    await page.getByTestId('shot-row-1').click();
    await page.getByTestId('shot-detail-1').getByText('高级：编辑该镜生成参数（JSON/prompt 默认折叠）').click();
    await page.getByTestId('shot-detail-1').getByText('编辑 prompt').click();
    await page.getByTestId('shot-detail-1').getByLabel('第 1 镜 prompt').fill('e2e edited prompt');
    await page.getByTestId('shot-detail-1').getByText('应用修改').click();
    await page.locator('aside button[title="视频素材库页面"]').click();
    // 保存失败必须阻断切换：错误提示 + 仍停留在工作台
    await expect(page.getByText(/工作台草稿尚未保存，已取消切换/).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('workbench-home')).toBeVisible();
    await expect(page.getByTestId('save-state-badge')).toContainText('保存失败，等待重试');
    // 恢复后重试保存 → saved（未丢失任何编辑）
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: '重试保存' }).click();
    await expect(page.getByTestId('save-state-badge')).toContainText('已保存', { timeout: 10_000 });
  });

  test('移动端：底部导航替代常驻窄侧栏，无横向溢出，按钮全部具名', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    // 底部导航可见（drawer/bottom navigation）
    await expect(page.getByTestId('mobile-nav-pipeline')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-materials')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-knowledge')).toBeVisible();
    // 桌面常驻侧栏内容在移动端隐藏
    await expect(page.locator('aside button[title="5步短视频反推与生成主工程"]')).toBeHidden();
    // 无横向溢出 + 所有按钮具名
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      unnamedButtons: [...document.querySelectorAll('button')].filter(
        (button) =>
          !(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').trim()
      ).length,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.unnamedButtons).toBe(0);
    // 底部导航可切换页面
    await page.getByTestId('mobile-nav-materials').click();
    await expect(page.getByRole('heading', { name: /爆款短视频与素材库/ })).toBeVisible({ timeout: 10_000 });
  });

  test('关键路径键盘操作 + axe critical/serious = 0', async ({ page }) => {
    await login(page);
    const home = page.getByTestId('workbench-home');
    await expect(home).toBeVisible({ timeout: 15_000 });

    // 键盘：Tab 可达两个主 CTA（有界循环，不依赖固定 Tab 次数）；Enter 切换付费授权（role=switch）
    const reachViaTab = async (testId: string) => {
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          // CTA 是 label 结构：焦点落在其内部的 sr-only file input 上
          return !!el && (el === document.activeElement || el.contains(document.activeElement));
        }, testId);
        if (focused) return true;
      }
      return false;
    };
    expect(await reachViaTab('upload-viral-cta')).toBe(true);
    await expect(page.getByTestId('upload-viral-cta').locator('input')).toBeFocused();
    expect(await reachViaTab('upload-product-cta')).toBe(true);
    await expect(page.getByTestId('upload-product-cta').locator('input')).toBeFocused();
    const toggle = page.getByTestId('paid-auth-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // axe：关键路径（工作台首页 + 分镜表 + 预检面板）critical/serious 违规为 0
    const results = await new AxeBuilder({ page })
      .include('[data-testid="workbench-home"]')
      .include('[data-testid="shot-plan-table"]')
      .include('[data-testid="preflight-panel"]')
      .analyze();
    const serious = results.violations.filter((v) => ['critical', 'serious'].includes(v.impact));
    expect(
      serious.map((v) => `${v.id}: ${v.nodes.length}`),
      JSON.stringify(serious.map((v) => ({ id: v.id, help: v.help, targets: v.nodes.map((n) => n.target) })))
    ).toEqual([]);
  });
});

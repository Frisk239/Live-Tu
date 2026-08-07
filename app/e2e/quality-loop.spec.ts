import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * P3 质量闭环专项 E2E（Phase 3 验收 §五：新增真实质量闭环专项 E2E，至少覆盖
 * 发现问题、局部修复、人工通过、最终导出）。
 *
 * 运行环境（runner 注入，零真实付费）：
 * - FAKE_VIDEO_PROVIDER=true：FakeVideoPort 确定性生成
 * - FAKE_TECH_QA=true：技术 QA 恒定 verified
 * - FAKE_SEMANTIC_QA_FAIL_ONCE=hook_quality：每个镜头首次 QA 该维度不合格（可恢复缺陷）
 * - FAKE_SEMANTIC_QA_FAIL=product_consistency + FAKE_SEMANTIC_QA_FAIL_SHOT_INDEXES=2：
 *   第 2 镜始终产品一致性不合格（演示自动修复上限 + 人工通过）
 * - PIPELINE_WORKER_DISABLED=true：无后台 worker，全部显式 API 驱动
 *
 * 覆盖：
 * 1. 发现问题：QA 执行 → 不合格徽章 + 问题列表（原因 + 建议修复动作）
 * 2. 局部修复：fix-shot 自动修复（1 次）→ 重新 QA 合格（可恢复缺陷）
 * 3. 修复上限 + 人工通过：第 2 镜两次修复仍不合格 → 第 3 次提示需人工确认 → manual-pass
 * 4. 版本比较：修复产生新版本（v1/v2…），可切换历史版本
 * 5. 刷新恢复：QA 状态/人工通过/版本列表刷新后从服务端恢复
 * 6. 最终导出：素材上传 → step5 渲染 → 最终 MP4 可下载
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3004';

async function login(page: import('@playwright/test').Page) {
  await page.getByPlaceholder('请输入账号').fill('admin');
  await page.getByPlaceholder('请输入登录密码').fill('888');
  await page.getByRole('button', { name: '立即登录工作台' }).click();
  await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
}

async function readFixture(name: string): Promise<Buffer> {
  return readFile(path.resolve(process.cwd(), 'e2e/fixtures', name));
}

async function uploadMaterial(
  page: import('@playwright/test').Page,
  name: string,
  mime: string
): Promise<string> {
  const res = await page.request.post(`${BASE}/api/materials/upload-file`, {
    multipart: { file: { name, mimeType: mime, buffer: await readFixture(name) } },
  });
  const json = await res.json();
  expect(json.success).toBe(true);
  const url = json.data?.url;
  expect(typeof url).toBe('string');
  return url;
}

/** 创建产品 + 附加 1 个产品资产（预检要求真实资产） */
async function createProductWithAsset(
  page: import('@playwright/test').Page,
  assetUrl: string
): Promise<string> {
  const res = await page.request.post(`${BASE}/api/products`, {
    data: { name: 'P3 质量闭环产品', positioning: '卖点', price: '¥99' },
  });
  const json = await res.json();
  expect(res.ok(), JSON.stringify(json)).toBe(true);
  const productId = json.data?.id ?? json.id;
  const attach = await page.request.post(`${BASE}/api/products/${productId}/assets`, {
    data: { url: assetUrl, role: 'hero' },
  });
  expect(attach.status()).toBe(201);
  return productId;
}

/** 通过 step2 多镜头分支创建 pending 镜头任务 */
async function createShotTasks(
  page: import('@playwright/test').Page,
  frameUrl: string,
  count = 2
): Promise<string> {
  const shotList = Array.from({ length: count }, (_, i) => ({
    shotIndex: i + 1,
    shotType: i === 0 ? 'close-up' : 'wide',
    cameraMovement: 'push-in',
    description: `quality loop shot ${i + 1}`,
    keyframeUrl: frameUrl,
  }));
  const res = await page.request.post(`${BASE}/api/pipeline/step2`, {
    data: { productInfo: { name: 'P3 Product' }, shotList },
  });
  const json = await res.json();
  expect(res.status(), JSON.stringify(json)).toBe(200);
  const sessionId = json.data?.multiShotResult?.sessionId;
  expect(typeof sessionId).toBe('string');
  return sessionId;
}

async function saveServerDraft(
  page: import('@playwright/test').Page,
  opts: { sessionId: string; frameUrl: string; count?: number; productId: string }
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
    // P5 收紧后：普通素材 URL 不可作为「已有首帧」复用（first_frame_reuse_not_verifiable）。
    // 不写 candidates/selectedCandidateId → 走真实派生链路（FAKE_FIRST_FRAME_DERIVE 只
    // 在 E2E runner 启用，替代图像 provider，provenance/安全登记仍走真实链路）。
    candidates: [],
    selectedCandidateId: null,
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
        productId: opts.productId,
        // 派生上下文：referenceKeyframes 来自本会话产品资产（attach 后属可信
        // product_shot，P5 策略放行；不会被当作原视频关键帧拒绝）
        referenceKeyframes: [opts.frameUrl],
      }),
      autonomyMode: 'step_by_step',
    },
  });
  const json = await res.json();
  expect(res.status(), JSON.stringify(json)).toBe(200);
}

/** 完成拆解/分镜确认 + 预检 + 付费授权 + 批量提交（所有镜头 completed） */
async function submitAllShots(page: import('@playwright/test').Page, sessionId: string) {
  await page.getByTestId('confirm-deconstruction-btn').scrollIntoViewIfNeeded();
  await page.getByTestId('confirm-deconstruction-btn').click();
  await expect(page.getByTestId('confirm-deconstruction')).toBeHidden({ timeout: 10_000 });
  await page.getByTestId('confirm-shot-plan').scrollIntoViewIfNeeded();
  await page.getByTestId('confirm-shot-plan').click();
  await expect(page.getByText('已确认', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  // 预检（PreflightPanel 渲染出批量提交按钮）
  await page.getByTestId('run-preflight').scrollIntoViewIfNeeded();
  await page.getByTestId('run-preflight').click();
  await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('paid-auth-toggle').scrollIntoViewIfNeeded();
  await page.getByTestId('paid-auth-toggle').click();
  await expect(page.getByTestId('paid-auth-toggle')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('confirm-batch-submit').scrollIntoViewIfNeeded();
  await page.getByTestId('confirm-batch-submit').click();
  await expect(page.getByText(/批量提交完成|已提交/).first()).toBeVisible({ timeout: 15_000 });
  // 等待全部镜头完成（fake provider 即时完成；需显式携带 sessionId，无参最新兜底只恢复设置不恢复镜头）
  await expect
    .poll(async () => {
      const res = await page.request.get(`${BASE}/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
      const json = await res.json();
      const states = json.data?.shotStates || [];
      return states.length === 2 && states.every((s: any) => s.status === 'completed');
    }, { timeout: 15_000 })
    .toBe(true);
}

/** 轮询镜头状态（显式 sessionId） */
async function pollShotState(
  page: import('@playwright/test').Page,
  sessionId: string,
  shotIndex: number,
  predicate: (shot: any) => boolean,
  timeoutMs = 15_000
): Promise<any> {
  let result: any = null;
  await expect
    .poll(async () => {
      const res = await page.request.get(`${BASE}/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
      const json = await res.json();
      const shot = (json.data?.shotStates || []).find((s: any) => s.shotIndex === shotIndex);
      result = shot;
      return shot ? predicate(shot) : false;
    }, { timeout: timeoutMs })
    .toBe(true);
  return result;
}

test.describe('P3 质量闭环', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aigc_onboarding_completed', 'true');
      localStorage.removeItem('aigc_is_logged_in');
    });
    await page.goto(BASE);
  });

  test('完整质量闭环：发现问题 → 局部修复 → 重新合格 → 人工通过 → 版本比较 → 刷新恢复 → 最终导出', async ({
    page,
  }) => {
    await login(page);
    const frameUrl = await uploadMaterial(page, 'ux-sample.png', 'image/png');
    const productId = await createProductWithAsset(page, frameUrl);
    const sessionId = await createShotTasks(page, frameUrl, 2);
    await saveServerDraft(page, { sessionId, frameUrl, count: 2, productId });

    // 进入工作台并批量提交生成
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });
    await submitAllShots(page, sessionId);

    // ============ 1. 发现问题：第 1 镜 QA → hook_quality 不合格 ============
    await page.getByTestId('shot-row-1').click();
    await page.getByTestId('qa-shot-1').click();
    const issues1 = page.getByTestId('qa-issues-1');
    await expect(issues1).toBeVisible({ timeout: 15_000 });
    // 问题列表显示「原因 + 建议」
    await expect(issues1.getByText('Hook 质量')).toBeVisible();
    await expect(issues1.getByText(/原因：/)).toBeVisible();
    await expect(issues1.getByText(/建议：/)).toBeVisible();
    // 行内不合格徽章（首次 QA 后 hook_quality 仍 fail → 整体 fail）
    await expect(page.getByTestId('qa-issues-1').getByText('不合格').first()).toBeVisible();

    // ============ 2. 局部修复：fix-shot 自动修复 → 重新 QA 合格 ============
    await page.getByTestId('fix-shot-1').click();
    // 等待镜头重新生成完成（fix → pending → retry 自动完成）
    await pollShotState(
      page,
      sessionId,
      1,
      (shot) => shot?.status === 'completed' && (shot?.versions?.length ?? 0) >= 2
    );
    // 重新 QA → 可恢复缺陷已修复（fail-once 语义：第二次检查通过）
    await page.getByTestId('qa-shot-1').click();
    await expect(page.getByTestId('qa-shot-1')).toBeVisible();
    await pollShotState(page, sessionId, 1, (shot) => shot?.semanticVerdict === 'pass');
    await expect(page.getByTestId('shot-row-1').getByText('QA 通过')).toBeVisible({ timeout: 10_000 });

    // ============ 3. 第 2 镜持续不合格 → 自动修复上限 → 人工通过 ============
    await page.getByTestId('shot-row-2').click();
    await page.getByTestId('qa-shot-2').click();
    await expect(page.getByTestId('qa-issues-2')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('qa-issues-2').getByText('产品一致性')).toBeVisible();

    // 第 1 次自动修复
    await page.getByTestId('fix-shot-2').click();
    await pollShotState(page, sessionId, 2, (shot) => shot?.status === 'completed' && shot?.autoFixCount >= 1);
    await page.getByTestId('qa-shot-2').click();
    await expect(page.getByTestId('qa-issues-2').getByText('产品一致性')).toBeVisible({ timeout: 10_000 });

    // 第 2 次自动修复（达到上限）
    await page.getByTestId('fix-shot-2').click();
    await pollShotState(page, sessionId, 2, (shot) => shot?.status === 'completed' && shot?.autoFixCount >= 2);

    // 第 3 次 → 自动修复按钮消失（上限），人工通过按钮出现
    await expect(page.getByTestId('fix-shot-2')).not.toBeVisible();
    await page.getByTestId('manual-pass-2').scrollIntoViewIfNeeded();
    await page.getByTestId('manual-pass-2').click();
    await expect(page.getByTestId('shot-row-2').getByText('人工通过')).toBeVisible({ timeout: 10_000 });

    // ============ 4. 版本比较：第 2 镜存在 v1/v2/v3 ============
    await page.getByTestId('versions-toggle-2').click();
    const versionsPanel = page.getByTestId('versions-2');
    await expect(versionsPanel).toBeVisible({ timeout: 5_000 });
    await expect(versionsPanel.getByText('v3')).toBeVisible();
    await expect(versionsPanel.getByText('v2')).toBeVisible();
    await expect(versionsPanel.getByText('v1')).toBeVisible();
    // 可切换历史版本（选择 v1）
    await page.getByTestId('use-version-2-1').click();
    await pollShotState(page, sessionId, 2, (shot) => shot?.currentVersion === 1);

    // ============ 5. 刷新恢复：QA 状态/人工通过/版本列表全部恢复 ============
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });
    // 第 1 镜 QA 通过徽章（服务端恢复）
    await expect(page.getByTestId('shot-row-1').getByText('QA 通过')).toBeVisible({ timeout: 10_000 });
    // 第 2 镜人工通过徽章（服务端恢复）
    await expect(page.getByTestId('shot-row-2').getByText('人工通过')).toBeVisible({ timeout: 10_000 });
    // 版本列表刷新后可展开（服务端恢复）
    await page.getByTestId('shot-row-2').click();
    await page.getByTestId('versions-toggle-2').click();
    await expect(page.getByTestId('versions-2').getByText('v3')).toBeVisible({ timeout: 5_000 });

    // ============ 6. 最终导出：素材上传 → step5 渲染 → MP4 可下载 ============
    const videoUrl = await uploadMaterial(page, 'quality-loop-source.mp4', 'video/mp4');
    const renderRes = await page.request.post(`${BASE}/api/pipeline/step5`, {
      data: {
        inputs: {
          videoSourceUrl: videoUrl,
          aspectRatio: '9:16',
          subtitleStyle: '黄字黑边',
          productId,
        },
      },
    });
    const renderJson = await renderRes.json();
    expect(renderRes.status(), JSON.stringify(renderJson)).toBe(200);
    const downloadUrl = renderJson.data?.output?.downloadUrl || renderJson.data?.downloadUrl;
    expect(typeof downloadUrl).toBe('string');
    // 下载最终 MP4 并验证可获取（可播放、可下载）
    const dlRes = await page.request.get(`${BASE}${downloadUrl}`);
    expect(dlRes.status()).toBe(200);
    const contentType = dlRes.headers()['content-type'] || '';
    expect(contentType).toContain('video');
    const body = await dlRes.body();
    expect(body.length).toBeGreaterThan(10_000);
  });

  test('服务端状态：getState 携带 QA 统计与成本摘要（预估成本/等待区间）', async ({ page }) => {
    await login(page);
    const frameUrl = await uploadMaterial(page, 'ux-sample.png', 'image/png');
    const productId = await createProductWithAsset(page, frameUrl);
    const sessionId = await createShotTasks(page, frameUrl, 2);
    await saveServerDraft(page, { sessionId, frameUrl, count: 2, productId });
    await page.reload();
    await expect(page.getByTestId('shot-plan-table')).toBeVisible({ timeout: 15_000 });
    await submitAllShots(page, sessionId);

    const state = await page.evaluate(async (sid) => {
      const res = await fetch(`/api/workbench/state?sessionId=${encodeURIComponent(sid)}`);
      return res.json();
    }, sessionId);
    // 成本摘要与 QA 统计字段存在（badge 依赖）
    expect(state.data.estimatedCostUsd).toBeDefined();
    expect(state.data.qaTotalShots).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(state.data.shotStates)).toBe(true);
    const shot = state.data.shotStates[0];
    expect(shot.currentVersion).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(shot.versions)).toBe(true);
  });
});

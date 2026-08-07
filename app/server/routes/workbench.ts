/**
 * S2 工作台 HTTP 适配层（薄路由，业务全部在 workflow-controller / submission-preflight）
 *
 * 挂载：/api/workbench + /api/v1/workbench（requireAuth）
 * 全部响应使用 shared/workbench-contract.ts 契约（前后端单一来源）。
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  CONFIRM_TYPES,
  isAutonomyMode,
  isSaveState,
  type ConfirmType,
} from '../../shared/workbench-contract';
import {
  WorkflowController,
  WorkflowError,
} from '../lib/workflow-controller';
import { ShotQaController, QaControllerError } from '../lib/shot-qa-controller';
import { repairShotAtSeam, SeamRepairError } from '../lib/seam-repair';
import { db } from '../lib/db';

export const workbenchRouter = Router();

/**
 * 付费提交专属限流（P0 加固）：只作用于 /confirm（批量付费提交）与 /retry-shot（单镜重试）。
 * - 独立于全局 limitExpensiveOperations（其按路由族 20/min，密集草稿/预检会误伤成 429）；
 * - 独立 key（ownerId:workbench-paid），窗口 60s，默认 20 次/分钟，可经
 *   WORKBENCH_PAID_REQUESTS_PER_MINUTE 调整。
 */
const PAID_WINDOW_MS = 60_000;
const paidOps = new Map<string, { count: number; resetAt: number }>();

export function limitWorkbenchPaidOps(req: Request, res: Response, next: NextFunction) {
  const configured = Number(process.env.WORKBENCH_PAID_REQUESTS_PER_MINUTE || 20);
  const maximum = Number.isFinite(configured)
    ? Math.min(1_000, Math.max(1, Math.floor(configured)))
    : 20;
  const now = Date.now();
  for (const [key, rec] of paidOps) {
    if (rec.resetAt <= now) paidOps.delete(key);
  }
  const identity = req.authUser?.id || req.ip || req.socket.remoteAddress || 'unknown';
  const key = `${identity}:workbench-paid`;
  const rec = paidOps.get(key);
  if (rec && rec.resetAt > now && rec.count >= maximum) {
    res.setHeader('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
    return res.status(429).json({ success: false, error: '付费提交操作过于频繁，请稍后重试' });
  }
  paidOps.set(key, { count: (rec?.count || 0) + 1, resetAt: rec?.resetAt || now + PAID_WINDOW_MS });
  next();
}

let controller: WorkflowController | null = null;

function getController(): WorkflowController {
  if (!controller) controller = new WorkflowController();
  return controller;
}

/** 测试注入点：路由层测试可以替换 controller（fake seam） */
export function setWorkbenchControllerForTest(c: WorkflowController | null): void {
  controller = c;
}

function sendWorkflowError(res: any, error: unknown): void {
  if (error instanceof WorkflowError) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      error: error.message,
      preflight: error.preflight ?? undefined,
    });
  }
  console.warn('[workbench] unhandled error:', error);
  res.status(500).json({ success: false, error: '工作台服务内部错误' });
}

// GET /api/workbench/state?runId=&sessionId=
workbenchRouter.get('/state', (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const runId = typeof req.query.runId === 'string' ? req.query.runId : null;
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
    const state = getController().getState({ ownerId, runId, sessionId });
    res.json({ success: true, data: state });
  } catch (error) {
    sendWorkflowError(res, error);
  }
});

// POST /api/workbench/draft — 保存草稿（SaveState 服务端持久化）
workbenchRouter.post('/draft', (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    // P1-2 修复：草稿接口不接受 paidAuthEnabled（付费授权唯一入口 = /paid-auth）
    const { runId, sessionId, draftJson, autonomyMode, saveState } = req.body || {};
    const state = getController().saveDraft({
      ownerId,
      runId: typeof runId === 'string' ? runId : null,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      draftJson: typeof draftJson === 'string' ? draftJson : null,
      autonomyMode: isAutonomyMode(autonomyMode) ? autonomyMode : undefined,
      saveState: isSaveState(saveState) ? saveState : undefined,
    });
    res.json({ success: true, data: state });
  } catch (error) {
    sendWorkflowError(res, error);
  }
});

// POST /api/workbench/autonomy — 切换自主模式（绝不改动付费授权）
workbenchRouter.post('/autonomy', (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, sessionId, autonomyMode } = req.body || {};
    if (!isAutonomyMode(autonomyMode)) {
      return res.status(400).json({ success: false, error: `未知自主模式: ${autonomyMode}` });
    }
    const state = getController().setAutonomyMode({
      ownerId,
      runId: typeof runId === 'string' ? runId : null,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      autonomyMode,
    });
    res.json({ success: true, data: state });
  } catch (error) {
    sendWorkflowError(res, error);
  }
});

// POST /api/workbench/paid-auth — 独立付费授权开关
workbenchRouter.post('/paid-auth', (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, sessionId, enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled 必须为布尔值' });
    }
    const state = getController().setPaidAuthorization({
      ownerId,
      runId: typeof runId === 'string' ? runId : null,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      enabled,
    });
    res.json({ success: true, data: state });
  } catch (error) {
    sendWorkflowError(res, error);
  }
});

// POST /api/workbench/preflight — 提交前预检（能力/素材/成本/余额/等待）
workbenchRouter.post('/preflight', async (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, sessionId } = req.body || {};
    const result = await getController().runPreflight({
      ownerId,
      runId: typeof runId === 'string' ? runId : null,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendWorkflowError(res, error);
  }
});

// POST /api/workbench/confirm — 三处确认点（拆解结果/分镜计划/批量付费提交）
// 付费端点：挂专属限流（P0 并发付费防护的外层节流，内层还有原子 claim）。
workbenchRouter.post('/confirm', limitWorkbenchPaidOps, async (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, sessionId, type } = req.body || {};
    if (!CONFIRM_TYPES.includes(type as ConfirmType)) {
      return res.status(400).json({ success: false, error: `未知确认点: ${type}` });
    }
    const result = await getController().confirm({
      ownerId,
      runId: typeof runId === 'string' ? runId : null,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      type: type as ConfirmType,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendWorkflowError(res, error);
  }
});

// POST /api/workbench/retry-shot — 单镜局部重试（仅失败/用户选择镜头；成功镜头拒绝）
// 付费端点：挂专属限流（内层原子 claim 防并发重复扣费）。
workbenchRouter.post('/retry-shot', limitWorkbenchPaidOps, async (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, shotId, attempt, failureReason, promptOverride } = req.body || {};
    const result = await getController().retryShot({
      ownerId,
      runId: typeof runId === 'string' ? runId : '',
      shotId: typeof shotId === 'string' ? shotId : '',
      attempt: Number(attempt),
      failureReason: typeof failureReason === 'string' ? failureReason : '',
      promptOverride: typeof promptOverride === 'string' ? promptOverride : null,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendWorkflowError(res, error);
  }
});

// POST /api/workbench/cancel — 取消（已完成镜头保留）
workbenchRouter.post('/cancel', (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, sessionId } = req.body || {};
    const state = getController().cancel({
      ownerId,
      runId: typeof runId === 'string' ? runId : null,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
    });
    res.json({ success: true, data: state });
  } catch (error) {
    sendWorkflowError(res, error);
  }
});

// ==================== P3 质量闭环端点 ====================

let qaController: ShotQaController | null = null;
function getQaController(): ShotQaController {
  if (!qaController) qaController = new ShotQaController();
  return qaController;
}
export function setShotQaControllerForTest(c: ShotQaController | null): void {
  qaController = c;
}

function sendQaError(res: any, error: unknown): void {
  if (error instanceof QaControllerError || error instanceof WorkflowError) {
    return res.status((error as any).status || 500).json({
      success: false,
      code: (error as any).code || 'qa_error',
      error: error.message,
    });
  }
  console.warn('[workbench-qa] unhandled error:', error);
  res.status(500).json({ success: false, error: 'QA 服务内部错误' });
}

// POST /api/workbench/qa-shot — 对单个镜头执行技术 QA + 语义 QA
workbenchRouter.post('/qa-shot', async (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, shotId } = req.body || {};
    if (!shotId) return res.status(400).json({ success: false, error: '缺少 shotId' });
    const result = await getQaController().runShotQa(ownerId, {
      runId: typeof runId === 'string' ? runId : '',
      shotId,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendQaError(res, error);
  }
});

// POST /api/workbench/fix-shot — 自动修复循环（最多 2 次，超出需人工确认）
// 一次调用完成「准备修复（记录成本 + 增强 prompt）→ 重新生成该镜」的完整闭环
workbenchRouter.post('/fix-shot', limitWorkbenchPaidOps, async (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, shotId, skipAutoFix } = req.body || {};
    if (!shotId) return res.status(400).json({ success: false, error: '缺少 shotId' });
    const result = await getQaController().runFixLoop(ownerId, {
      runId: typeof runId === 'string' ? runId : '',
      shotId,
      skipAutoFix: Boolean(skipAutoFix),
    });
    // 自动修复：准备完成后立即重新生成该镜（仅失败镜头，成功镜头绝不重提）
    if (result.action === 'regenerated') {
      const db = (await import('../lib/db')).db;
      const shot = db
        .prepare('SELECT id, shot_index, video_prompt, current_version, session_id, pipeline_run_id, reference_keyframe_url, reference_video_url, first_frame_url FROM shot_generation_tasks WHERE id = ?')
        .get(shotId) as any;

      let firstFrameFixGuidance: string[] | undefined;
      // Keep QA-derived visual constraints, but let retryShot prepare the first
      // frame only after it has acquired the shared submission claim.
      try {
        const latestReport = db
          .prepare('SELECT report_json FROM shot_qa_reports WHERE shot_id = ? ORDER BY created_at DESC LIMIT 1')
          .get(shotId) as { report_json: string } | undefined;
        const parsed = latestReport ? JSON.parse(latestReport.report_json) : null;
        const needsFirstFrameRegeneration = Boolean(
          parsed?.semantic?.issues?.some(
            (i: any) =>
              (i.verdict === 'fail' || i.verdict === 'warning') &&
              i.fix?.regenerateFirstFrame === true
          )
        );
        if (needsFirstFrameRegeneration) {
          firstFrameFixGuidance = parsed.semantic.issues
            .filter((i: any) => i.verdict === 'fail' || i.verdict === 'warning')
            .map((i: any) => `${i.reason || ''}（修复：${i.fix?.action || ''}）`);
        }
      } catch (analysisErr: any) {
        // A missing/corrupt QA report cannot authorize a silent fallback. The
        // retry still runs its normal safety funnel with no extra guidance.
        console.warn('[fix-shot] unable to read first-frame repair guidance:', analysisErr?.message || analysisErr);
      }

      const retryResult = await getController().retryShot({
        ownerId,
        // 空字符串 runId（前端未绑定 runId 时传 ''）必须 fallback 到会话 id，
        // 否则 retryShot 抛 missing_run_id，fix 后镜头卡 pending
        runId: shot?.pipeline_run_id || (runId && typeof runId === 'string' ? runId : String(shot?.session_id || '')),
        shotId,
        attempt: result.autoFixCount,
        // 注意：不能用 semantic_fix: 前缀（runFixLoop 的 autoFixCount 统计会双计）
        failureReason: `auto_fix_regenerate:${result.summary}`,
        fixGuidance: firstFrameFixGuidance,
      });
      result.newVersion = retryResult.attempt;
    }
    res.json({ success: true, data: result });
  } catch (error) {
    sendQaError(res, error);
  }
});

// POST /api/workbench/repair-seam — 剪辑点定向返修（sequence gate 定位 seam 断裂时，
// 只重生成接收镜：以前一镜结束边界帧为新锚点 → 重建条件化首帧 → 重新提交该镜）
workbenchRouter.post('/repair-seam', limitWorkbenchPaidOps, async (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, sessionId, shotId, fromShotId, reason } = req.body || {};
    if (!sessionId || !shotId || !fromShotId) {
      return res.status(400).json({ success: false, error: '缺少 sessionId / shotId / fromShotId' });
    }
    const toShot = db.prepare('SELECT shot_index FROM shot_generation_tasks WHERE id = ? AND owner_id = ?').get(shotId, ownerId) as { shot_index: number } | undefined;
    const fromShot = db.prepare('SELECT shot_index FROM shot_generation_tasks WHERE id = ? AND owner_id = ?').get(fromShotId, ownerId) as { shot_index: number } | undefined;
    if (!toShot || !fromShot) {
      return res.status(404).json({ success: false, code: 'seam_shot_not_found', error: '镜头不存在或不属于当前用户' });
    }
    const result = await repairShotAtSeam({
      controller: getController(),
      ownerId,
      sessionId,
      toShotId: shotId,
      toShotIndex: Number(toShot.shot_index),
      fromShotId,
      fromShotIndex: Number(fromShot.shot_index),
      reason: typeof reason === 'string' && reason.trim() ? reason : 'seam 承接断裂（sequence gate 定位）',
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof SeamRepairError) {
      return res.status(422).json({ success: false, code: error.code, error: error.message });
    }
    if (error instanceof WorkflowError) {
      return res.status(error.status).json({ success: false, code: error.code, error: error.message });
    }
    console.warn('[repair-seam] unhandled error:', error);
    res.status(500).json({ success: false, error: '剪辑点返修服务内部错误' });
  }
});

// POST /api/workbench/manual-pass — 人工通过（接受当前版本，不再要求修复）
workbenchRouter.post('/manual-pass', (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, shotId, comment } = req.body || {};
    if (!shotId) return res.status(400).json({ success: false, error: '缺少 shotId' });
    const result = getQaController().manualPass(ownerId, {
      runId: typeof runId === 'string' ? runId : '',
      shotId,
      comment: typeof comment === 'string' ? comment : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendQaError(res, error);
  }
});

// POST /api/workbench/use-version — 选择历史版本
workbenchRouter.post('/use-version', (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const { runId, shotId, versionId } = req.body || {};
    if (!shotId || !versionId) {
      return res.status(400).json({ success: false, error: '缺少 shotId 或 versionId' });
    }
    const result = getQaController().useVersion(ownerId, {
      runId: typeof runId === 'string' ? runId : '',
      shotId,
      versionId,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendQaError(res, error);
  }
});

// GET /api/workbench/shot-versions?shotId= — 查询镜头版本列表
workbenchRouter.get('/shot-versions', (req, res) => {
  try {
    const ownerId = req.authUser?.id;
    if (!ownerId) return res.status(401).json({ success: false, error: '未登录' });
    const shotId = typeof req.query.shotId === 'string' ? req.query.shotId : null;
    if (!shotId) return res.status(400).json({ success: false, error: '缺少 shotId 查询参数' });
    const versions = getQaController().getShotVersions(shotId, ownerId);
    res.json({ success: true, data: versions });
  } catch (error) {
    sendQaError(res, error);
  }
});

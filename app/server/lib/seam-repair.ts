/**
 * 剪辑点定向返修（seam-directed repair）
 *
 * 序列门禁（sequence-semantic-gate）定位到某个 seam 断裂时，不整条重跑、不把
 * 原爆款帧送入 provider，而是做最小闭环：
 *
 * 1. 只从「前一镜的本系统生成视频」提取安全的结束边界帧（ffmpeg 末帧；
 *    外链/爆款参考视频一律拒绝——原爆款视频绝不进入提取或 provider 输入）；
 * 2. 经可信资产链路登记：conditioned_first_frames（owner 匹配 + SHA-256 +
 *    服务端视觉安全评估 pass 才允许进入提交边界）；
 * 3. 把新锚点写回草稿中接收镜的 continuityAnchorUrl，只重建该镜的条件化
 *    首帧并重新生成该镜（retryShot → 新版本）；
 * 4. 下游镜的 rolling anchor 由 resolvePrecedingGeneratedAnchor 自动跟随
 *    （读取最新 derived_first_frame_url），无需重跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db';
import { evaluateVisualSafety, recordVisualSafety, requireVisualSafetyPass, sha256OfLocalFile } from './visual-safety';
import type { WorkflowController } from './workflow-controller';
import type { SequenceGateResult } from './sequence-semantic-gate';

const execAsync = promisify(exec);

export class SeamRepairError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SeamRepairError';
    this.code = code;
  }
}

export interface SeamRepairTarget {
  /** 接收镜（将被重生成；gate 的 failShotIndex） */
  toShotIndex: number;
  /** 前一镜（提供结束边界帧；toShotIndex - 1） */
  fromShotIndex: number;
  /** gate 定位的断裂原因（进入 fixGuidance 与证据） */
  reason: string;
  checkId: string;
  verdict: string;
}

/**
 * 从序列门禁结果解析需要定向返修的 seam 列表：
 * - 只处理 fail/warning 且能定位到具体接收镜（shotIndex >= 2，有前一镜）的检查；
 * - 同一接收镜去重（多个检查指向同一镜时合并原因）。
 */
export function resolveSeamRepairTargets(gate: SequenceGateResult, shotCount: number): SeamRepairTarget[] {
  const byShot = new Map<number, SeamRepairTarget>();
  for (const check of gate.checks) {
    if (check.verdict !== 'fail' && check.verdict !== 'warning') continue;
    const shotIndex = Number(check.fix?.shotIndex);
    if (!Number.isInteger(shotIndex) || shotIndex < 2 || shotIndex > shotCount) continue;
    const existing = byShot.get(shotIndex);
    if (existing) {
      existing.reason = `${existing.reason}；${check.id}: ${check.reason}`;
    } else {
      byShot.set(shotIndex, {
        toShotIndex: shotIndex,
        fromShotIndex: shotIndex - 1,
        reason: `${check.id}: ${check.reason}`,
        checkId: check.id,
        verdict: check.verdict,
      });
    }
  }
  return [...byShot.values()].sort((a, b) => a.toShotIndex - b.toShotIndex);
}

/** 解析本系统生成的视频本地路径（外链/爆款参考视频拒绝） */
function resolveOwnedGeneratedVideo(ownerId: string, shot: any): string | null {
  if (!shot || shot.owner_id !== ownerId || shot.status !== 'completed' || !shot.video_url) return null;
  const url = String(shot.video_url);
  // 只允许本系统 /uploads 产物（demo runner 会把远端直出产物缓存为本地 URL 再 QA）
  if (!url.startsWith('/uploads/')) return null;
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  const local = path.join(uploadsRoot, url.replace(/^\/?uploads\//, ''));
  if (!fs.existsSync(local)) return null;
  // 路径穿越守卫
  if (!path.resolve(local).startsWith(`${path.resolve(uploadsRoot)}${path.sep}`)) return null;
  return local;
}

/**
 * 提取前一镜的结束边界帧并完成可信登记。
 * 返回 /uploads 相对 URL；提取/评估失败 → 显式抛错（绝不静默降级）。
 */
export async function registerSeamAnchorFrame(input: {
  ownerId: string;
  sessionId: string;
  fromShot: any;
  reason: string;
}): Promise<{ anchorUrl: string; anchorSha256: string; localPath: string }> {
  const { ownerId, fromShot } = input;
  const videoLocal = resolveOwnedGeneratedVideo(ownerId, fromShot);
  if (!videoLocal) {
    throw new SeamRepairError(
      'seam_anchor_unavailable',
      `前一镜（第 ${fromShot.shot_index} 镜）没有可用的本系统生成产物（status=${fromShot?.status}, video_url=${String(fromShot?.video_url || '').slice(0, 80)}）；` +
        '结束边界帧只允许来自本系统生成视频，爆款参考视频绝不进入返修链路'
    );
  }
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  const anchorDir = path.join(uploadsRoot, 'renders', 'seam-anchors');
  fs.mkdirSync(anchorDir, { recursive: true });
  const outFile = path.join(anchorDir, `seam_anchor_${Date.now()}_${randomUUID().slice(0, 8)}.jpg`);
  try {
    // 末帧（-sseof 从文件末尾倒推；失败则回退 -ss 时长-0.4）
    try {
      await execAsync(
        `ffmpeg -y -v error -sseof -0.4 -i "${videoLocal}" -frames:v 1 -q:v 2 "${outFile}"`,
        { timeout: 30_000 }
      );
    } catch {
      await execAsync(
        `ffmpeg -y -v error -ss 0.4 -i "${videoLocal}" -vf "select=eq(n\\,0)" -frames:v 1 -q:v 2 "${outFile}"`,
        { timeout: 30_000 }
      );
    }
  } catch (error: any) {
    throw new SeamRepairError('seam_anchor_extraction_failed', `结束边界帧提取失败：${String(error?.message || error).slice(0, 200)}`);
  }
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 100) {
    throw new SeamRepairError('seam_anchor_extraction_failed', '结束边界帧提取结果为空');
  }

  const sha256 = sha256OfLocalFile(outFile);
  if (!sha256) {
    throw new SeamRepairError('seam_anchor_hash_missing', '结束边界帧无法计算 SHA-256，拒绝登记');
  }
  const anchorUrl = `/uploads/renders/seam-anchors/${path.basename(outFile)}`;

  // 可信登记：本系统生成画面的延续锚点（generated_frame 语义），owner 匹配 +
  // hash 绑定 + 服务端视觉安全评估。评估非 pass → 不登记、不进 provider。
  db.prepare(
    `INSERT INTO conditioned_first_frames
       (id, run_id, session_id, shot_id, owner_id, reference_video_url, reference_keyframe_url,
        product_asset_urls_json, conditioned_first_frame_url, local_path, provider, model,
        prompt_version, prompt, confidence, preflight_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, 'seam-anchor-extraction', 'ffmpeg',
        'seam-repair-v1', ?, NULL, 'pending', CURRENT_TIMESTAMP)`
  ).run(
    `cff-seam-${Date.now()}-${randomUUID().slice(0, 8)}`,
    null,
    input.sessionId,
    fromShot.id,
    ownerId,
    fromShot.video_url,
    anchorUrl,
    outFile,
    `seam anchor from generated shot ${fromShot.shot_index} (${input.reason.slice(0, 300)})`
  );
  const assessment = await evaluateVisualSafety(anchorUrl, { sha256 });
  recordVisualSafety(ownerId, anchorUrl, assessment);
  // 提交边界强制：pass + sha256 + 本地文件 hash 一致性（真实校验，不因返修放宽）
  requireVisualSafetyPass(ownerId, anchorUrl, 'seam-anchor');

  return { anchorUrl, anchorSha256: sha256, localPath: outFile };
}

/**
 * 剪辑点定向返修主入口：
 * 1. 校验接收镜（toShot）与前一镜（fromShot）归属/状态；
 * 2. 提取 + 登记前一镜结束边界帧；
 * 3. 把新锚点写入草稿中接收镜的 continuityAnchorUrl（保持 semantic_replacement，
 *    派生锚点 = 结束边界帧；referenceKeyframeUrl 保持 null，绝不引用爆款帧）；
 * 4. retryShot 只重生成接收镜（新版本），失败原因携带 gate 定位的断裂描述。
 */
export async function repairShotAtSeam(input: {
  controller: WorkflowController;
  ownerId: string;
  sessionId: string;
  toShotId: string;
  toShotIndex: number;
  fromShotId: string;
  fromShotIndex: number;
  reason: string;
}): Promise<{
  anchorUrl: string;
  anchorSha256: string;
  submitted: boolean;
  newVersion: number;
}> {
  const { controller, ownerId, sessionId, toShotId, toShotIndex, fromShotId, fromShotIndex, reason } = input;
  const toShot = db
    .prepare('SELECT * FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
    .get(toShotId, ownerId) as any;
  if (!toShot || Number(toShot.shot_index) !== toShotIndex) {
    throw new SeamRepairError('seam_shot_not_found', `接收镜（第 ${toShotIndex} 镜）不存在或不属于当前用户`);
  }
  const fromShot = db
    .prepare('SELECT * FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
    .get(fromShotId, ownerId) as any;
  if (!fromShot || Number(fromShot.shot_index) !== fromShotIndex) {
    throw new SeamRepairError('seam_from_shot_not_found', `前一镜（第 ${fromShotIndex} 镜）不存在或不属于当前用户`);
  }

  // 1) 提取 + 登记结束边界帧（只来自本系统生成视频）
  const anchor = await registerSeamAnchorFrame({ ownerId, sessionId, fromShot, reason });

  // 2) 更新草稿中接收镜的连续性锚点（语义承接：接收镜以「前一镜结束状态」为派生基座）
  const stateRow = db
    .prepare('SELECT draft_json FROM workbench_state WHERE owner_id = ? AND session_id = ? LIMIT 1')
    .get(ownerId, sessionId) as { draft_json?: string } | undefined;
  if (!stateRow?.draft_json) {
    throw new SeamRepairError('seam_draft_missing', '找不到工作台草稿，无法写入连续性锚点');
  }
  const draft = JSON.parse(stateRow.draft_json);
  if (!Array.isArray(draft.shots)) {
    throw new SeamRepairError('seam_draft_missing', '草稿分镜格式无效');
  }
  const draftShot = draft.shots.find((s: any) => Number(s.shotIndex) === toShotIndex);
  if (!draftShot) {
    throw new SeamRepairError('seam_draft_missing', `草稿中不存在第 ${toShotIndex} 镜`);
  }
  draftShot.continuityAnchorUrl = anchor.anchorUrl;
  draftShot.seamRepair = {
    fromShotIndex,
    anchorUrl: anchor.anchorUrl,
    reason,
    repairedAt: Date.now(),
  };
  db.prepare(
    'UPDATE workbench_state SET draft_json = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_id = ? AND session_id = ?'
  ).run(JSON.stringify(draft), ownerId, sessionId);

  // 3) 重置接收镜为可重提状态（与 runFixLoop 同语义：清旧任务 id/产物，
  //    否则 retryShot 拒绝重提 completed 镜头，幂等判定也会短路）。
  //    重置前保留版本历史（v1 行不动，重生成创建新版本）。
  db.prepare(
    `UPDATE shot_generation_tasks
        SET status = 'pending', error_message = NULL, seedance_task_id = NULL, video_url = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_id = ?`
  ).run(toShotId, ownerId);

  // 4) 只重生成接收镜（retryShot 走同一套原子 claim + 首帧派生/预检/安全链路）
  const fixCount = (db.prepare(
    `SELECT COUNT(*) AS cnt FROM cost_ledger WHERE shot_id = ? AND failure_reason LIKE 'semantic_fix:%'`
  ).get(toShotId) as { cnt: number }).cnt;
  const retry = await controller.retryShot({
    ownerId,
    runId: sessionId,
    shotId: toShotId,
    attempt: Math.max(1, fixCount + 1),
    failureReason: `seam_repair:${reason.slice(0, 200)}`,
    fixGuidance: [`剪辑点承接修复：以第 ${fromShotIndex} 镜的结束画面（${anchor.anchorUrl}）为条件化锚点重派生首帧并重生成；${reason.slice(0, 300)}`],
  });

  return {
    anchorUrl: anchor.anchorUrl,
    anchorSha256: anchor.anchorSha256,
    submitted: Boolean(retry.submitted),
    newVersion: Number(retry.attempt || toShot.current_version || 1),
  };
}

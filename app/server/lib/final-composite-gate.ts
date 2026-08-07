/**
 * S3 最终合成质量门禁（深模块）
 *
 * 职责：在 concat/Step5 等「最终合成」入口前，逐镜校验 QA 判决。
 * 规则（P3 审查确定性缺陷修复）：
 * - 只有 全部镜头 QA pass（overall_verdict=pass/verified），或 对应镜头有明确
 *   manualPassed（人工通过），才允许最终合成；
 * - fail / unverified / warning / pending（未 QA）的镜头一律阻断，返回可读原因；
 * - 合成是「镜头 → 成片」的最后一道门，任何不合格镜头都不能静默绕过。
 *
 * 可测试性：纯 DB 读取 + 纯函数，无外部调用。
 */
import { db } from './db';

export interface CompositeBlockedShot {
  shotId: string;
  shotIndex: number;
  status: string;
  verdict: string;
  manualPassed: boolean;
  reason: string;
}

export interface FinalCompositeGateResult {
  canCompose: boolean;
  sessionId?: string;
  checkedShots: number;
  blockedShots: CompositeBlockedShot[];
  /** 用户可读的阻断原因（每条一个镜头） */
  reasons: string[];
}

export const COMPOSITE_VERDICT_LABELS: Record<string, string> = {
  pass: '通过',
  verified: '通过',
  warning: '有风险',
  fail: '不合格',
  unverified: '未验证',
  pending: '未执行 QA',
};

function loadShotReports(shotId: string): Array<{ version: number; overall_verdict: string; manual_passed: number }> {
  try {
    return db
      .prepare(
        `SELECT version, overall_verdict, manual_passed
           FROM shot_qa_reports
          WHERE shot_id = ?
          ORDER BY created_at DESC, rowid DESC`
      )
      .all(shotId) as Array<{ version: number; overall_verdict: string; manual_passed: number }>;
  } catch {
    return [];
  }
}

export function evaluateFinalCompositeGate(opts: {
  sessionId: string;
  ownerId?: string;
  isAdmin?: boolean;
}): FinalCompositeGateResult {
  const { sessionId } = opts;
  const rows = (
    opts.ownerId && !opts.isAdmin
      ? db
          .prepare(
            `SELECT id, shot_index, status, qa_status, current_version
               FROM shot_generation_tasks
              WHERE session_id = ? AND owner_id = ?
              ORDER BY shot_index ASC`
          )
          .all(sessionId, opts.ownerId)
      : db
          .prepare(
            `SELECT id, shot_index, status, qa_status, current_version
               FROM shot_generation_tasks
              WHERE session_id = ?
              ORDER BY shot_index ASC`
          )
          .all(sessionId)
  ) as any[];

  if (rows.length === 0) {
    return {
      canCompose: false,
      sessionId,
      checkedShots: 0,
      blockedShots: [],
      reasons: [`会话 ${sessionId} 没有镜头任务，无法进行最终合成`],
    };
  }

  const blockedShots: CompositeBlockedShot[] = [];
  const reasons: string[] = [];

  for (const shot of rows) {
    const shotId = String(shot.id);
    const shotIndex = Number(shot.shot_index);
    const currentVersion = Number(shot.current_version || 1);

    // 当前版本报告优先；缺失时回退最新报告（版本切换时由 useVersion 同步任务状态）
    const reports = loadShotReports(shotId);
    const currentReport =
      reports.find((r) => Number(r.version) === currentVersion) ?? reports[0] ?? null;

    // 人工通过：当前版本报告 manual_passed=1，或任务级 qa_status='pass'
    // （manualPass 与 runShotQa 的 pass 判决都会写 qa_status）
    const manualPassed = Boolean(currentReport?.manual_passed) || shot.qa_status === 'pass';
    const verdict = currentReport?.overall_verdict || shot.qa_status || 'pending';
    const verdictLabel = COMPOSITE_VERDICT_LABELS[verdict] || verdict;

    if (shot.status !== 'completed') {
      blockedShots.push({
        shotId,
        shotIndex,
        status: shot.status,
        verdict,
        manualPassed,
        reason: `第 ${shotIndex} 镜状态为「${shot.status}」，尚未完成生成，不能进入最终合成`,
      });
      reasons.push(`第 ${shotIndex} 镜状态为「${shot.status}」，尚未完成生成，不能进入最终合成`);
      continue;
    }

    if (manualPassed) continue; // 人工明确通过 → 允许
    if (verdict === 'pass' || verdict === 'verified') continue; // QA 通过 → 允许

    blockedShots.push({
      shotId,
      shotIndex,
      status: shot.status,
      verdict,
      manualPassed,
      reason:
        verdict === 'pending'
          ? `第 ${shotIndex} 镜尚未执行 QA（无 QA 报告），未人工通过，禁止进入最终合成`
          : `第 ${shotIndex} 镜 QA 判决为「${verdictLabel}」且未人工通过，禁止进入最终合成`,
    });
    reasons.push(
      verdict === 'pending'
        ? `第 ${shotIndex} 镜尚未执行 QA（无 QA 报告），未人工通过，禁止进入最终合成`
        : `第 ${shotIndex} 镜 QA 判决为「${verdictLabel}」且未人工通过，禁止进入最终合成`
    );
  }

  return {
    canCompose: blockedShots.length === 0,
    sessionId,
    checkedShots: rows.length,
    blockedShots,
    reasons,
  };
}

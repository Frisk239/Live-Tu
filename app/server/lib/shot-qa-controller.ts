/**
 * P3 镜头 QA 与修复控制器（深模块）
 *
 * 职责：技术 QA + 语义 QA + 最多两次自动修复 + 人工通过 + 版本选择。
 * 约束：
 * - 已成功镜头绝不回滚；
 * - 自动修复最多两次，两次后仍失败则进入人工确认；
 * - 每次修复记录 prompt、模型、原因、成本和结果；
 * - 不允许静默整条重跑。
 *
 * 可测试性：通过 SemanticQaScorer 接口注入 fake seam（FakeVideoPort + FakeSemanticQaScorer）。
 */
import { db } from './db';
import { qaShotVideo, technicalQaScoreEntries, type ShotQaResult as TechQaResult } from './shot-qa';
import { createSemanticQaScorer, type SemanticQaScorer, type SemanticQaInput } from './semantic-qa';
import type {
  ShotQaRequest,
  ShotQaResult,
  FixShotRequest,
  FixShotResult,
  ManualPassRequest,
  ManualPassResult,
  UseVersionRequest,
  UseVersionResult,
  ShotVersionInfo,
} from '../../shared/workbench-contract';
import {
  type SemanticVerdict,
  type ShotSemanticQaReport,
  SEMANTIC_FIX_MAP,
  buildSemanticScorecard,
  deriveOverallVerdict as deriveSemanticOverallVerdict,
  generateSummary,
  issuesToScoreEntries,
} from '../../shared/semantic-qa';
import { recordCostEntry } from './telemetry';
import type { CostEntry } from '../../shared/cost-ledger';
import { microsToUsd, estimateVideoShotUsdMicros } from '../../shared/workbench-contract';

const MAX_AUTO_FIXES = 2;
const SEMANTIC_QA_SCORER_VERSION = 'v1.0.0';

export interface ShotQaControllerOptions {
  semanticScorer?: SemanticQaScorer;
  /** 技术 QA 注入点（默认 qaShotVideo；测试可注入确定性 fake） */
  techQaFn?: (url: string) => Promise<TechQaResult>;
}

/**
 * LLM vision only receives keyframes, so an unverified AV-sync assessment can
 * be completed by the measured ffprobe stream timeline. This is not a manual
 * override: missing streams, missing timing metadata, and failed alignment
 * remain blocking. Beat/copy synchronization belongs to final-video QA.
 */
export function mergeTechnicalQaIntoSemanticReport(
  semanticReport: ShotSemanticQaReport,
  techQa: TechQaResult
): ShotSemanticQaReport {
  const avSyncCheck = techQa.checks.find((check) => check.name === 'av_sync');
  const issues = semanticReport.issues.map((issue) => {
    if (
      issue.dimension !== 'av_sync' ||
      issue.verdict !== 'unverified' ||
      !avSyncCheck ||
      avSyncCheck.status === 'unverified'
    ) {
      return issue;
    }

    const passed = avSyncCheck.status === 'passed' && avSyncCheck.ok;
    return {
      ...issue,
      verdict: passed ? 'pass' as const : 'fail' as const,
      score: passed ? 1 : 0,
      evidence: [
        ...issue.evidence,
        {
          source: 'ffprobe',
          detail: `镜头级音视频时间轴检查：${avSyncCheck.detail || (passed ? '通过' : '失败')}`,
        },
      ],
      reason: passed
        ? '视觉模型未读取音频；ffprobe 已验证音频与视频流的起始时间及持续时间对齐。文案或节拍的语义卡点将在最终成片阶段单独验收。'
        : 'ffprobe 检测到音频与视频流时间轴未对齐，需修复音轨或重新生成该镜。',
      fix: passed ? null : SEMANTIC_FIX_MAP.av_sync(),
    };
  });

  return {
    ...semanticReport,
    issues,
    summary: generateSummary(issues),
    overallVerdict: deriveSemanticOverallVerdict(issues),
    scorecard: buildSemanticScorecard(
      semanticReport.shotId,
      semanticReport.runId || '',
      issuesToScoreEntries(issues),
      technicalQaScoreEntries(techQa)
    ),
  };
}

export class ShotQaController {
  private readonly scorer: SemanticQaScorer;
  private readonly techQa: (url: string) => Promise<TechQaResult>;

  constructor(opts: ShotQaControllerOptions = {}) {
    this.scorer = opts.semanticScorer ?? createSemanticQaScorer();
    // FAKE_TECH_QA=true 时技术 QA 恒定 verified（E2E 确定性；生产默认真实 ffmpeg 检查）
    this.techQa =
      opts.techQaFn ??
      (process.env.FAKE_TECH_QA === 'true'
        ? async () => ({
            status: 'verified' as const,
            ok: true,
            checks: [
              { name: 'video_stream', ok: true, status: 'passed' as const, detail: 'codec=h264' },
              { name: 'duration', ok: true, status: 'passed' as const, detail: '5.00s' },
              { name: 'resolution', ok: true, status: 'passed' as const, detail: '720x1280' },
              { name: 'audio_track', ok: true, status: 'passed' as const, detail: 'codec=aac; 5.00s' },
              { name: 'av_sync', ok: true, status: 'passed' as const, detail: 'audio/video duration delta 0.000s; start delta 0.000s' },
              { name: 'black_frame', ok: true, status: 'passed' as const, detail: '黑帧占比 0.0%' },
            ],
          })
        : qaShotVideo);
  }

  // ==================== QA 执行 ====================

  /**
   * 对单个镜头执行技术 QA + 语义 QA，持久化报告，更新 shot 状态。
   */
  async runShotQa(
    ownerId: string,
    request: ShotQaRequest
  ): Promise<ShotQaResult> {
    const { runId, shotId } = request;

    const shot = db
      .prepare('SELECT * FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
      .get(shotId, ownerId) as any;
    if (!shot) throw new QaControllerError(404, 'shot_not_found', '未找到该镜头');
    if (shot.status !== 'completed') {
      throw new QaControllerError(
        409,
        'shot_not_completed',
        `镜头状态为 ${shot.status}，需 completed 后才能执行 QA`
      );
    }

    const version = shot.current_version || 1;
    const videoUrl = shot.video_url;

    // 1. 技术 QA（ffmpeg 检查）
    let techQa: TechQaResult;
    try {
      techQa = await this.techQa(videoUrl);
    } catch (err: any) {
      techQa = {
        status: 'unverified',
        ok: false,
        checks: [{ name: 'probe_error', ok: false, status: 'unverified', detail: String(err.message) }],
        reason: String(err.message),
      };
    }

    // 2. 语义 QA（LLM vision 或 fake）
    const draft = this.loadDraft(ownerId, runId || shot.session_id);
    const semanticReport = mergeTechnicalQaIntoSemanticReport(
      await this.runSemanticQa(ownerId, shot, version, draft),
      techQa
    );

    // 3. 构建并持久化 QA 报告
    const reportJson = JSON.stringify({
      tech: techQa,
      semantic: semanticReport,
      version,
      shotId,
      runId,
    });
    const reportId = `qa-${shotId}-v${version}-${Date.now()}`;
    db.prepare(
      `INSERT INTO shot_qa_reports
         (id, shot_id, run_id, version, owner_id, report_json,
          tech_status, semantic_status, overall_verdict,
          manual_passed, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      reportId,
      shotId,
      runId || shot.session_id,
      version,
      ownerId,
      reportJson,
      techQa.status,
      semanticReport.overallVerdict,
      this.deriveOverallVerdict(techQa.status, semanticReport.overallVerdict),
      Date.now()
    );

    // 4. 更新 shot_generation_tasks 的 QA 状态
    const overall = this.deriveOverallVerdict(techQa.status, semanticReport.overallVerdict);
    db.prepare(
      `UPDATE shot_generation_tasks
         SET qa_status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(overall, shotId);

    // 5. 持久化 shot_version 的 qa_report_id
    const versionRow = db
      .prepare('SELECT id FROM shot_versions WHERE shot_id = ? AND version = ?')
      .get(shotId, version) as { id: string } | undefined;
    if (versionRow) {
      db.prepare('UPDATE shot_versions SET qa_report_id = ? WHERE id = ?')
        .run(reportId, versionRow.id);
    }

    return {
      shotId,
      version,
      overallVerdict: overall,
      summary: semanticReport.summary,
      issues: semanticReport.issues.map((i) => ({
        dimension: i.dimension,
        verdict: i.verdict,
        reason: i.reason,
        fixAction: i.fix?.action ?? null,
      })),
      reportId,
    };
  }

  // ==================== 自动修复循环 ====================

  /**
   * 执行修复循环：检查 QA 结果 → 建议修复 → 重新生成 → 重新 QA → 最多 2 次。
   */
  async runFixLoop(
    ownerId: string,
    request: FixShotRequest
  ): Promise<FixShotResult> {
    const { runId, shotId, skipAutoFix } = request;

    const shot = db
      .prepare('SELECT * FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
      .get(shotId, ownerId) as any;
    if (!shot) throw new QaControllerError(404, 'shot_not_found', '未找到该镜头');

    const currentVerdict = shot.qa_status || 'pending';
    const autoFixCount = this.getAutoFixCount(shotId);

    // 已通过或已人工通过 → 无需修复
    if (currentVerdict === 'verified' || shot.qa_status === 'pass') {
      return {
        shotId,
        action: 'already_passing',
        newVersion: shot.current_version || 1,
        autoFixCount,
        verdict: currentVerdict,
        summary: '镜头已通过 QA 检查',
      };
    }

    // 达到最大自动修复次数 → 需人工确认
    if (autoFixCount >= MAX_AUTO_FIXES || skipAutoFix) {
      return {
        shotId,
        action: 'max_fixes_reached',
        newVersion: shot.current_version || 1,
        autoFixCount,
        verdict: currentVerdict,
        summary: autoFixCount >= MAX_AUTO_FIXES
          ? `已达最大自动修复次数（${MAX_AUTO_FIXES}），需人工确认`
          : '用户选择跳过自动修复，需人工确认',
      };
    }

    // 获取最新 QA 报告中的修复建议
    const latestReport = this.getLatestQaReport(shotId);
    if (!latestReport) {
      return {
        shotId,
        action: 'needs_human_confirm',
        newVersion: shot.current_version || 1,
        autoFixCount,
        verdict: currentVerdict,
        summary: '无 QA 报告，请先执行 QA 检查',
      };
    }

    // 提取修复建议（语义维度 + 技术 QA 失败）
    const parsedReport = JSON.parse(latestReport.report_json);
    const semanticReport: ShotSemanticQaReport = parsedReport.semantic;
    const techReport: TechQaResult = parsedReport.tech;
    const failFixes = semanticReport.issues
      .filter((i) => i.verdict === 'fail' || i.verdict === 'warning')
      .map((i) => i.fix)
      .filter(Boolean);
    // 技术 QA 失败（黑帧/分辨率等）也触发修复，使用通用建议
    const techFailing = techReport.status === 'warning';
    if (techFailing) {
      failFixes.push({
        dimension: 'playability' as any,
        action: '重新生成以修复技术问题（黑帧/分辨率/时长）',
        promptFragment: 'No black frames, stable camera, sharp focus, high resolution',
      });
    }

    if (failFixes.length === 0) {
      return {
        shotId,
        action: 'already_passing',
        newVersion: shot.current_version || 1,
        autoFixCount,
        verdict: currentVerdict,
        summary: '无不合格项需修复',
      };
    }

    // 构建增强 prompt（在原始 prompt 基础上附加修复建议）
    const originalPrompt = shot.video_prompt || '';
    const fixFragments = failFixes
      .map((f) => f?.promptFragment)
      .filter(Boolean)
      .join('; ');
    const enhancedPrompt = fixFragments
      ? `${originalPrompt}\n\n[修复增强] ${fixFragments}`
      : originalPrompt;

    // 记录修复到成本账本
    const newVersion = (shot.current_version || 1) + 1;
    const failureReason = `semantic_fix:${failFixes.map((f) => f?.dimension).join(',')}`;
    this.recordFixCost(ownerId, shot, runId || shot.session_id, newVersion, failureReason);

    // 准备修复：更新 prompt + 状态回到 pending（版本行由实际重新生成时创建，
    // 避免版本号重复——fix 只负责"准备"，重生成由 retryShot/confirmBatchSubmit 执行）。
    // 必须同时清空 seedance_task_id / video_url：fix 意味着重新提交 provider（新任务），
    // 若保留旧任务 id，claimAndSubmitCheckedShot 的幂等判定（seedance_task_id 非空且
    // 非 failed）会把重新生成短路成「已提交过」，导致修复后不产生新版本、镜头卡 pending。
    db.prepare(
      `UPDATE shot_generation_tasks
         SET video_prompt = ?, status = 'pending',
             error_message = NULL, seedance_task_id = NULL, video_url = NULL,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(enhancedPrompt.slice(0, 2000), shotId);

    return {
      shotId,
      action: 'regenerated',
      newVersion,
      autoFixCount: autoFixCount + 1,
      verdict: 'pending',
      summary: `已触发第 ${autoFixCount + 1} 次自动修复，等待重新生成`,
    };
  }

  // ==================== 人工通过 ====================

  manualPass(ownerId: string, request: ManualPassRequest): ManualPassResult {
    const { runId, shotId, comment } = request;

    const shot = db
      .prepare('SELECT * FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
      .get(shotId, ownerId) as any;
    if (!shot) throw new QaControllerError(404, 'shot_not_found', '未找到该镜头');

    const version = shot.current_version || 1;

    // 更新 QA 报告的 manual_passed
    const latestReport = this.getLatestQaReport(shotId);
    if (latestReport) {
      db.prepare(
        `UPDATE shot_qa_reports
           SET manual_passed = 1, manual_pass_comment = ?
         WHERE id = ?`
      ).run(comment || null, latestReport.id);
    }

    // 更新 shot 状态
    db.prepare(
      `UPDATE shot_generation_tasks
         SET qa_status = 'pass', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(shotId);

    // 记录人工选择到成本账本
    const costId = `cost-manual-pass-${shotId}-v${version}-${Date.now()}`;
    const entry: CostEntry = {
      id: costId,
      scope: 'shot',
      runId: runId || shot.session_id,
      shotId,
      provider: 'manual',
      model: 'human',
      modelVersion: 'human',
      seed: null,
      promptVersion: 'v1.0.0',
      queueMs: 0,
      generationMs: 0,
      retries: 0,
      failureReason: null,
      billing: [],
      estimatedUsd: 0,
      actualUsd: 0,
      currency: 'USD',
      source: 'estimate',
      manualChoice: `manual-pass:${comment || 'accepted'}`,
      scorecardVersion: SEMANTIC_QA_SCORER_VERSION,
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: Date.now(),
    };
    try {
      recordCostEntry(entry, ownerId);
    } catch {}

    return {
      shotId,
      version,
      manualPassed: true,
      comment: comment || null,
    };
  }

  // ==================== 版本选择 ====================

  useVersion(ownerId: string, request: UseVersionRequest): UseVersionResult {
    const { runId, shotId, versionId } = request;

    const shot = db
      .prepare('SELECT * FROM shot_generation_tasks WHERE id = ? AND owner_id = ?')
      .get(shotId, ownerId) as any;
    if (!shot) throw new QaControllerError(404, 'shot_not_found', '未找到该镜头');

    const versionRow = db
      .prepare('SELECT * FROM shot_versions WHERE id = ? AND owner_id = ?')
      .get(versionId, ownerId) as any;
    if (!versionRow) throw new QaControllerError(404, 'version_not_found', '未找到该版本');

    if (versionRow.shot_id !== shotId) {
      throw new QaControllerError(400, 'version_shot_mismatch', '版本不属于该镜头');
    }

    // S3 修复（版本回退状态漂移）：
    // 切换版本必须恢复该版本的完整状态，而不只是 video_url/current_version——
    //   video_url   ← 版本视频
    //   video_prompt ← 该版本的 prompt（后续局部重试/修复使用正确提示词）
    //   qa_status   ← 该版本对应 QA 报告的判决（QA 展示关系与门禁判定一致）
    // 版本行无 first_frame_url 列（首帧属镜头级输入，不随版本漂移），保持不变。
    // S4.1 修复（人工通过不随版本回退丢失）：人工通过是镜头级事实——
    // 只要该镜头存在任一 manual_passed 报告，qa_status 保持 pass，
    // 不能让「切回历史版本」悄悄剥夺已确认的人工通过状态。
    const report = versionRow.qa_report_id
      ? (db
          .prepare('SELECT overall_verdict, manual_passed FROM shot_qa_reports WHERE id = ?')
          .get(versionRow.qa_report_id) as { overall_verdict: string; manual_passed: number } | undefined)
      : null;
    const anyManualPass = db
      .prepare('SELECT 1 FROM shot_qa_reports WHERE shot_id = ? AND manual_passed = 1 LIMIT 1')
      .get(shotId);
    const qaStatus = anyManualPass ? 'pass' : report?.overall_verdict || 'pending';
    db.prepare(
      `UPDATE shot_generation_tasks
         SET video_url = ?, current_version = ?, video_prompt = ?, qa_status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(versionRow.video_url, versionRow.version, versionRow.prompt ?? shot.video_prompt, qaStatus, shotId);

    return {
      shotId,
      newVersion: versionRow.version,
      videoUrl: versionRow.video_url,
      selectedVersionId: versionId,
    };
  }

  // ==================== 版本列表查询 ====================

  getShotVersions(shotId: string, ownerId: string): ShotVersionInfo[] {
    const rows = db
      .prepare(
        `SELECT sv.*, sq.overall_verdict
         FROM shot_versions sv
         LEFT JOIN shot_qa_reports sq ON sv.qa_report_id = sq.id
         WHERE sv.shot_id = ? AND sv.owner_id = ?
         ORDER BY sv.version ASC`
      )
      .all(shotId, ownerId) as any[];

    return rows.map((r) => ({
      versionId: r.id,
      version: r.version,
      videoUrl: r.video_url,
      prompt: r.prompt,
      modelCode: r.model_code,
      status: r.status,
      verdict: r.overall_verdict || null,
      createdAt: r.created_at,
    }));
  }

  // ==================== 私有方法 ====================

  private async runSemanticQa(
    ownerId: string,
    shot: any,
    version: number,
    draft: any
  ): Promise<ShotSemanticQaReport> {
    const productUrl = draft?.productAssetUrl || '/uploads/product-assets/pa_1785762173546_5rkfnl.png';
    const draftShot = Array.isArray(draft?.shots)
      ? draft.shots.find((candidate: any) => Number(candidate?.shotIndex) === Number(shot.shot_index))
      : null;

    const input: SemanticQaInput = {
      shotId: String(shot.id),
      runId: shot.pipeline_run_id || null,
      version,
      shotIndex: Number(shot.shot_index),
      generatedVideoUrl: shot.video_url || '',
      // 参考视频关键帧（demo/工作台草稿可携带；用于 LLM 对比参考结构）
      referenceKeyframes: Array.isArray(draft?.referenceKeyframes) ? draft.referenceKeyframes : [],
      productImageUrl: productUrl,
      productName: draft?.productName || 'BUV 小绿泥洁面',
      prohibitedItems: draft?.prohibitedItems || [
        '竞品品牌标识',
        '非 BUV 产品包装',
        '夸大功效文字',
        '未备案广告语',
      ],
      allowedItems: draft?.allowedItems || [
        'BUV 品牌产品',
        '洁面泡沫',
        '面部特写',
      ],
      referenceStructure: draft?.referenceStructure || '洁面产品使用特写镜头',
      shotPurpose: draftShot?.semanticPurpose || draftShot?.visualIntent || undefined,
      sourceAction: draftShot?.sourceAction || undefined,
      transitionIn: draftShot?.transitionIn || undefined,
      transitionOut: draftShot?.transitionOut || undefined,
    };

    try {
      return await this.scorer.scoreShot(input);
    } catch (err: any) {
      console.warn('[shot-qa-controller] semantic QA failed:', err.message);
      return {
        shotId: String(shot.id),
        runId: shot.pipeline_run_id || null,
        version,
        issues: [],
        summary: `语义 QA 失败: ${String(err.message).slice(0, 100)}`,
        scorecard: {
          version: SEMANTIC_QA_SCORER_VERSION,
          generatedBy: 'semantic-qa-error-fallback',
          sampleId: String(shot.id),
          runId: shot.pipeline_run_id || '',
          dimensions: [],
          weighted: { value: 0, measuredCount: 0, unverifiedCount: 8 },
          hardGates: [],
          hardGatesPassed: false,
        },
        overallVerdict: 'unverified',
        checkedAt: Date.now(),
        scorer: 'error-fallback',
        scorerVersion: SEMANTIC_QA_SCORER_VERSION,
        manualPassed: false,
        manualPassComment: null,
      };
    }
  }

  private deriveOverallVerdict(
    techStatus: string,
    semanticVerdict: string
  ): 'pass' | 'warning' | 'fail' | 'unverified' {
    // 优先级：fail > unverified > warning > pass（与 shared/semantic-qa deriveOverallVerdict 一致）
    if (semanticVerdict === 'fail') return 'fail';
    if (techStatus === 'unverified' || semanticVerdict === 'unverified') return 'unverified';
    if (techStatus === 'warning' || semanticVerdict === 'warning') return 'warning';
    if (techStatus === 'verified' && semanticVerdict === 'pass') return 'pass';
    return 'unverified';
  }

  private loadDraft(ownerId: string, sessionId: string): any {
    const row = db
      .prepare('SELECT draft_json FROM workbench_state WHERE owner_id = ? AND session_id = ?')
      .get(ownerId, sessionId) as { draft_json?: string } | undefined;
    if (!row?.draft_json) return null;
    try {
      return JSON.parse(row.draft_json);
    } catch {
      return null;
    }
  }

  private getAutoFixCount(shotId: string): number {
    const rows = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM cost_ledger
         WHERE shot_id = ? AND failure_reason LIKE 'semantic_fix:%'`
      )
      .get(shotId) as { cnt: number } | undefined;
    return rows?.cnt ?? 0;
  }

  private getLatestQaReport(shotId: string): any {
    return db
      .prepare(
        `SELECT * FROM shot_qa_reports
         WHERE shot_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(shotId);
  }

  private recordFixCost(
    ownerId: string,
    shot: any,
    runId: string,
    version: number,
    failureReason: string
  ): void {
    // id 带毫秒 + 随机后缀，避免同毫秒多次修复 UNIQUE 冲突
    const id = `cost-fix-${shot.id}-v${version}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const estimatedMicros = estimateVideoShotUsdMicros('doubao-seedance-2-0-fast', 1);
    const entry: CostEntry = {
      id,
      scope: 'shot',
      runId,
      shotId: String(shot.id),
      provider: 'seedance-relay',
      model: 'doubao-seedance-2-0-fast',
      modelVersion: 'doubao-seedance-2-0-fast',
      seed: null,
      promptVersion: 'v1.0.0',
      queueMs: 'unknown',
      generationMs: 'unknown',
      retries: version,
      failureReason: failureReason as CostEntry['failureReason'],
      billing: [{ unit: 'videos', amount: 1 }],
      estimatedUsd: microsToUsd(estimatedMicros),
      actualUsd: 'unknown',
      currency: 'USD',
      source: 'estimate',
      manualChoice: null,
      scorecardVersion: SEMANTIC_QA_SCORER_VERSION,
      pipelineVersion: 'v1.0.0',
      gitCommit: 'unknown',
      recordedAt: Date.now(),
    };
    try {
      recordCostEntry(entry, ownerId);
    } catch {}
  }
}

export class QaControllerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

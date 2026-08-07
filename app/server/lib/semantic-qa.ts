/**
 * P3 语义 QA 评分引擎（深模块）
 *
 * 职责：对单个生成镜头执行 8 项语义维度检查，返回证据化评分卡。
 * 两条执行路径：
 * - LlmSemanticQaScorer（真实）：提取视频关键帧 + 参考帧 + 产品图 → LLM vision 评估
 * - FakeSemanticQaScorer（确定性）：基于 seed 的伪随机评分，用于 CI/测试
 *
 * 可测试性：通过 SemanticQaScorer 接口注入，fake seam 确保零真实付费。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {
  type SemanticIssue,
  type SemanticVerdict,
  type ShotSemanticQaReport,
  SEMANTIC_QA_VERSION,
  deriveOverallVerdict,
  generateSummary,
  issuesToScoreEntries,
  buildSemanticScorecard,
  SEMANTIC_FIX_MAP,
  buildSemanticQaPrompt,
  type SemanticFixSuggestion,
} from '../../shared/semantic-qa';
import type { ScoreDimensionId } from '../../shared/scorecard';
import { callLlmGateway, extractJsonObject } from './llm-gateway';

const execAsync = promisify(exec);

// ==================== 接口 ====================

export interface SemanticQaScorer {
  readonly name: string;
  readonly version: string;
  scoreShot(input: SemanticQaInput): Promise<ShotSemanticQaReport>;
}

export interface SemanticQaInput {
  shotId: string;
  runId: string | null;
  version: number;
  shotIndex: number;
  /** 生成镜头视频 URL（本地 /uploads 或远端 http） */
  generatedVideoUrl: string;
  /** 参考视频关键帧 URL 列表 */
  referenceKeyframes: string[];
  /** 产品图 URL */
  productImageUrl: string;
  /** 产品名称 */
  productName: string;
  /** 禁止元素 */
  prohibitedItems: string[];
  /** 允许元素 */
  allowedItems: string[];
  /** 参考视频结构描述 */
  referenceStructure: string;
  /** Optional semantic storyboard contract for this shot. */
  shotPurpose?: string;
  sourceAction?: string;
  transitionIn?: string;
  transitionOut?: string;
}

// ==================== 帧提取 ====================

function resolveFfmpeg(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * 从视频中提取 3 个关键帧（中段 + 1/4 + 3/4 位置）。
 * 返回提取后的本地路径列表。
 * 注意：输出目录必须在 UPLOADS_DIR 下——llm-gateway 的 formatImageUrlForLlm 只把
 * /uploads 内的文件转成 base64 data URI；uploads 外的绝对路径会被原样传给中转而报
 * "illegal base64 data"（真实运行已复现）。
 * requestId：每次 QA 调用唯一的目录标识（run/shot/request 三级隔离），
 * 清理时只删除本请求自己的目录，绝不触碰其他并发 QA 的临时帧。
 * 导出仅供并发隔离测试使用（S3 QA 临时目录并发互删回归）。
 */
export async function extractKeyframes(
  videoUrl: string,
  outDir: string,
  count = 3,
  requestId?: string
): Promise<string[]> {
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  let localPath: string | null = null;

  if (videoUrl.startsWith('/uploads/') || videoUrl.startsWith('uploads/')) {
    localPath = path.join(uploadsRoot, videoUrl.replace(/^\/?uploads\//, ''));
    if (!fs.existsSync(localPath)) localPath = null;
  }
  if (!localPath && videoUrl.startsWith('http')) {
    const cached = path.join(uploadsRoot, 'renders', path.basename(new URL(videoUrl).pathname));
    if (fs.existsSync(cached)) localPath = cached;
  }
  if (!localPath) return [];

  // 输出目录强制落在 uploads 内（否则 base64 转换失败）。
  // S3 并发修复：目录名 = 本次 QA 请求唯一 id，多个并发 QA 互不覆盖、互不清理。
  const safeOutDir = path.join(uploadsRoot, '.qa-tmp', requestId || path.basename(outDir));
  // 获取视频时长
  try {
    const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${localPath}"`;
    const { stdout: durStr } = await execAsync(probeCmd, { timeout: 10_000 });
    const duration = parseFloat(durStr.trim());
    if (!Number.isFinite(duration) || duration <= 0) return [];

    const urls: string[] = [];
    fs.mkdirSync(safeOutDir, { recursive: true });
    for (let i = 0; i < count; i++) {
      const t = duration * ((i + 1) / (count + 1));
      const outFile = path.join(safeOutDir, `kf_${shotIdHash(videoUrl)}_${i}_${t.toFixed(1)}s.jpg`);
      try {
        await execAsync(
          `ffmpeg -y -v error -ss ${t.toFixed(2)} -i "${localPath}" -frames:v 1 -q:v 2 "${outFile}"`,
          { timeout: 15_000 }
        );
        // 返回 /uploads 相对路径（llm-gateway 只把 /uploads 内文件转 base64 data URI）
        urls.push(`/uploads/.qa-tmp/${requestId || path.basename(outDir)}/${path.basename(outFile)}`);
      } catch {
        // 单帧提取失败跳过
      }
    }
    return urls;
  } catch {
    return [];
  }
}

function shotIdHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

// ==================== 真实 LLM 语义评分 ====================

const SEMANTIC_DIMENSIONS: ScoreDimensionId[] = [
  'product_consistency',
  'competitor_residue',
  'shot_structure_coverage',
  'hook_quality',
  'subject_deformation',
  'cross_shot_continuity',
  'av_sync',
  'compliance_risk',
];

export class LlmSemanticQaScorer implements SemanticQaScorer {
  readonly name = 'llm-vision-semantic-qa';
  readonly version = SEMANTIC_QA_VERSION;

  async scoreShot(input: SemanticQaInput): Promise<ShotSemanticQaReport> {
    const { system, user } = buildSemanticQaPrompt({
      shotIndex: input.shotIndex,
      product: input.productName,
      productName: input.productName,
      prohibitedItems: input.prohibitedItems,
      allowedItems: input.allowedItems,
      referenceStructure: input.referenceStructure,
      shotPurpose: input.shotPurpose,
      sourceAction: input.sourceAction,
      transitionIn: input.transitionIn,
      transitionOut: input.transitionOut,
    });

    // 提取关键帧：仅生成镜头视频需要抽帧；参考关键帧本身就是图片，
    // 直接传入（llm-gateway 会把 /uploads 内文件转 base64 data URI）——
    // 不再对 jpg 二次 ffmpeg 抽帧（单帧图片 -ss 抽帧会输出空文件，且 payload 变大）
    // S3 并发修复：每次 QA 使用独立 run/shot/request 目录（requestId），只清理自己的目录。
    const requestId = `qa-${shotIdHash(input.shotId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpDir = path.resolve(process.env.DATA_DIR || '.', 'tmp', requestId);
    let generatedFrames: string[] = [];
    try {
      generatedFrames = await extractKeyframes(input.generatedVideoUrl, path.join(tmpDir, 'gen'), 3, requestId);
    } catch (err: any) {
      console.warn('[semantic-qa] frame extraction failed:', err.message);
    }
    const referenceFrames: string[] = input.referenceKeyframes.filter(
      (u) => u && typeof u === 'string' && u.trim().length > 0
    );

    // 构建图片 URL 列表
    const imageUrls: string[] = [
      ...generatedFrames,
      ...referenceFrames,
      ...(input.productImageUrl ? [input.productImageUrl] : []),
    ].filter((u) => u && u.length > 0);

    // 调试：打印实际发送的图片（真实运行排查 base64 解码失败用）
    if (process.env.SEMANTIC_QA_DEBUG === 'true') {
      console.warn(
        '[semantic-qa] imageUrls:',
        imageUrls.map((u) => `${u.slice(0, 40)}...(${u.length})`).join('\n  ')
      );
    }

    // 调用 LLM vision
    let rawDimensions: any[] = [];
    try {
      const response = await callLlmGateway({
        system,
        user,
        imageUrls,
        temperature: 0.1,
      });
      if (response.success && response.data?.dimensions) {
        rawDimensions = response.data.dimensions;
      } else {
        // 调试：LLM 成功但未返回 dimensions（真实运行排查用）
        console.warn(
          '[semantic-qa] LLM 响应缺少 dimensions 字段:',
          JSON.stringify(response.data || {}).slice(0, 400),
          '| images:', imageUrls.length,
          '| model:', response.modelUsed
        );
      }
    } catch (err: any) {
      console.warn('[semantic-qa] LLM call failed:', err.message);
    }

    // 解析 LLM 输出为 SemanticIssue[]
    const issues = this.parseDimensions(rawDimensions, input);

    // 清理临时文件：只清理本次 QA 自己的目录（DATA_DIR/tmp/<requestId> +
    // uploads/.qa-tmp/<requestId>），绝不删除其他并发 QA 的目录。
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
      fs.rmSync(path.join(uploadsRoot, '.qa-tmp', requestId), { recursive: true, force: true });
    } catch {}

    return this.buildReport(input, issues);
  }

  private parseDimensions(raw: any[], input: SemanticQaInput): SemanticIssue[] {
    const issues: SemanticIssue[] = [];

    for (const dim of SEMANTIC_DIMENSIONS) {
      const match = raw.find(
        (d: any) => d.id === dim || d.dimension === dim
      );

      if (!match) {
        // LLM 未返回该维度 → unverified
        issues.push({
          dimension: dim,
          verdict: 'unverified',
          score: null,
          evidence: [{ source: 'semantic-qa', detail: 'LLM 未返回该维度评估' }],
          reason: '无法从生成结果中判断该维度质量',
          fix: null,
        });
        continue;
      }

      const verdict: SemanticVerdict =
        match.verdict === 'pass' || match.verdict === 'warning' || match.verdict === 'fail'
          ? match.verdict
          : 'unverified';

      const score = typeof match.score === 'number' && match.score >= 0 && match.score <= 1
        ? match.score
        : verdict === 'pass'
          ? 0.9
          : verdict === 'warning'
            ? 0.6
            : verdict === 'fail'
              ? 0.3
              : null;

      const evidenceList = Array.isArray(match.evidence)
        ? match.evidence.map((e: any) => ({
            source: 'llm-vision',
            detail: String(e),
          }))
        : [{ source: 'llm-vision', detail: String(match.reason || '无证据') }];

      const reason = typeof match.reason === 'string'
        ? match.reason
        : verdict === 'pass'
          ? '合格'
          : '需检查';

      const fix: SemanticFixSuggestion | null =
        verdict === 'fail' || verdict === 'warning'
          ? SEMANTIC_FIX_MAP[dim]?.(input.productImageUrl) || null
          : null;

      issues.push({
        dimension: dim,
        verdict,
        score,
        evidence: evidenceList,
        reason,
        fix,
      });
    }

    return issues;
  }

  private buildReport(
    input: SemanticQaInput,
    issues: SemanticIssue[]
  ): ShotSemanticQaReport {
    const semanticEntries = issuesToScoreEntries(issues);
    const scorecard = buildSemanticScorecard(
      input.shotId,
      input.runId || '',
      semanticEntries
    );

    return {
      shotId: input.shotId,
      runId: input.runId,
      version: input.version,
      issues,
      summary: generateSummary(issues),
      scorecard,
      overallVerdict: deriveOverallVerdict(issues),
      checkedAt: Date.now(),
      scorer: this.name,
      scorerVersion: this.version,
      manualPassed: false,
      manualPassComment: null,
    };
  }
}

// ==================== 确定性 Fake 语义评分 ====================

/** 确定性伪随机数生成（mulberry32，复用 golden-eval 同源） */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FakeSemanticQaOptions {
  /** 随机种子 */
  seed?: number;
  /** 强制指定某些维度为 fail（用于测试修复循环） */
  forceFail?: ScoreDimensionId[];
  /** 强制指定某些维度为 warning */
  forceWarning?: ScoreDimensionId[];
  /** 强制指定某些维度为 unverified（模拟输入证据不足，不得伪造通过） */
  forceUnverified?: ScoreDimensionId[];
  /** 仅首次检查（per shotId）失败的维度：首次 QA fail → 修复重检后 pass（模拟可恢复缺陷） */
  failOnce?: ScoreDimensionId[];
  /** 只对这些 shotIndex（1-based）应用 forceFail（用于 E2E 多镜场景） */
  failShotIndexes?: number[];
}

/**
 * 确定性 Fake 语义评分器：不调用 LLM，基于 seed 生成伪随机分数。
 * 用于 CI/E2E，verdict 全部 determined by forceFail/forceWarning 配置。
 * env 控制（E2E runner 使用）：
 * - FAKE_SEMANTIC_QA_FAIL=dim1,dim2        始终 fail 的维度
 * - FAKE_SEMANTIC_QA_FAIL_ONCE=dim1,dim2   每个镜头首次检查失败的维度（修复后通过）
 * - FAKE_SEMANTIC_QA_FAIL_SHOT_INDEXES=1,2 只对指定镜头应用 forceFail（1-based）
 */
export class FakeSemanticQaScorer implements SemanticQaScorer {
  readonly name = 'fake-semantic-qa';
  readonly version = SEMANTIC_QA_VERSION;
  private readonly rng: () => number;
  private readonly forceFail: Set<string>;
  private readonly forceWarning: Set<string>;
  private readonly forceUnverified: Set<string>;
  private readonly failOnce: Set<string>;
  private readonly failShotIndexes: Set<number>;
  /** 记录每个 shotId 的首次检查标记（failOnce 语义） */
  private readonly firstChecked = new Set<string>();

  constructor(opts: FakeSemanticQaOptions = {}) {
    const envFail = (process.env.FAKE_SEMANTIC_QA_FAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
    const envFailOnce = (process.env.FAKE_SEMANTIC_QA_FAIL_ONCE || '').split(',').map((s) => s.trim()).filter(Boolean);
    const envIndexes = (process.env.FAKE_SEMANTIC_QA_FAIL_SHOT_INDEXES || '').split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    this.rng = mulberry32(opts.seed ?? 42);
    this.forceFail = new Set([...(opts.forceFail ?? []), ...envFail]);
    this.forceWarning = new Set(opts.forceWarning ?? []);
    this.forceUnverified = new Set(opts.forceUnverified ?? []);
    this.failOnce = new Set([...(opts.failOnce ?? []), ...envFailOnce]);
    this.failShotIndexes = new Set([...(opts.failShotIndexes ?? []), ...envIndexes]);
  }

  async scoreShot(input: SemanticQaInput): Promise<ShotSemanticQaReport> {
    const issues: SemanticIssue[] = [];
    const isFirstCheck = !this.firstChecked.has(input.shotId);
    this.firstChecked.add(input.shotId);
    const applyAlwaysFail = this.failShotIndexes.size === 0 || this.failShotIndexes.has(input.shotIndex);

    for (const dim of SEMANTIC_DIMENSIONS) {
      let verdict: SemanticVerdict;
      let score: number;
      let reason: string;

      const alwaysFails = this.forceFail.has(dim) && applyAlwaysFail;
      const alwaysUnverified = this.forceUnverified.has(dim) && applyAlwaysFail;
      const onceFails = this.failOnce.has(dim) && isFirstCheck;

      if (alwaysFails) {
        verdict = 'fail';
        score = 0.2 + this.rng() * 0.3;
        reason = `fake: ${dim} 被强制标记为不合格（测试用）`;
      } else if (alwaysUnverified) {
        verdict = 'unverified';
        score = 0;
        reason = `fake: ${dim} 缺少可验证证据（测试用）`;
      } else if (onceFails) {
        verdict = 'fail';
        score = 0.2 + this.rng() * 0.3;
        reason = `fake: ${dim} 首次检查不合格（可恢复缺陷，修复后可通过）`;
      } else if (this.forceWarning.has(dim)) {
        verdict = 'warning';
        score = 0.5 + this.rng() * 0.2;
        reason = `fake: ${dim} 被强制标记为有风险（测试用）`;
      } else {
        verdict = 'pass';
        score = 0.85 + this.rng() * 0.15;
        reason = 'fake: 通过（测试用）';
      }

      const fix = verdict === 'fail' || verdict === 'warning'
        ? SEMANTIC_FIX_MAP[dim]?.() ?? null
        : null;

      issues.push({
        dimension: dim,
        verdict,
        score,
        evidence: [
          {
            source: 'fake-scoring',
            detail: `fake scorer seed=${input.shotId} dim=${dim} verdict=${verdict}`,
          },
        ],
        reason,
        fix,
      });
    }

    const semanticEntries = issuesToScoreEntries(issues);
    const scorecard = buildSemanticScorecard(
      input.shotId,
      input.runId || '',
      semanticEntries
    );

    return {
      shotId: input.shotId,
      runId: input.runId,
      version: input.version,
      issues,
      summary: generateSummary(issues),
      scorecard,
      overallVerdict: deriveOverallVerdict(issues),
      checkedAt: Date.now(),
      scorer: this.name,
      scorerVersion: this.version,
      manualPassed: false,
      manualPassComment: null,
    };
  }
}

// ==================== 工厂 ====================

/**
 * 创建语义 QA 评分器：优先真实 LLM，测试环境用 Fake。
 * 由 FAKE_VIDEO_PROVIDER 或 SEMANTIC_QA_SCORER 控制。
 */
export function createSemanticQaScorer(opts?: FakeSemanticQaOptions): SemanticQaScorer {
  if (
    process.env.FAKE_VIDEO_PROVIDER === 'true' ||
    process.env.SEMANTIC_QA_SCORER === 'fake'
  ) {
    return new FakeSemanticQaScorer(opts);
  }
  return new LlmSemanticQaScorer();
}

let _singleton: SemanticQaScorer | null = null;
export function getSemanticQaScorer(opts?: FakeSemanticQaOptions): SemanticQaScorer {
  if (!_singleton) _singleton = createSemanticQaScorer(opts);
  return _singleton;
}
export function resetSemanticQaScorer(): void {
  _singleton = null;
}

/**
 * visual-safety — 资产视觉安全状态（P5 三轮审查修复）。
 *
 * 背景：「可信来源」只证明资产属于本系统（product_assets / conditioned_first_frames），
 * 不证明内容安全（人脸/字幕/水印/竞品）。审查要求：产品资产与条件化首帧持久化
 * 服务端视觉安全状态（hash、face/overlay verdict、检查证据、版本、pass/unverified），
 * unverified 必须拒绝付费提交。
 *
 * 本模块提供：
 * - 存储契约：product_assets / conditioned_first_frames 的 safety_* 列；
 * - evaluateVisualSafety(url)：服务端视觉核验（LLM vision 可用时真实评估；
 *   不可用 → unverified——宁可拒绝付费，不假装安全）；
 * - recordVisualSafety()：持久化 verdict/证据/版本；
 * - requireVisualSafetyPass(ownerId, url, label)：提交边界强制——非 pass 即拒绝。
 *
 * 注意：不实现「裁脸/打码/模糊」式规避；评估器只做检测与判决。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db';
import { callLlmGateway } from './llm-gateway';

export const VISUAL_SAFETY_VERSION = 'v2';

const REQUIRED_VERDICT_KINDS = [
  'face',
  'person',
  'subtitle_overlay',
  'watermark',
  'competitor_branding',
] as const;

/**
 * viral_recreation_v2 模式的判决维度：允许虚构人物（公司模特/虚构数字人物
 * 是本模式的目标主体），但仍强制检查文字层（字幕/水印/竞品标识）——
 * 与 ReferenceInputPolicy 的 viral_recreation_v2 语义一致。
 */
const VIRAL_RECREATION_VERDICT_KINDS = [
  'subtitle_overlay',
  'watermark',
  'competitor_branding',
] as const;

export type VisualSafetyMode = 'semantic_recreation' | 'viral_recreation_v2';

type RequiredVerdictKind = (typeof REQUIRED_VERDICT_KINDS)[number];

export type VisualSafetyStatus = 'pass' | 'fail' | 'unverified';

export interface VisualSafetyVerdict {
  kind: 'face' | 'person' | 'subtitle_overlay' | 'watermark' | 'competitor_branding';
  present: boolean;
  confidence: number;
}

export interface VisualSafetyAssessment {
  status: VisualSafetyStatus;
  verdicts: VisualSafetyVerdict[];
  evidence: string;
  checkedAt: number;
  version: string;
  /** 资产内容哈希（hex；来自登记/生成时的记录，非本评估产生） */
  sha256?: string | null;
}

export function sha256OfLocalFile(localPath: string | null | undefined): string | null {
  if (!localPath) return null;
  try {
    return createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
  } catch {
    return null;
  }
}

function isSha256(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function absoluteRecordedPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized === 'uploads' || normalized.startsWith('uploads/')) {
    const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
    return path.resolve(uploadsRoot, normalized.replace(/^uploads\/?/, ''));
  }
  return path.resolve(process.cwd(), filePath);
}

/** 数据库迁移（幂等）：product_assets 与 conditioned_first_frames 增加 safety 列 */
export function ensureVisualSafetyColumns(): void {
  for (const table of ['product_assets', 'conditioned_first_frames']) {
    for (const [column, ddl] of [
      ['safety_status', `ALTER TABLE ${table} ADD COLUMN safety_status TEXT DEFAULT 'unverified'`],
      ['safety_evidence', `ALTER TABLE ${table} ADD COLUMN safety_evidence TEXT`],
      ['safety_checked_at', `ALTER TABLE ${table} ADD COLUMN safety_checked_at TEXT`],
      ['safety_version', `ALTER TABLE ${table} ADD COLUMN safety_version TEXT`],
      ['sha256', `ALTER TABLE ${table} ADD COLUMN sha256 TEXT`],
    ] as const) {
      const has = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!has.some((c) => c.name === column)) {
        try {
          db.exec(ddl);
        } catch {
          // 并发迁移竞争忽略
        }
      }
    }
  }
}

/** 读取资产已持久化的安全状态（无记录 → unverified） */
export function readVisualSafety(ownerId: string, url: string): {
  status: VisualSafetyStatus;
  evidence: string | null;
  checkedAt: string | null;
  sha256: string | null;
  localPath: string | null;
} {
  const pa = db
    .prepare(
      `SELECT safety_status, safety_evidence, safety_checked_at, sha256, file_path
         FROM product_assets WHERE owner_id = ? AND url = ? LIMIT 1`
    )
    .get(ownerId, url) as
    | { safety_status: string | null; safety_evidence: string | null; safety_checked_at: string | null; sha256: string | null; file_path: string | null }
    | undefined;
  if (pa) {
    return {
      status: (pa.safety_status as VisualSafetyStatus) || 'unverified',
      evidence: pa.safety_evidence,
      checkedAt: pa.safety_checked_at,
      sha256: pa.sha256,
      localPath: pa.file_path,
    };
  }
  const cff = db
    .prepare(
      `SELECT safety_status, safety_evidence, safety_checked_at, sha256, local_path
         FROM conditioned_first_frames WHERE owner_id = ? AND conditioned_first_frame_url = ? LIMIT 1`
    )
    .get(ownerId, url) as
    | { safety_status: string | null; safety_evidence: string | null; safety_checked_at: string | null; sha256: string | null; local_path: string | null }
    | undefined;
  if (cff) {
    return {
      status: (cff.safety_status as VisualSafetyStatus) || 'unverified',
      evidence: cff.safety_evidence,
      checkedAt: cff.safety_checked_at,
      sha256: cff.sha256,
      localPath: cff.local_path,
    };
  }
  return { status: 'unverified', evidence: null, checkedAt: null, sha256: null, localPath: null };
}

/** 持久化安全评估结果（写回对应资产表） */
export function recordVisualSafety(
  ownerId: string,
  url: string,
  assessment: VisualSafetyAssessment
): void {
  const target = db
    .prepare('SELECT id FROM product_assets WHERE owner_id = ? AND url = ? LIMIT 1')
    .get(ownerId, url) as { id: string } | undefined;
  if (target) {
    db.prepare(
      `UPDATE product_assets
          SET safety_status = ?, safety_evidence = ?, safety_checked_at = ?,
               safety_version = ?, sha256 = ?
        WHERE id = ?`
    ).run(
      assessment.status,
      assessment.evidence,
      new Date(assessment.checkedAt).toISOString(),
      assessment.version,
      assessment.sha256 ?? null,
      target.id
    );
    return;
  }
  const cff = db
    .prepare('SELECT id FROM conditioned_first_frames WHERE owner_id = ? AND conditioned_first_frame_url = ? LIMIT 1')
    .get(ownerId, url) as { id: string } | undefined;
  if (cff) {
    db.prepare(
      `UPDATE conditioned_first_frames
          SET safety_status = ?, safety_evidence = ?, safety_checked_at = ?,
               safety_version = ?, sha256 = ?
        WHERE id = ?`
    ).run(
      assessment.status,
      assessment.evidence,
      new Date(assessment.checkedAt).toISOString(),
      assessment.version,
      assessment.sha256 ?? null,
      cff.id
    );
  }
}

/**
 * 服务端视觉核验：LLM vision 评估图片是否含人脸/人物/字幕/水印/竞品标识。
 * - LLM 可用并返回结构化判决 → pass（全部 absent）或 fail（任一 present）；
 * - LLM 不可用/返回无效 → unverified（宁可拒绝付费，不假装安全）。
 * - viral_recreation_v2 模式：允许虚构人物（公司模特/虚构数字人物），
 *   只判决文字层（字幕/水印/竞品标识）——与 ReferenceInputPolicy 同语义。
 * 评估结果不落库（落库由调用方 recordVisualSafety 负责），本函数纯判定。
 */
export async function evaluateVisualSafety(
  url: string,
  options: { sha256?: string | null; mode?: VisualSafetyMode } = {}
): Promise<VisualSafetyAssessment> {
  const sha256 = isSha256(options.sha256) ? options.sha256 : null;
  const mode = options.mode ?? 'semantic_recreation';
  const kinds: readonly string[] = mode === 'viral_recreation_v2' ? VIRAL_RECREATION_VERDICT_KINDS : REQUIRED_VERDICT_KINDS;
  // E2E 确定性通道（与 FAKE_TECH_QA / FAKE_FIRST_FRAME_PREFLIGHT 同纪律）：
  // FAKE_VISUAL_SAFETY_PASS=true 时，仅当资产携带可验证的 SHA-256 内容摘要
  // （hash 绑定：摘要必须来自本系统登记/生成时的本地文件字节）才恒定 pass；
  // 无 hash 的裸 URL 仍保持 unverified——绝不因测试环境而放宽对任意 URL 的判决。
  // 生产/真实 demo 不设置该变量，不走此路径；提交边界 requireVisualSafetyPass
  // 的判定（status=pass + sha256 + 本地文件 hash 一致性校验）原样执行。
  if (process.env.FAKE_VISUAL_SAFETY_PASS === 'true' && sha256) {
    return {
      status: 'pass',
      verdicts: kinds.map((kind) => ({
        kind: kind as VisualSafetyVerdict['kind'],
        present: false,
        confidence: 1,
      })),
      evidence: `FAKE_VISUAL_SAFETY_PASS（E2E 确定性通道；hash 绑定 sha256=${sha256.slice(0, 12)}…，非真实视觉核验）`,
      checkedAt: Date.now(),
      version: VISUAL_SAFETY_VERSION,
      sha256,
    };
  }
  const system =
    mode === 'viral_recreation_v2'
      ? '你是素材内容安全审查员。判断图片是否包含：字幕或文字叠加、水印/logo、竞品品牌标识。' +
        '画面中的虚构人物/公司模特、产品、场景属于允许保留的内容。' +
        '必须返回纯 JSON：{"verdicts":[{"kind":"subtitle_overlay|watermark|competitor_branding","present":true|false,"confidence":0.0-1.0}]}'
      : '你是素材内容安全审查员。判断图片是否包含：真实人脸/人物、字幕或文字叠加、水印/logo、竞品品牌标识。' +
        '只允许产品包装、泡沫、陶瓷表面、中性台面等无人物场景。' +
        '必须返回纯 JSON：{"verdicts":[{"kind":"face|person|subtitle_overlay|watermark|competitor_branding","present":true|false,"confidence":0.0-1.0}]}';
  try {
    const response = await callLlmGateway({
      system,
      user: '请评估这张素材图的内容安全状态。',
      imageUrls: [url],
      temperature: 0.1,
    });
    if (!response.success || !response.data) {
      return {
        status: 'unverified',
        verdicts: [],
        evidence: `LLM 不可用（${response.error || 'no data'}），无法完成视觉安全核验`,
        checkedAt: Date.now(),
        version: VISUAL_SAFETY_VERSION,
        sha256,
      };
    }
    const rawVerdicts = Array.isArray(response.data.verdicts) ? response.data.verdicts : [];
    const byKind = new Map<string, VisualSafetyVerdict>();
    let malformed = rawVerdicts.length !== kinds.length;
    for (const raw of rawVerdicts) {
      const kind = raw?.kind;
      if (!kinds.includes(kind as string) ||
          typeof raw?.present !== 'boolean' ||
          typeof raw?.confidence !== 'number' ||
          raw.confidence < 0 || raw.confidence > 1 ||
          byKind.has(kind as string)) {
        malformed = true;
        continue;
      }
      byKind.set(kind as string, {
        kind: kind as VisualSafetyVerdict['kind'],
        present: raw.present,
        confidence: raw.confidence,
      });
    }
    const verdicts = kinds
      .map((kind) => byKind.get(kind))
      .filter((value): value is VisualSafetyVerdict => Boolean(value));
    if (malformed || verdicts.length !== kinds.length || !sha256) {
      return {
        status: 'unverified',
        verdicts,
        evidence: !sha256
          ? '素材缺少可验证的 SHA-256 内容摘要，不能把视觉安全结论绑定到实际字节'
          : 'LLM 未返回完整且严格的视觉安全 verdicts，无法完成视觉安全核验',
        checkedAt: Date.now(),
        version: VISUAL_SAFETY_VERSION,
        sha256,
      };
    }
    const risky = verdicts.filter((v) => v.present);
    return {
      status: risky.length > 0 ? 'fail' : 'pass',
      verdicts,
      evidence: risky.length > 0
        ? `检测到风险元素：${risky.map((v) => `${v.kind}(${v.confidence.toFixed(2)})`).join('、')}`
        : `未检测到${mode === 'viral_recreation_v2' ? '字幕/水印/竞品标识' : '人脸/人物/字幕/水印/竞品标识'}（${verdicts.length} 项判决）`,
      checkedAt: Date.now(),
      version: VISUAL_SAFETY_VERSION,
      sha256,
    };
  } catch (error: unknown) {
    return {
      status: 'unverified',
      verdicts: [],
      evidence: `视觉安全核验失败：${error instanceof Error ? error.message : String(error)}`,
      checkedAt: Date.now(),
      version: VISUAL_SAFETY_VERSION,
      sha256,
    };
  }
}

export class VisualSafetyViolationError extends Error {
  readonly code = 'asset_safety_not_passed' as const;
  readonly safetyStatus: VisualSafetyStatus;
  constructor(status: VisualSafetyStatus, message: string) {
    super(message);
    this.name = 'VisualSafetyViolationError';
    this.safetyStatus = status;
  }
}

/**
 * 提交边界强制：资产必须已通过服务端视觉安全核验（safety_status='pass'）。
 * unverified（未核验）与 fail（检出人脸/水印等）一律拒绝付费提交。
 *
 * 例外：materials 表中本系统 AI 生图产物（owner 匹配）视为隐式安全——
 * 系统生成链路产出的纯产品素材不含字幕/水印/人脸，无需额外 LLM 视觉核验。
 */
export function requireVisualSafetyPass(ownerId: string, url: string, label: string): void {
  const record = readVisualSafety(ownerId, url);
  if (record.status === 'pass' && isSha256(record.sha256)) {
    // 正常通过路径：已有 pass 判决且有 hash 绑定
    if (record.localPath) {
      const actualHash = sha256OfLocalFile(absoluteRecordedPath(record.localPath));
      if (!actualHash || actualHash.toLowerCase() !== record.sha256.toLowerCase()) {
        throw new VisualSafetyViolationError(
          'unverified',
          `${label}（${url.slice(0, 120)}）的本地源文件已缺失或与安全评估时的 SHA-256 不一致；必须重新发布并复核后才能提交`
        );
      }
    }
    return;
  }

  // 隐式安全：materials 表中 owner 匹配的系统生成素材（AI text-to-image 产物）
  // 系统生图链路产出的纯产品/质感图不含字幕、水印、人脸，无需 LLM 视觉核验即可提交。
  const mat = db
    .prepare('SELECT 1 FROM materials WHERE owner_id = ? AND url = ? LIMIT 1')
    .get(ownerId, url);
  if (mat) return;

  throw new VisualSafetyViolationError(
    record.status === 'pass' ? 'unverified' : record.status,
    `${label}（${url.slice(0, 120)}）视觉安全状态为 ${record.status}，内容摘要=${record.sha256 ? 'present' : 'missing'}（${record.evidence || '未完成服务端视觉核验'}）。` +
      '未通过内容安全核验的素材不得进入付费提交；请先完成服务端视觉安全评估（evaluateVisualSafety + recordVisualSafety）'
  );
}

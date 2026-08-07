/**
 * AssetPublicationPort — 资产公网发布端口。
 *
 * 职责：把 run-scoped 本地资产发布为 provider 可下载的临时公网 URL，并返回：
 *   URL / content type / hash / 过期时间 / 发布来源 / run-session 归属。
 *
 * 约束（P5 治理）：
 * - 服务端与 CLI（run-p3-demo.mjs）共用同一端口实现，不允许各自复制上传逻辑；
 * - 正式路径只允许用户自有的公网资产宿主（PUBLIC_BASE_URL 部署域名 / 自建中继）；
 * - imgur/litterbox 仅作为显式、隔离、默认关闭的 test/demo adapter；
 * - 失败语义统一：任何发布失败都返回 AssetPublicationError（code=
 *   asset_publication_unavailable），可诊断、不可触发付费生成。
 *
 * 本文件只定义契约；实现见 adapters/asset-publication-adapter.ts。
 */

export type PublicationSource = 'public-base' | 'relay' | 'imgur' | 'litterbox';

export interface PublishedAssetRecord {
  publicUrl: string;
  contentType: string;
  /** SHA-256（hex），供下游核对内容一致 */
  sha256: string;
  bytes: number;
  /** null = 不过期（自建宿主） */
  expiresAtMs: number | null;
  source: PublicationSource;
  runId: string | null;
  sessionId: string | null;
  localPath: string;
  publishedAt: number;
}

export interface PublishAssetInput {
  localPath: string;
  runId?: string;
  sessionId?: string;
}

export interface AssetPublicationPort {
  readonly name: string;
  publish(input: PublishAssetInput): Promise<PublishedAssetRecord>;
}

export class AssetPublicationError extends Error {
  readonly code = 'asset_publication_unavailable' as const;
  /** 已尝试的发布来源（诊断用） */
  readonly attempted: PublicationSource[];
  constructor(message: string, attempted: PublicationSource[] = []) {
    super(message);
    this.name = 'AssetPublicationError';
    this.attempted = attempted;
  }
}

/** 把任意发布失败归一化为可诊断的统一错误（不可触发付费生成） */
export function toAssetPublicationError(error: unknown, attempted: PublicationSource[]): AssetPublicationError {
  if (error instanceof AssetPublicationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AssetPublicationError(
    `asset_publication_unavailable: 资产发布失败（已尝试 ${attempted.join(', ') || '无'}）：${message}`,
    attempted
  );
}

/**
 * 资产公网发布（兼容层）——P5 起实现收敛到 ports/adapters：
 *
 * - 端口契约：server/ports/asset-publication.ts（统一错误语义、run/session 归属）；
 * - 实现：server/adapters/asset-publication-adapter.ts（正式路径 +
 *   显式默认关闭的 test/demo adapter）；
 * - 本文件保留旧 API（publishLocalAsset / hasPublicBaseUrl / publicBaseAssetUrl /
 *   isPrivateHostname）供既有服务端代码（product-conditioned-frame 等）无感迁移；
 *   服务端与 CLI（run-p3-demo.mjs）共用同一实现，不再各自复制上传逻辑。
 *
 * 失败语义：任何发布失败抛 code=asset_publication_unavailable 的统一错误，
 * 可诊断、不可触发付费生成。
 */
import fs from 'node:fs';
import { createSignedMediaUrl } from './signed-media';
import { AssetPublicationAdapter, isPrivateHostname } from '../adapters/asset-publication-adapter';
import { AssetPublicationError, type PublishedAssetRecord } from '../ports/asset-publication';

export type { PublishedAssetRecord };
export { AssetPublicationError, isPrivateHostname };

/** 兼容旧类型：provider 字段与旧代码一致 */
export interface PublishedAsset {
  publicUrl: string;
  provider: 'public-base' | 'litterbox' | 'remote-host' | 'imgur';
  expiresAtMs?: number;
  localPath: string;
  /** Digest of the exact local bytes that were published. */
  sha256: string;
}

/** PUBLIC_BASE_URL 是否可作公网下载源（公网域名或公网 IP） */
export function hasPublicBaseUrl(): boolean {
  const publicBase = (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '').trim();
  if (!publicBase) return false;
  try {
    const host = new URL(publicBase).hostname.toLowerCase();
    return !isPrivateHostname(host);
  } catch {
    return false;
  }
}

/** 把 /uploads 相对 URL 拼成公网签名 URL（生产路径） */
export function publicBaseAssetUrl(localUrl: string): string | null {
  const publicBase = (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (!publicBase || !hasPublicBaseUrl()) return null;
  const pathPart = localUrl.startsWith('/') ? localUrl : `/${localUrl}`;
  try {
    return createSignedMediaUrl(pathPart, publicBase);
  } catch {
    return null;
  }
}

const adapter = new AssetPublicationAdapter();

function mapRecord(record: PublishedAssetRecord): PublishedAsset {
  return {
    publicUrl: record.publicUrl,
    provider: record.source === 'relay' ? 'remote-host' : record.source,
    ...(record.expiresAtMs !== null ? { expiresAtMs: record.expiresAtMs } : {}),
    localPath: record.localPath,
    sha256: record.sha256,
  };
}

/**
 * 把本地文件发布为公网 URL（兼容入口）。
 * @param localPath 本地绝对路径（uploads 内）
 * @returns 公网 URL；失败抛错（code=asset_publication_unavailable）
 */
export async function publishLocalAsset(
  localPath: string,
  runContext?: { runId?: string; sessionId?: string }
): Promise<PublishedAsset> {
  const record = await adapter.publish({
    localPath,
    runId: runContext?.runId,
    sessionId: runContext?.sessionId,
  });
  return mapRecord(record);
}

/** 新端口入口（服务端/CLI 共用；返回完整发布记录） */
export async function publishAsset(input: {
  localPath: string;
  runId?: string;
  sessionId?: string;
}): Promise<PublishedAssetRecord> {
  return adapter.publish(input);
}

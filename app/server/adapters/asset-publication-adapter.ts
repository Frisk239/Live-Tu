/**
 * AssetPublicationAdapter — AssetPublicationPort 的实现（正式路径 + 显式 demo adapter）。
 *
 * 发布顺序（只走正式路径，第三方图床不参与自动回退）：
 *   1. relay：自建公网上传中继（DEMO_PUBLIC_UPLOAD_URL，用户自有宿主，弃用命名兼容）；
 *   2. public-base：PUBLIC_BASE_URL 公网域名/公网 IP → 应用自身 /uploads 签名 URL；
 *   3. imgur / litterbox：仅当 DEMO_ASSET_PUBLISHER 显式等于 imgur / litterbox 时启用
 *      （test/demo adapter，默认关闭；'auto' 已弃用，不再隐含第三方回退）。
 * 全部失败 → 抛 AssetPublicationError（asset_publication_unavailable），
 * 由调用方（首帧预检）拒绝发起付费视频生成。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSignedMediaUrl } from '../lib/signed-media';
import { loadAssetPublicationConfig } from '../config/env-config';
import {
  type AssetPublicationPort,
  type PublishedAssetRecord,
  type PublicationSource,
  AssetPublicationError,
} from '../ports/asset-publication';

/** 私网/本机 hostname 判定（部署域名必须是公网地址） */
export function isPrivateHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host === '::1'
  );
}

function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'png') return 'image/png';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'm4a') return 'audio/mp4';
  return 'application/octet-stream';
}

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export class AssetPublicationAdapter implements AssetPublicationPort {
  readonly name = 'asset-publication';

  constructor(
    private readonly env: Record<string, string | undefined> = process.env as Record<
      string,
      string | undefined
    >
  ) {}

  async publish(input: {
    localPath: string;
    runId?: string;
    sessionId?: string;
  }): Promise<PublishedAssetRecord> {
    const localPath = input.localPath;
    if (!localPath || !fs.existsSync(localPath)) {
      throw new AssetPublicationError(
        `asset_publication_unavailable: 本地资产不存在: ${localPath}`,
        []
      );
    }
    const buffer = fs.readFileSync(localPath);
    const contentType = mimeOf(localPath);
    const sha256 = sha256Of(buffer);
    const cfg = loadAssetPublicationConfig(this.env);
    const attempted: PublicationSource[] = [];

    // 0) 正式路径：自建中继（用户自有宿主；弃用命名，语义不变）
    if (cfg.relayUrl) {
      const url = await uploadToRelay(buffer, localPath, cfg.relayUrl, cfg.relayToken || '');
      attempted.push('relay');
      if (url) {
        return {
          publicUrl: url,
          contentType,
          sha256,
          bytes: buffer.length,
          expiresAtMs: null,
          source: 'relay',
          runId: input.runId ?? null,
          sessionId: input.sessionId ?? null,
          localPath,
          publishedAt: Date.now(),
        };
      }
    }

    // 1) 正式路径：部署域名（PUBLIC_BASE_URL 公网可达）
    if (cfg.publicBaseUrl) {
      const host = publicBaseHost(cfg.publicBaseUrl);
      if (host && !isPrivateHostname(host)) {
        attempted.push('public-base');
        const uploadsRoot = path.resolve(cfg.uploadsDir);
        const rel = path.relative(uploadsRoot, localPath).split(path.sep).join('/');
        const localUrl = `/uploads/${rel}`;
        const url = createSignedMediaUrl(localUrl, cfg.publicBaseUrl.replace(/\/$/, ''));
        if (url) {
          return {
            publicUrl: url,
            contentType,
            sha256,
            bytes: buffer.length,
            expiresAtMs: null,
            source: 'public-base',
            runId: input.runId ?? null,
            sessionId: input.sessionId ?? null,
            localPath,
            publishedAt: Date.now(),
          };
        }
      }
    }

    // 2) test/demo adapter：仅显式开启（默认关闭；'auto' 不再自动回退）
    if (cfg.demoPublisher === 'imgur') {
      attempted.push('imgur');
      const url = await uploadToImgur(buffer, localPath);
      if (url) {
        return {
          publicUrl: url,
          contentType,
          sha256,
          bytes: buffer.length,
          expiresAtMs: null,
          source: 'imgur',
          runId: input.runId ?? null,
          sessionId: input.sessionId ?? null,
          localPath,
          publishedAt: Date.now(),
        };
      }
    } else if (cfg.demoPublisher === 'litterbox') {
      attempted.push('litterbox');
      const url = await uploadToLitterbox(buffer, localPath);
      if (url) {
        return {
          publicUrl: url,
          contentType,
          sha256,
          bytes: buffer.length,
          expiresAtMs: Date.now() + 72 * 3600 * 1000,
          source: 'litterbox',
          runId: input.runId ?? null,
          sessionId: input.sessionId ?? null,
          localPath,
          publishedAt: Date.now(),
        };
      }
    }

    throw new AssetPublicationError(buildFailureMessage(cfg, attempted), attempted);
  }
}

function publicBaseHost(publicBaseUrl: string): string | null {
  try {
    return new URL(publicBaseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function buildFailureMessage(
  cfg: ReturnType<typeof loadAssetPublicationConfig>,
  attempted: PublicationSource[]
): string {
  const demoHint =
    cfg.demoPublisher === 'off'
      ? '（test/demo 通道未启用：如需 imgur/litterbox 调试能力请显式设置 DEMO_ASSET_PUBLISHER=imgur 或 litterbox）'
      : '';
  return (
    'asset_publication_unavailable: 资产无法转换为 provider 可下载的公网 URL。' +
    `已尝试：${attempted.join(', ') || '无'}。` +
    `PUBLIC_BASE_URL=${cfg.publicBaseUrl ? '已配置' : '未配置'}` +
    `${cfg.relayUrl ? '；自建中继已配置' : ''}${demoHint}。` +
    'Seedance 中转无法下载本机文件；请在部署环境配置公网 PUBLIC_BASE_URL（或自建中继），' +
    '或显式开启 test/demo 发布通道。'
  );
}

// ==================== 上传实现（仅本 adapter 持有，CLI 与服务端共用） ====================

async function uploadToRelay(
  buffer: Buffer,
  localPath: string,
  relayUrl: string,
  token: string
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buffer], { type: mimeOf(localPath) }), path.basename(localPath));
      const res = await fetch(relayUrl, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const url = json?.url || (res.ok && text.trim().startsWith('http') ? text.trim() : null);
      if (res.ok && url) return String(url);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  return null;
}

async function uploadToImgur(buffer: Buffer, localPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = new FormData();
      fd.append('image', new Blob([buffer], { type: mimeOf(localPath) }));
      const res = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: { Authorization: 'Client-ID 546c25a59c58ad7' },
        body: fd,
        signal: AbortSignal.timeout(90_000),
      });
      const json = await res.json().catch(() => null);
      const link = json?.data?.link;
      if (res.ok && typeof link === 'string' && link.startsWith('http')) return link;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  return null;
}

async function uploadToLitterbox(buffer: Buffer, localPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = new FormData();
      fd.append('reqtype', 'fileupload');
      fd.append('time', '72h');
      fd.append('fileToUpload', new Blob([buffer], { type: mimeOf(localPath) }), path.basename(localPath));
      const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(90_000),
      });
      const text = (await res.text()).trim();
      if (res.ok && text.startsWith('https://')) return text;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  return null;
}

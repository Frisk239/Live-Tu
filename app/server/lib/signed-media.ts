import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';

const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));

/**
 * S2.2：签名密钥全环境强制校验，无硬编码默认值。
 * - 配置了 MEDIA_URL_SIGNING_SECRET：所有环境必须 ≥32 字符，否则启动即失败；
 * - production：必须配置（缺失启动失败）；
 * - 非 production：缺失时使用进程级随机临时密钥（每次启动不同），
 *   杜绝旧版固定开发密钥可被伪造签名 URL 的问题。
 */
let ephemeralSecret: string | null = null;

function signingSecret(): string {
  const configured = process.env.MEDIA_URL_SIGNING_SECRET || '';
  if (configured) {
    if (configured.length < 32) {
      throw new Error('MEDIA_URL_SIGNING_SECRET 至少需要 32 个字符');
    }
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 MEDIA_URL_SIGNING_SECRET（至少 32 个字符随机值）');
  }
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString('base64url');
  }
  return ephemeralSecret;
}

function signatureFor(mediaPath: string, expires: number): string {
  return createHmac('sha256', signingSecret())
    .update(`${mediaPath}\n${expires}`)
    .digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function resolveUploadPath(mediaPath: string): string | null {
  if (!mediaPath.startsWith('/uploads/')) return null;
  const relativePath = mediaPath.slice('/uploads/'.length);
  const resolved = path.resolve(uploadsRoot, relativePath);
  if (resolved === uploadsRoot || !resolved.startsWith(`${uploadsRoot}${path.sep}`)) return null;
  return resolved;
}

export function initializeMediaSigning() {
  signingSecret();
}

/**
 * S1.4：签名 URL TTL 内缓存。
 * 同一素材在缓存窗口内返回相同签名 URL，避免长任务轮询期反复重签；
 * 且缓存命中时 URL 至少还有 5 分钟余量（提前失效重签），防止中转延迟拉图时签名过期。
 */
const signedUrlCache = new Map<string, { url: string; expiresAtSec: number }>();

export function createSignedMediaUrl(
  mediaPath: string,
  publicBaseUrl: string,
  ttlSeconds = Number(process.env.MEDIA_URL_TTL_SECONDS || 60 * 60)
): string {
  if (!resolveUploadPath(mediaPath)) throw new Error('只能签名 /uploads/ 下的媒体');
  const ttl = Math.max(60, Math.min(ttlSeconds, 24 * 60 * 60));
  const nowSec = Math.floor(Date.now() / 1000);
  const cacheKey = `${publicBaseUrl.replace(/\/$/, '')}|${mediaPath}|${ttl}`;
  const cached = signedUrlCache.get(cacheKey);
  if (cached && cached.expiresAtSec - 300 > nowSec) {
    return cached.url;
  }

  const expires = nowSec + ttl;
  const params = new URLSearchParams({
    path: mediaPath,
    expires: String(expires),
    signature: signatureFor(mediaPath, expires),
  });
  const url = `${publicBaseUrl.replace(/\/$/, '')}/provider-media?${params.toString()}`;
  signedUrlCache.set(cacheKey, { url, expiresAtSec: expires });

  // 防缓存无限增长：清掉已过期条目
  if (signedUrlCache.size > 500) {
    for (const [key, entry] of signedUrlCache) {
      if (entry.expiresAtSec <= nowSec) signedUrlCache.delete(key);
    }
  }
  return url;
}

export const signedMediaRouter = Router();
signedMediaRouter.get('/', (req, res) => {
  const mediaPath = String(req.query.path || '');
  const expires = Number(req.query.expires || 0);
  const providedSignature = String(req.query.signature || '');
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(expires) ||
    expires <= now ||
    expires > now + 24 * 60 * 60 ||
    !providedSignature ||
    !safeEqual(providedSignature, signatureFor(mediaPath, expires))
  ) {
    return res.status(403).json({ success: false, error: '媒体签名无效或已过期' });
  }

  const absolutePath = resolveUploadPath(mediaPath);
  if (!absolutePath || !fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    return res.status(404).json({ success: false, error: '媒体文件不存在' });
  }
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(absolutePath);
});

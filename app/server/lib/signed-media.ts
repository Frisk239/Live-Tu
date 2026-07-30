import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';

const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));

function signingSecret(): string {
  const configured = process.env.MEDIA_URL_SIGNING_SECRET || '';
  if (process.env.NODE_ENV === 'production' && configured.length < 32) {
    throw new Error('生产环境 MEDIA_URL_SIGNING_SECRET 至少需要 32 个字符');
  }
  return configured || 'live-tu-development-media-signing-secret';
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

export function createSignedMediaUrl(
  mediaPath: string,
  publicBaseUrl: string,
  ttlSeconds = Number(process.env.MEDIA_URL_TTL_SECONDS || 60 * 60)
): string {
  if (!resolveUploadPath(mediaPath)) throw new Error('只能签名 /uploads/ 下的媒体');
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, Math.min(ttlSeconds, 24 * 60 * 60));
  const params = new URLSearchParams({
    path: mediaPath,
    expires: String(expires),
    signature: signatureFor(mediaPath, expires),
  });
  return `${publicBaseUrl.replace(/\/$/, '')}/provider-media?${params.toString()}`;
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

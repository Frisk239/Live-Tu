/**
 * S0 可信 CI 测试共享辅助：
 * - authStub：路由测试的认证桩（模拟已登录管理员，拥有全部权限）；
 * - 能力探测：无 API Key / 无 FFmpeg 时，网络依赖的 legacy 测试应干净跳过而不是报错。
 */
import type { NextFunction, Request, Response } from 'express';
import { spawnSync } from 'node:child_process';
import { PERMISSION_KEYS } from '../lib/permission-catalog';
import { db } from '../lib/db';

export const TEST_SAFETY_SHA256 = 'a'.repeat(64);

/**
 * 测试用认证桩：模拟已登录管理员（拥有全部权限）。
 * 惰性注册 'test-admin' 用户行 —— 业务表 owner_id 外键引用 users(id)，
 * 不注册会在 INSERT 时触发 FOREIGN KEY constraint failed。
 */
export function authStub(req: Request, _res: Response, next: NextFunction) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role, enabled)
       VALUES ('test-admin', 'test-admin', 'not-used', 'admin', 1)`
    ).run();
  } catch {
    // 数据库尚未初始化时忽略；路由本身也会在需要时初始化
  }
  (req as any).authUser = {
    id: 'test-admin',
    username: 'test-admin',
    role: 'admin',
    permissions: [...PERMISSION_KEYS],
  };
  next();
}

/** 是否配置了云雾/网关 Key（llm-gateway 与画图网关共用） */
export function hasGatewayKey(): boolean {
  const key = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';
  return Boolean(key && key !== 'MY_GEMINI_API_KEY' && !key.startsWith('your_'));
}

/**
 * P5 三轮：测试 seam 登记「已通过服务端视觉安全核验」的派生首帧。
 * 提交边界 requireVisualSafetyPass 要求资产 safety_status='pass'——
 * 本函数模拟真实流程中 createProductConditionedFirstFrame 生成后的服务端评估结果。
 */
export function registerSafetyPassedFirstFrame(ownerId: string, url: string): void {
  if (!url || !ownerId) return;
  db.prepare(
    `INSERT OR IGNORE INTO conditioned_first_frames
       (id, owner_id, conditioned_first_frame_url, product_asset_urls_json, provider, model,
         prompt_version, prompt, safety_status, safety_evidence, safety_version, sha256)
      VALUES (?, ?, ?, '[]', 'test', 'test', 'v1', 'x', 'pass', '{"face":false,"overlay":false,"watermark":false}', 'v2', ?)`
  ).run(`cff-safety-${ownerId}-${url}`, ownerId, url, TEST_SAFETY_SHA256);
}

/** P5 三轮：测试 seam 登记「已通过服务端视觉安全核验」的产品资产 */
export function registerSafetyPassedProductAsset(ownerId: string, url: string): void {
  if (!url || !ownerId) return;
  db.prepare(
    `UPDATE product_assets
        SET safety_status = 'pass', safety_evidence = '{"face":false,"overlay":false,"watermark":false}', safety_version = 'v2', sha256 = ?
      WHERE owner_id = ? AND url = ?`
  ).run(TEST_SAFETY_SHA256, ownerId, url);
}

/** 是否可用本地 FFmpeg（step5 成片渲染需要）；探测结果缓存，避免每个测试重复 spawn */
let ffmpegCached: boolean | null = null;
export function hasFfmpeg(): boolean {
  if (ffmpegCached !== null) return ffmpegCached;
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
    ffmpegCached = probe.status === 0;
  } catch {
    ffmpegCached = false;
  }
  return ffmpegCached;
}

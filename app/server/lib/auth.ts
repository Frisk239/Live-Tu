import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { db } from './db';
import type { PermissionKey } from './permission-catalog';

const SESSION_COOKIE = 'live_tu_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_FAILURE_KEY_LIMIT = 10_000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();
const EXPENSIVE_WINDOW_MS = 60 * 1000;
const EXPENSIVE_KEY_LIMIT = 10_000;
const expensiveRequests = new Map<string, { count: number; resetAt: number }>();
const internalWorkerToken = randomBytes(32).toString('base64url');

function pruneLoginFailures(now: number) {
  for (const [key, attempts] of loginFailures) {
    if (attempts.resetAt <= now) loginFailures.delete(key);
  }
  while (loginFailures.size >= LOGIN_FAILURE_KEY_LIMIT) {
    const oldestKey = loginFailures.keys().next().value;
    if (oldestKey === undefined) break;
    loginFailures.delete(oldestKey);
  }
}

function pruneExpensiveRequests(now: number) {
  for (const [key, attempts] of expensiveRequests) {
    if (attempts.resetAt <= now) expensiveRequests.delete(key);
  }
  while (expensiveRequests.size >= EXPENSIVE_KEY_LIMIT) {
    const oldestKey = expensiveRequests.keys().next().value;
    if (oldestKey === undefined) break;
    expensiveRequests.delete(oldestKey);
  }
}

function secureCookies(): boolean {
  if (process.env.COOKIE_SECURE === 'false') return false;
  if (process.env.COOKIE_SECURE === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

export type AuthUser = {
  id: string;
  username: string;
  role: 'admin' | 'operator';
  permissions: string[];
};
type AuthUserRow = Omit<AuthUser, 'permissions'>;

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      internalWorker?: boolean;
    }
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [saltHex, hashHex] = encoded.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const index = part.indexOf('=');
      if (index < 0) return [];
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      return key ? [[key, decodeURIComponent(value)]] : [];
    })
  );
}

function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookies(),
    path: '/',
    expires: expiresAt,
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookies(),
    path: '/',
  });
}

export function initializeAuth() {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());

  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  if (userCount.count > 0) return;

  const isProduction = process.env.NODE_ENV === 'production';
  const username = (process.env.ADMIN_USERNAME || (isProduction ? '' : 'haini')).trim();
  const password = process.env.ADMIN_PASSWORD || (isProduction ? '' : '888');

  if (!username || !password) {
    throw new Error('首次生产启动必须配置 ADMIN_USERNAME 和 ADMIN_PASSWORD');
  }
  if (isProduction && password.length < 12) {
    throw new Error('生产环境 ADMIN_PASSWORD 至少需要 12 个字符');
  }

  const insertUser = db.prepare(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, ?)`
  );
  // Development gets deterministic fixtures so the normal test account
  // exercises the operator permission boundary. Production always creates
  // only the explicitly configured administrator.
  if (!isProduction && !process.env.ADMIN_USERNAME) {
    insertUser.run(randomUUID(), 'haini', hashPassword('888'), 'operator');
    insertUser.run(randomUUID(), 'admin', hashPassword('888'), 'admin');
    return;
  }
  insertUser.run(randomUUID(), username, hashPassword(password), 'admin');
}

export function getUserPermissions(userId: string): string[] {
  return (
    db.prepare(
      `SELECT role_permissions.permission_key
         FROM users
         JOIN role_permissions ON role_permissions.role = users.role
        WHERE users.id = ? AND users.enabled = 1
        ORDER BY role_permissions.permission_key`
    ).all(userId) as Array<{ permission_key: string }>
  ).map((row) => row.permission_key);
}

function resolveUser(req: Request): AuthUser | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const row = db.prepare(
    `SELECT users.id, users.username, users.role
       FROM auth_sessions
       JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ?
        AND auth_sessions.expires_at > ?
        AND users.enabled = 1`
  ).get(hashSessionToken(token), new Date().toISOString()) as AuthUserRow | undefined;

  return row ? { ...row, permissions: getUserPermissions(row.id) } : null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = resolveUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: '请先登录' });
  }
  req.authUser = user;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const user = resolveUser(req);
  if (user) req.authUser = user;
  next();
}

export function internalWorkerHeaders(): Record<string, string> {
  return { 'x-live-tu-worker': internalWorkerToken };
}

export function requireAuthOrInternal(req: Request, res: Response, next: NextFunction) {
  const provided = String(req.headers['x-live-tu-worker'] || '');
  if (provided) {
    const expected = Buffer.from(internalWorkerToken);
    const actual = Buffer.from(provided);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      req.internalWorker = true;
      return next();
    }
  }
  return requireAuth(req, res, next);
}

export function limitExpensiveOperations(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.internalWorker) {
    return next();
  }
  const configuredLimit = Number(process.env.EXPENSIVE_REQUESTS_PER_MINUTE || 20);
  const maximum = Number.isFinite(configuredLimit)
    ? Math.min(1_000, Math.max(1, Math.floor(configuredLimit)))
    : 20;
  const now = Date.now();
  pruneExpensiveRequests(now);
  const identity = req.authUser?.id || req.ip || req.socket.remoteAddress || 'unknown';
  const routeFamily = req.baseUrl.replace(/^\/api\/v1/, '/api');
  const key = `${identity}:${routeFamily}`;
  const current = expensiveRequests.get(key);
  if (current && current.resetAt > now && current.count >= maximum) {
    res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
    return res.status(429).json({
      success: false,
      error: '高成本操作请求过于频繁，请稍后重试',
    });
  }
  expensiveRequests.set(key, {
    count: (current?.count || 0) + 1,
    resetAt: current?.resetAt || now + EXPENSIVE_WINDOW_MS,
  });
  next();
}

export function requireRole(role: AuthUser['role']) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ success: false, error: '请先登录' });
    }
    if (req.authUser.role !== role) {
      return res.status(403).json({ success: false, error: '权限不足' });
    }
    next();
  };
}

export function requirePermission(permission: PermissionKey) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ success: false, error: '请先登录' });
    }
    if (!req.authUser.permissions.includes(permission)) {
      return res.status(403).json({ success: false, error: '权限不足' });
    }
    next();
  };
}

export function sameOriginOnly(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();

  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== req.headers.host) {
      return res.status(403).json({ success: false, error: '拒绝跨站请求' });
    }
  } catch {
    return res.status(403).json({ success: false, error: '无效请求来源' });
  }
  next();
}

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  pruneLoginFailures(now);
  const attempts = loginFailures.get(clientKey);
  if (attempts && attempts.resetAt > now && attempts.count >= LOGIN_MAX_FAILURES) {
    res.setHeader('Retry-After', String(Math.ceil((attempts.resetAt - now) / 1000)));
    return res.status(429).json({ success: false, error: '登录尝试过多，请稍后重试' });
  }
  if (attempts && attempts.resetAt <= now) loginFailures.delete(clientKey);

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '账号和密码必填' });
  }

  const row = db.prepare(
    'SELECT id, username, password_hash, role FROM users WHERE username = ? AND enabled = 1'
  ).get(username) as (AuthUserRow & { password_hash: string }) | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    const current = loginFailures.get(clientKey);
    loginFailures.set(clientKey, {
      count: (current?.count || 0) + 1,
      resetAt: current?.resetAt || now + LOGIN_WINDOW_MS,
    });
    return res.status(401).json({ success: false, error: '账号或密码错误' });
  }

  loginFailures.delete(clientKey);
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.prepare(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(hashSessionToken(token), row.id, expiresAt.toISOString());
  setSessionCookie(res, token, expiresAt);

  return res.json({
    success: true,
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      permissions: getUserPermissions(row.id),
    },
  });
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashSessionToken(token));
  }
  clearSessionCookie(res);
  return res.json({ success: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  return res.json({ success: true, user: req.authUser });
});

authRouter.get('/users', requireAuth, requirePermission('admin.users.manage'), (_req, res) => {
  const users = db.prepare(
    `SELECT id, username, role, enabled, created_at, updated_at
       FROM users
      ORDER BY created_at ASC`
  ).all();
  return res.json({ success: true, data: users });
});

authRouter.get('/audit-logs', requireAuth, requirePermission('admin.audit.read'), (req, res) => {
  const requestedLimit = Number(req.query.limit || 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(500, Math.max(1, Math.floor(requestedLimit)))
    : 100;
  const rows = db.prepare(
    `SELECT audit_logs.id, audit_logs.action, audit_logs.entity_type,
            audit_logs.entity_id, audit_logs.metadata_json,
            audit_logs.created_at, users.username
       FROM audit_logs
       LEFT JOIN users ON users.id = audit_logs.user_id
      ORDER BY audit_logs.created_at DESC
      LIMIT ?`
  ).all(limit);
  return res.json({ success: true, data: rows });
});

authRouter.post('/users', requireAuth, requirePermission('admin.users.manage'), (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const role = req.body?.role === 'admin' ? 'admin' : 'operator';

  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    return res.status(400).json({ success: false, error: '账号需为 3–64 位字母、数字或 ._-' });
  }
  if (password.length < 12) {
    return res.status(400).json({ success: false, error: '密码至少需要 12 个字符' });
  }

  try {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role)
       VALUES (?, ?, ?, ?)`
    ).run(id, username, hashPassword(password), role);
    return res.status(201).json({ success: true, user: { id, username, role } });
  } catch (error: any) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: '账号已存在' });
    }
    throw error;
  }
});

authRouter.patch('/users/:id', requireAuth, requirePermission('admin.users.manage'), (req, res) => {
  const existing = db.prepare(
    'SELECT id, username, role, enabled FROM users WHERE id = ?'
  ).get(req.params.id) as (AuthUserRow & { enabled: number }) | undefined;
  if (!existing) return res.status(404).json({ success: false, error: '用户不存在' });

  const nextRole = req.body?.role === undefined
    ? existing.role
    : req.body.role === 'admin'
      ? 'admin'
      : 'operator';
  const nextEnabled = req.body?.enabled === undefined
    ? existing.enabled
    : req.body.enabled
      ? 1
      : 0;
  const nextPassword = req.body?.password === undefined ? '' : String(req.body.password);

  if (req.authUser?.id === existing.id && !nextEnabled) {
    return res.status(400).json({ success: false, error: '不能停用当前登录账号' });
  }
  if (existing.role === 'admin' && (nextRole !== 'admin' || !nextEnabled)) {
    const enabledAdmins = db.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND enabled = 1"
    ).get() as { count: number };
    if (enabledAdmins.count <= 1) {
      return res.status(400).json({
        success: false,
        error: '系统必须至少保留一个启用的管理员账户',
      });
    }
  }
  if (nextPassword && nextPassword.length < 12) {
    return res.status(400).json({ success: false, error: '密码至少需要 12 个字符' });
  }

  if (nextPassword) {
    db.prepare(
      `UPDATE users
          SET role = ?, enabled = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(nextRole, nextEnabled, hashPassword(nextPassword), existing.id);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(existing.id);
  } else {
    db.prepare(
      `UPDATE users
          SET role = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(nextRole, nextEnabled, existing.id);
    if (!nextEnabled || nextRole !== existing.role) {
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(existing.id);
    }
  }

  return res.json({
    success: true,
    user: { id: existing.id, username: existing.username, role: nextRole, enabled: nextEnabled },
  });
});

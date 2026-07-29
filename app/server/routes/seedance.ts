import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

export const seedanceRouter = Router();

/** Always read live process.env — never freeze values at import time (before dotenv). */
function seedanceEnv() {
  return {
    baseUrl: (process.env.SEEDANCE_BASE_URL || '').replace(/\/$/, ''),
    account: (process.env.SEEDANCE_ACCOUNT || '').trim(),
    password: (process.env.SEEDANCE_PASSWORD || '').trim(),
    model: process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast',
    defaultResolution: process.env.SEEDANCE_DEFAULT_RESOLUTION || '720p',
    defaultAspect: process.env.SEEDANCE_DEFAULT_ASPECT || '9:16',
  };
}

export function hasSeedanceConfig() {
  const { baseUrl, account, password } = seedanceEnv();
  if (!baseUrl || !account || !password) return false;
  if (
    baseUrl.includes('your-seedance') ||
    account.includes('your_') ||
    password.includes('your_') ||
    password === 'your-password'
  ) {
    return false;
  }
  return true;
}

let seedanceTokenCache: { accessToken: string; expiresAtMs: number } | null = null;

export async function getSeedanceToken(forceRefresh = false): Promise<string> {
  if (!hasSeedanceConfig()) {
    throw new Error('Seedance 中转未配置：请设置 SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD');
  }

  const { baseUrl, account, password } = seedanceEnv();
  const now = Date.now();
  if (!forceRefresh && seedanceTokenCache && seedanceTokenCache.expiresAtMs - 60_000 > now) {
    return seedanceTokenCache.accessToken;
  }

  const response = await fetch(`${baseUrl}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });

  const errText = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`Seedance token failed ${response.status}: ${errText.slice(0, 300)}`);
  }

  const payload = JSON.parse(errText);
  const accessToken = payload?.data?.accessToken;
  if (!accessToken) throw new Error('Seedance missing accessToken');

  const expiresInSec = Number(payload?.data?.expiresIn || 7200);
  seedanceTokenCache = { accessToken, expiresAtMs: now + expiresInSec * 1000 };
  return accessToken;
}

export async function seedanceFetch(apiPath: string, init: RequestInit = {}, retryOn401 = true): Promise<any> {
  const { baseUrl } = seedanceEnv();
  const token = await getSeedanceToken(false);
  const response = await fetch(`${baseUrl}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await response.text().catch(() => '');
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (response.status === 401 && retryOn401) {
    seedanceTokenCache = null;
    return seedanceFetch(apiPath, init, false);
  }

  if (!response.ok) {
    const msg = json?.error || json?.message || text.slice(0, 300) || response.statusText;
    const err = new Error(`Seedance ${apiPath} failed ${response.status}: ${msg}`);
    (err as any).status = response.status;
    (err as any).payload = json;
    throw err;
  }
  return json;
}

/**
 * materials[].url 必须公网可访问（Seedance 文档硬约束）。
 * 相对路径 /uploads/... 需配置 PUBLIC_BASE_URL（部署公网域名/IP）。
 */
/**
 * materials[].url 必须公网可访问（Seedance 文档硬约束）。
 * 相对路径 /uploads/... 优先使用 PUBLIC_BASE_URL 或 HTTP 请求 Host（部署公网域名/IP）。
 */
export function resolvePublicMediaUrl(url: string, requestBaseUrl?: string): { url: string | null; warning?: string } {
  if (!url || !url.trim()) return { url: null, warning: '未提供素材 URL' };
  const trimmed = url.trim();

  if (trimmed.startsWith('data:')) {
    return {
      url: null,
      warning: 'Seedance 不支持 data: URL，请使用已上传的公网 http(s) 素材',
    };
  }

  const publicBase = (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || requestBaseUrl || '').replace(/\/$/, '');

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const u = new URL(trimmed);
      const host = u.hostname.toLowerCase();
      let publicHost: string | null = null;
      if (publicBase) {
        try {
          publicHost = new URL(publicBase).hostname.toLowerCase();
        } catch {}
      }

      if (publicHost && host === publicHost) {
        return { url: trimmed };
      }

      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host.endsWith('.local') ||
        host.startsWith('192.168.') ||
        host.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      ) {
        if (publicBase) {
          const relativePath = u.pathname + u.search;
          return { url: `${publicBase}${relativePath}` };
        }
        return {
          url: null,
          warning: `素材 URL 不是公网地址（${host}）。Seedance 无法拉取内网/本机文件，请配置 PUBLIC_BASE_URL 或使用公网图链`,
        };
      }
      return { url: trimmed };
    } catch {
      return { url: null, warning: '素材 URL 非法' };
    }
  }

  if (!publicBase) {
    return {
      url: null,
      warning:
        '本地素材路径需配置 PUBLIC_BASE_URL（公网可访问的站点根，如 https://your-host:3004）才能提交 Seedance 图生视频',
    };
  }
  const pathPart = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return { url: `${publicBase}${pathPart}` };
}

export interface SeedanceCreateInput {
  prompt: string;
  model?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
  cameraFixed?: boolean;
  seed?: number | null;
  imageUrl?: string;
  materials?: Array<{ url: string; kind?: string; role?: string; label?: string }>;
}

/** Build request body matching 星河 Seedance 2.0 外部接口文档 */
export function buildSeedanceGenerationBody(input: SeedanceCreateInput, requestBaseUrl?: string) {
  const env = seedanceEnv();
  const raw = String(input.model || env.model || 'doubao-seedance-2-0-fast');
  const lower = raw.toLowerCase();
  let modelId = 'doubao-seedance-2-0-fast';
  if (lower.includes('mini')) modelId = 'doubao-seedance-2-0-mini';
  else if (lower.includes('fast')) modelId = 'doubao-seedance-2-0-fast';
  else if (lower.includes('seedance') || lower.includes('doubao')) modelId = 'doubao-seedance-2-0';

  let duration = Number(input.duration) || 5;
  if (duration < 4) duration = 4;
  if (duration > 15) duration = 15;

  const materials: Array<{ url: string; kind: string; role?: string; label?: string }> = [];
  const warnings: string[] = [];

  if (input.materials?.length) {
    for (const m of input.materials) {
      const resolved = resolvePublicMediaUrl(m.url, requestBaseUrl);
      if (resolved.url) {
        materials.push({
          url: resolved.url,
          kind: m.kind || 'image',
          role: m.role || 'first_frame',
          label: m.label || 'reference',
        });
      } else if (resolved.warning) {
        warnings.push(resolved.warning);
      }
    }
  } else if (input.imageUrl) {
    const resolved = resolvePublicMediaUrl(input.imageUrl, requestBaseUrl);
    if (resolved.url) {
      materials.push({
        url: resolved.url,
        kind: 'image',
        role: 'first_frame',
        label: 'step2_first_frame',
      });
    } else if (resolved.warning) {
      warnings.push(resolved.warning);
    }
  }

  const body = {
    model: modelId,
    prompt: input.prompt,
    params: {
      duration,
      resolution: input.resolution || env.defaultResolution || '720p',
      aspectRatio: input.aspectRatio || env.defaultAspect || '9:16',
      generateAudio: input.generateAudio ?? true,
      cameraFixed: input.cameraFixed ?? false,
      seed: input.seed ?? null,
    },
    ...(materials.length > 0 ? { materials } : {}),
  };

  return { body, materials, warnings, modelId };
}

export async function createSeedanceVideo(input: SeedanceCreateInput | Record<string, any>): Promise<any> {
  if (input && typeof input === 'object' && 'params' in input && 'model' in input && 'prompt' in input) {
    return seedanceFetch('/api/v1/videos/generations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  const { body, warnings } = buildSeedanceGenerationBody(input as SeedanceCreateInput);
  if (warnings.length > 0 && !(body as any).materials) {
    const err = new Error(warnings.join('; '));
    (err as any).status = 400;
    (err as any).warnings = warnings;
    throw err;
  }

  return seedanceFetch('/api/v1/videos/generations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function normalizeSeedanceTask(payload: any) {
  const data = payload?.data || payload || {};
  return {
    id: data.id || null,
    status: data.status || (data.url ? 'success' : 'processing'),
    url: data.url || null,
    createdAt: data.createdAt || null,
    provider: data.provider || null,
    model: data.model || null,
    inferenceId: data.inferenceId || null,
    error: data.error || null,
    raw: payload,
  };
}

/**
 * Download remote Seedance result into uploads/renders so Step5/FFmpeg can use a stable local path.
 */
export async function cacheRemoteVideoToUploads(
  remoteUrl: string,
  preferredName?: string
): Promise<{ localUrl: string; absolutePath: string } | null> {
  if (!remoteUrl || !(remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://'))) {
    return null;
  }
  if (remoteUrl.includes('/uploads/renders/')) {
    return { localUrl: remoteUrl.startsWith('/') ? remoteUrl : `/${remoteUrl}`, absolutePath: '' };
  }

  const rendersDir = path.join(process.cwd(), 'uploads', 'renders');
  if (!fs.existsSync(rendersDir)) {
    fs.mkdirSync(rendersDir, { recursive: true });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const res = await fetch(remoteUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn('[seedance] cache download failed', res.status);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) return null;

    const base = preferredName || `seedance_${Date.now()}`;
    const filename = base.endsWith('.mp4') ? base : `${base}.mp4`;
    const absolutePath = path.join(rendersDir, filename);
    fs.writeFileSync(absolutePath, buf);
    return { localUrl: `/uploads/renders/${filename}`, absolutePath };
  } catch (err: any) {
    console.warn('[seedance] cacheRemoteVideoToUploads:', err.message);
    return null;
  }
}

seedanceRouter.get('/status', async (req, res) => {
  if (!hasSeedanceConfig()) {
    const env = seedanceEnv();
    return res.json({
      success: true,
      configured: false,
      message: '未配置星河中转。请设置 SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD',
      missing: [
        !env.baseUrl ? 'SEEDANCE_BASE_URL' : null,
        !env.account ? 'SEEDANCE_ACCOUNT' : null,
        !env.password ? 'SEEDANCE_PASSWORD' : null,
      ].filter(Boolean),
    });
  }

  const env = seedanceEnv();
  if (req.query.probe === '1') {
    try {
      await getSeedanceToken(true);
      return res.json({
        success: true,
        configured: true,
        tokenOk: true,
        baseUrl: env.baseUrl,
        model: env.model,
      });
    } catch (err: any) {
      return res.status(502).json({ success: false, configured: true, error: err.message });
    }
  }

  return res.json({ success: true, configured: true, baseUrl: env.baseUrl, model: env.model });
});

seedanceRouter.post('/generations', async (req, res) => {
  if (!hasSeedanceConfig()) {
    return res.status(503).json({ success: false, error: 'Seedance 中转未配置' });
  }

  try {
    const payload = await createSeedanceVideo(req.body);
    const task = normalizeSeedanceTask(payload);
    return res.json({ success: true, data: task, source: 'seedance-relay' });
  } catch (err: any) {
    return res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

seedanceRouter.get('/generations/:id', async (req, res) => {
  if (!hasSeedanceConfig()) {
    return res.status(503).json({ success: false, error: 'Seedance 中转未配置' });
  }

  try {
    const payload = await seedanceFetch(`/api/v1/videos/generations/${encodeURIComponent(req.params.id)}`);
    const task = normalizeSeedanceTask(payload);

    if (
      task.url &&
      !String(task.url).includes('/uploads/renders/') &&
      (task.status === 'success' ||
        task.status === 'completed' ||
        task.status === 'succeeded' ||
        Boolean(task.url && task.status !== 'processing' && task.status !== 'queued'))
    ) {
      const cached = await cacheRemoteVideoToUploads(task.url, `seedance_${task.id || Date.now()}`);
      if (cached?.localUrl) {
        (task as any).remoteUrl = task.url;
        task.url = cached.localUrl;
        (task as any).cachedLocally = true;
      }
    }

    return res.json({ success: true, data: task, source: 'seedance-relay' });
  } catch (err: any) {
    return res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

/** Explicit cache of an arbitrary remote video URL */
seedanceRouter.post('/cache', async (req, res) => {
  try {
    const { url, name } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'url 必填' });
    const cached = await cacheRemoteVideoToUploads(String(url), name);
    if (!cached) {
      return res.status(502).json({ success: false, error: '下载并缓存视频失败' });
    }
    return res.json({
      success: true,
      data: { videoUrl: cached.localUrl, downloadUrl: cached.localUrl },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

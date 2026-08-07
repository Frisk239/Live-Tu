import { Router } from 'express';
import path from 'node:path';
import { createSignedMediaUrl } from '../lib/signed-media';
import { cacheRemoteMedia } from './render';
import { registerOwnedMedia } from '../lib/media-ownership';
import { getVideoSubmissionPort } from '../lib/video-submission-port';
import {
  canAccessSeedanceTask,
  registerSeedanceTaskOwner,
} from '../lib/seedance-ownership';

export const seedanceRouter = Router();

/** Always read live process.env — never freeze values at import time (before dotenv). */
function seedanceEnv() {
  const provider = process.env.SEEDANCE_PROVIDER === 'ark' ? 'ark' : 'relay';
  return {
    provider,
    baseUrl: (
      provider === 'ark'
        ? process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
        : process.env.SEEDANCE_BASE_URL || ''
    ).replace(/\/$/, ''),
    account: (process.env.SEEDANCE_ACCOUNT || '').trim(),
    password: (process.env.SEEDANCE_PASSWORD || '').trim(),
    apiKey: (process.env.ARK_API_KEY || '').trim(),
    model: process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast',
    defaultResolution: process.env.SEEDANCE_DEFAULT_RESOLUTION || '720p',
    defaultAspect: process.env.SEEDANCE_DEFAULT_ASPECT || '9:16',
    // yunshu.hk 备用视频 provider（New API OpenAI 兼容网关，Bearer key 与云雾通用）
    fallbackProvider: process.env.SEEDANCE_FALLBACK_PROVIDER || 'none',
    yunshuBaseUrl: (process.env.YUNSHU_BASE_URL || '').replace(/\/$/, ''),
    yunshuApiKey: (process.env.YUNSHU_API_KEY || '').trim(),
    yunshuModel: process.env.YUNSHU_MODEL || 'doubao-seedance-1-0-pro-fast-251015',
  };
}

export function hasSeedanceConfig() {
  const env = seedanceEnv();
  if (env.provider === 'ark') {
    return Boolean(env.apiKey && env.apiKey !== 'your_ark_api_key');
  }
  const { baseUrl, account, password } = env;
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

/** yunshu.hk 备用通道可用性：显式开启 + baseUrl 就绪；key 留空时复用云雾 YUNWU_API_KEY */
export function hasYunshuConfig(): boolean {
  const env = seedanceEnv();
  if (env.fallbackProvider !== 'yunshu' || !env.yunshuBaseUrl) return false;
  if (env.yunshuBaseUrl.includes('your-') || env.yunshuBaseUrl === 'none') return false;
  const key = env.yunshuApiKey || process.env.YUNWU_API_KEY || '';
  return Boolean(key && key !== 'your_yunwu_api_key' && !key.startsWith('your_'));
}

let seedanceTokenCache: { accessToken: string; expiresAtMs: number } | null = null;

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_MS = 750;
const RETRY_MAX_MS = 6_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function backoffMs(attempt: number): number {
  const base = Number(process.env.SEEDANCE_RETRY_BASE_MS || RETRY_BASE_MS);
  return Math.min(base * 2 ** attempt, RETRY_MAX_MS);
}

function backoffWithRetryAfter(attempt: number, response: Response): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  return backoffMs(attempt);
}

/**
 * 付费 POST（创建生成任务）在不确定错误（超时/网络中断）后不自动重提：
 * 请求可能已在中转侧创建任务，盲目重试会重复扣费。仅 5xx/429（服务端明确未处理）可安全重试。
 * GET 查询（轮询任务状态）幂等，超时/网络错误也重试。
 */
function retryableOnTransportError(method: string | undefined, policy: 'safe' | 'idempotent'): boolean {
  return policy === 'idempotent' || (method || 'GET').toUpperCase() === 'GET';
}

export async function getSeedanceToken(forceRefresh = false): Promise<string> {
  const env = seedanceEnv();
  if (!hasSeedanceConfig()) {
    throw new Error(
      env.provider === 'ark'
        ? '火山方舟未配置：请设置 ARK_API_KEY（SEEDANCE_PROVIDER=ark）'
        : 'Seedance 中转未配置：请设置 SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD'
    );
  }
  // 火山方舟直连：API Key 即 bearer token，无需换取
  if (env.provider === 'ark') {
    return env.apiKey;
  }

  const { baseUrl, account, password } = env;
  const now = Date.now();
  if (!forceRefresh && seedanceTokenCache && seedanceTokenCache.expiresAtMs - 60_000 > now) {
    return seedanceTokenCache.accessToken;
  }

  // token 换取幂等（每次换新），中转繁忙时带超时重试
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `${baseUrl}/api/v1/auth/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account, password }),
        },
        15_000
      );
      const errText = await response.text().catch(() => '');
      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < DEFAULT_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`Seedance token failed ${response.status}: ${errText.slice(0, 300)}`);
      }
      const payload = JSON.parse(errText);
      const accessToken = payload?.data?.accessToken;
      if (!accessToken) throw new Error('Seedance missing accessToken');

      const expiresInSec = Number(payload?.data?.expiresIn || 7200);
      seedanceTokenCache = { accessToken, expiresAtMs: Date.now() + expiresInSec * 1000 };
      return accessToken;
    } catch (error) {
      lastError = error;
      if (attempt < DEFAULT_RETRIES && !(error instanceof Error && /token failed|missing accessToken/.test(error.message))) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Seedance token 获取失败');
}

export async function seedanceFetch(
  apiPath: string,
  init: RequestInit = {},
  retryOn401 = true,
  options: { timeoutMs?: number; retries?: number; retryPolicy?: 'safe' | 'idempotent' } = {}
): Promise<any> {
  const { baseUrl } = seedanceEnv();
  const timeoutMs = options.timeoutMs ?? Number(process.env.SEEDANCE_FETCH_TIMEOUT_MS || DEFAULT_FETCH_TIMEOUT_MS);
  const maxRetries = options.retries ?? DEFAULT_RETRIES;
  const method = (init.method || 'GET').toUpperCase();
  const fullyRetryable = retryableOnTransportError(method, options.retryPolicy ?? 'safe');

  let token = await getSeedanceToken(false);
  let tokenRefreshed = false;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${baseUrl}${apiPath}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
          },
        },
        timeoutMs
      );
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      if (attempt < maxRetries && fullyRetryable) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const err = new Error(
        `Seedance ${apiPath} 请求${timedOut ? '超时' : '失败'}（${timeoutMs}ms）：${
          error instanceof Error ? error.message : String(error)
        }`
      );
      (err as any).status = timedOut ? 408 : 0;
      if (!fullyRetryable && attempt === 0) {
        err.message += '。该请求可能已提交，请通过任务列表确认，勿重复提交';
      }
      throw err;
    }

    const text = await response.text().catch(() => '');
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (response.status === 401 && retryOn401 && !tokenRefreshed) {
      seedanceTokenCache = null;
      token = await getSeedanceToken(true);
      tokenRefreshed = true;
      continue;
    }

    if (response.status === 401) {
      const err = new Error(`Seedance ${apiPath} 鉴权失败 401（刷新 token 后仍被拒）`);
      (err as any).status = 401;
      throw err;
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await sleep(backoffWithRetryAfter(attempt, response));
        continue;
      }
      const msg = json?.error || json?.message || text.slice(0, 300) || response.statusText;
      const err = new Error(`Seedance ${apiPath} failed ${response.status}: ${msg}`);
      (err as any).status = response.status;
      (err as any).payload = json;
      throw err;
    }
    return json;
  }
}

/**
 * materials[].url 必须公网可访问（Seedance 文档硬约束）。
 * 相对路径 /uploads/... 优先使用 PUBLIC_BASE_URL 或 HTTP 请求 Host（部署公网域名/IP）。
 */
function isPrivateHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

/**
 * S1.4：提交前首帧可达性预检（对标 LibTV「自动校验素材」默认开关）。
 * 对最终公网 URL 做 HEAD 探测（60s 内缓存），失败给出可读原因，
 * 避免 Seedance 中转侧 "Failed to download virtual asset URL" 晚到错误。
 * 由 SEEDANCE_PREFLIGHT 控制，默认开启；'false' 时跳过。
 */
const preflightCache = new Map<string, { ok: boolean; checkedAt: number; error?: string }>();

export async function preflightMediaUrl(
  url: string,
  timeoutMs = 10_000
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const cached = preflightCache.get(url);
  if (cached && Date.now() - cached.checkedAt < 60_000) {
    return cached.ok ? { ok: true } : { ok: false, error: cached.error };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    const ok = response.ok;
    const result = { ok, status: response.status, error: ok ? undefined : `HTTP ${response.status}` };
    preflightCache.set(url, { ok, checkedAt: Date.now(), error: result.error });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    preflightCache.set(url, { ok: false, checkedAt: Date.now(), error: message });
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

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
  const minioPublicBase = (process.env.MINIO_PUBLIC_URL || '').replace(/\/$/, '');

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
        if (u.pathname.startsWith('/uploads/')) {
          if (isPrivateHostname(publicHost)) {
            return {
              url: null,
              warning: `PUBLIC_BASE_URL 指向内网/本机地址（${publicBase}），Seedance 无法下载该首帧图。请配置公网可访问的域名或 IP`,
            };
          }
          return { url: createSignedMediaUrl(u.pathname, publicBase) };
        }
        return { url: trimmed };
      }

      if (isPrivateHostname(host)) {
        if (minioPublicBase && u.pathname.startsWith(`/${process.env.MINIO_BUCKET || 'buv-materials'}/`)) {
          return { url: `${minioPublicBase}${u.pathname}${u.search}` };
        }
        if (publicBase && !isPrivateHostname(new URL(publicBase).hostname.toLowerCase())) {
          const relativePath = u.pathname + u.search;
          if (u.pathname.startsWith('/uploads/')) {
            return { url: createSignedMediaUrl(u.pathname, publicBase) };
          }
          return { url: `${publicBase}${relativePath}` };
        }
        return {
          url: null,
          warning: `素材 URL 不是公网地址（${host}）。Seedance 无法拉取内网/本机文件，请配置公网可访问的 PUBLIC_BASE_URL 或使用公网图链`,
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
  if (pathPart.startsWith('/uploads/')) {
    try {
      const pbHost = new URL(publicBase).hostname.toLowerCase();
      if (isPrivateHostname(pbHost)) {
        return {
          url: null,
          warning: `PUBLIC_BASE_URL 指向内网/本机地址（${publicBase}），Seedance 无法下载该首帧图。请配置公网可访问的域名或 IP`,
        };
      }
    } catch {
      return { url: null, warning: `PUBLIC_BASE_URL 非法: ${publicBase}` };
    }
    return { url: createSignedMediaUrl(pathPart, publicBase) };
  }
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
        const kind = m.kind || 'image';
        // 星河契约：role 仅对图片素材有效（reference_image / first_frame / last_frame）；
        // video/audio 素材不携带图片角色，避免把视频错标成 first_frame
        materials.push({
          url: resolved.url,
          kind,
          ...(kind === 'image' ? { role: m.role || 'first_frame' } : {}),
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

/** 把统一中间结构 body 转成火山方舟 contents/generations/tasks 请求体 */
function toArkTaskBody(body: Record<string, any>): Record<string, any> {
  const content: any[] = [{ type: 'text', text: String(body.prompt || '') }];
  for (const m of body.materials || []) {
    content.push({
      type: 'image_url',
      role: m.role === 'reference_image' ? 'reference_image' : 'first_frame',
      image_url: { url: m.url },
    });
  }
  const params = body.params || {};
  return {
    model: process.env.ARK_MODEL || 'doubao-seedance-2-0-260128',
    content,
    duration: Number(params.duration) || 5,
    resolution: params.resolution || '720p',
    ratio: params.aspectRatio || '9:16',
    watermark: false,
    generate_audio: params.generateAudio ?? true,
  };
}

export async function createSeedanceVideo(input: SeedanceCreateInput | Record<string, any>): Promise<any> {
  const isPrebuilt = input && typeof input === 'object' && 'params' in input && 'model' in input && 'prompt' in input;
  let body: Record<string, any>;
  let warnings: string[] = [];
  if (isPrebuilt) {
    body = input as Record<string, any>;
  } else {
    const built = buildSeedanceGenerationBody(input as SeedanceCreateInput);
    body = built.body as Record<string, any>;
    warnings = built.warnings;
  }
  if (warnings.length > 0 && !body.materials) {
    const err = new Error(warnings.join('; '));
    (err as any).status = 400;
    (err as any).warnings = warnings;
    throw err;
  }

  if (seedanceEnv().provider === 'ark') {
    return seedanceFetch('/contents/generations/tasks', {
      method: 'POST',
      body: JSON.stringify(toArkTaskBody(body)),
    });
  }
  return seedanceFetch('/api/v1/videos/generations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------- yunshu.hk 备用视频 provider（New API OpenAI 兼容网关） ----------

function yunshuApiKey(): string {
  const env = seedanceEnv();
  return env.yunshuApiKey || process.env.YUNWU_API_KEY || '';
}

/** yunshu 请求独立于 relay token：直接 Bearer 云雾/yunshu key，带超时与 5xx/429 重试 */
async function yunshuFetch(apiPath: string, init: RequestInit = {}): Promise<any> {
  const env = seedanceEnv();
  const url = `${env.yunshuBaseUrl}${apiPath}`;
  const timeoutMs = Number(process.env.SEEDANCE_FETCH_TIMEOUT_MS || DEFAULT_FETCH_TIMEOUT_MS);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${yunshuApiKey()}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
          },
        },
        timeoutMs
      );
      const text = await response.text().catch(() => '');
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < DEFAULT_RETRIES) {
          await sleep(backoffWithRetryAfter(attempt, response));
          continue;
        }
        const msg = json?.error?.message || json?.message || json?.error || text.slice(0, 300) || response.statusText;
        const err = new Error(`Yunshu ${apiPath} failed ${response.status}: ${msg}`);
        (err as any).status = response.status;
        (err as any).payload = json;
        throw err;
      }
      return json;
    } catch (err: any) {
      if (err?.status && !isRetryableStatus(err.status)) throw err;
      if (err?.name === 'AbortError') {
        const timeoutErr = new Error(`Yunshu ${apiPath} timed out after ${timeoutMs}ms`);
        (timeoutErr as any).status = 408;
        throw timeoutErr;
      }
      if (attempt < DEFAULT_RETRIES) {
        lastError = err;
        await sleep(backoffMs(attempt));
        continue;
      }
      const networkErr = new Error(err?.message || `Yunshu ${apiPath} network error`);
      (networkErr as any).status = err?.status || 0;
      throw networkErr;
    }
  }
  throw lastError;
}

/** yunshu 提交：New API 视频接口 POST /v1/video/generations {model, prompt, image}，image 为首帧公网 URL */
export async function createYunshuVideo(
  input: SeedanceCreateInput | Record<string, any>,
  requestBaseUrl?: string
): Promise<any> {
  const env = seedanceEnv();
  const isPrebuilt = input && typeof input === 'object' && 'params' in input && 'model' in input && 'prompt' in input;
  let prompt: string;
  let firstFrameUrl: string | null = null;
  const warnings: string[] = [];

  if (isPrebuilt) {
    const body = input as Record<string, any>;
    prompt = String(body.prompt || '');
    const material = (body.materials || [])[0];
    if (material?.url) firstFrameUrl = String(material.url);
  } else {
    const built = buildSeedanceGenerationBody(input as SeedanceCreateInput, requestBaseUrl);
    prompt = String(input.prompt || '');
    warnings.push(...built.warnings);
    firstFrameUrl = built.materials?.[0]?.url || null;
  }
  if (warnings.length > 0 && !firstFrameUrl) {
    const err = new Error(warnings.join('; '));
    (err as any).status = 400;
    (err as any).warnings = warnings;
    throw err;
  }
  if (!firstFrameUrl) {
    const err = new Error('Yunshu 图生视频需要首帧公网 URL（materials[0]）');
    (err as any).status = 400;
    throw err;
  }

  const body = {
    model: env.yunshuModel,
    prompt,
    image: firstFrameUrl,
  };
  return yunshuFetch('/v1/video/generations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getYunshuVideo(taskId: string): Promise<any> {
  return yunshuFetch(`/v1/video/generations/${encodeURIComponent(taskId)}`);
}

/** New API 视频任务响应 → 与 normalizeSeedanceTask 兼容的结构 */
export function normalizeYunshuTask(payload: any) {
  const data = payload?.data || payload || {};
  const statusRaw = String(data.task_status || data.status || '').toLowerCase();
  const status =
    statusRaw === 'succeeded' || statusRaw === 'success' ? 'success'
      : statusRaw === 'failed' || statusRaw === 'error' ? 'failed'
        : (data.video_url || data.url) ? 'success'
          : statusRaw || 'processing';
  return {
    id: data.task_id || data.id || null,
    status,
    url: data.video_url || data.url || data.content?.video_url || null,
    createdAt: data.created_at || data.createdAt || null,
    provider: 'yunshu',
    model: data.model || null,
    inferenceId: data.request_id || data.inference_id || null,
    error: data.error || (typeof data.message === 'string' ? data.message.slice(0, 200) : null),
    raw: payload,
  };
}

/** 判断主 provider 的失败是否值得切 yunshu 备用通道（用户输入类 4xx 不切） */
function isFallbackEligibleError(err: any): boolean {
  const status = Number(err?.status || 0);
  if (!status) return true; // 网络错误/超时（408/0）
  if (status >= 500) return true;
  if (status === 429 || status === 401 || status === 403 || status === 404 || status === 408) return true;
  return false; // 其余 4xx（400/415/422 等输入类问题）
}

/**
 * 提交视频生成任务：优先主 provider（relay/ark），可切换故障时自动降级到 yunshu 备用通道。
 * 返回的 task.id 带 provider 前缀（seedance: / yunshu:），下游按不透明 id 存储与轮询。
 */
export async function submitSeedanceVideoWithFallback(
  input: SeedanceCreateInput | Record<string, any>,
  requestBaseUrl?: string
): Promise<{ task: any; provider: string; fallbackUsed: boolean; fallbackError?: Error }> {
  try {
    const payload = await createSeedanceVideo(input);
    const task = normalizeSeedanceTask(payload);
    return { task, provider: seedanceEnv().provider, fallbackUsed: false };
  } catch (err: any) {
    if (!isFallbackEligibleError(err) || !hasYunshuConfig()) throw err;
    console.warn(
      `[seedance] 主通道提交失败（${err?.message?.slice(0, 120)}），自动切换到 yunshu 备用通道`
    );
    const payload = await createYunshuVideo(input, requestBaseUrl);
    const task = normalizeYunshuTask(payload);
    if (!task.id) throw new Error(`Yunshu 提交未返回任务 id: ${JSON.stringify(payload).slice(0, 300)}`);
    task.id = `yunshu:${task.id}`;
    return { task, provider: 'yunshu', fallbackUsed: true, fallbackError: err };
  }
}

export async function getSeedanceVideo(id: string): Promise<any> {
  if (seedanceEnv().provider === 'ark') {
    return seedanceFetch(`/contents/generations/tasks/${encodeURIComponent(id)}`);
  }
  return seedanceFetch(`/api/v1/videos/generations/${encodeURIComponent(id)}`);
}

export function normalizeSeedanceTask(payload: any) {
  const data = payload?.data || payload || {};
  // 火山方舟响应：{ id, status: 'succeeded', content: { video_url } }
  const arkStatus = String(data.status || '').toLowerCase();
  const arkUrl = data?.content?.video_url || data?.video_url || null;
  const status =
    arkStatus === 'succeeded' ? 'success'
      : arkStatus === 'failed' || arkStatus === 'error' ? 'failed'
        : data.status || (data.url ? 'success' : 'processing');
  return {
    id: data.id || null,
    status,
    url: arkUrl || data.url || null,
    createdAt: data.createdAt || null,
    provider: data.provider || null,
    model: data.model || null,
    inferenceId: data.inferenceId || null,
    error: data.error || (data?.content?.error ? JSON.stringify(data.content.error).slice(0, 200) : null),
    raw: payload,
  };
}

/**
 * Download remote Seedance result into uploads/renders so Step5/FFmpeg can use a stable local path.
 */
export async function cacheRemoteVideoToUploads(
  remoteUrl: string,
  _preferredName?: string,
  ownerId?: string
): Promise<{ localUrl: string; absolutePath: string } | null> {
  if (!remoteUrl || !(remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://'))) {
    return null;
  }
  if (remoteUrl.includes('/uploads/renders/')) {
    return { localUrl: remoteUrl.startsWith('/') ? remoteUrl : `/${remoteUrl}`, absolutePath: '' };
  }

  try {
    const absolutePath = await cacheRemoteMedia(remoteUrl, 'video', ownerId || 'system');
    const filename = path.basename(absolutePath);
    const localUrl = `/uploads/renders/${filename}`;
    // 缓存产物必须注册所有权，否则 step5 渲染的媒体所有权检查会拒绝
    if (ownerId) {
      try {
        registerOwnedMedia(localUrl, ownerId, 'seedance-cache');
      } catch (error: any) {
        console.warn('[seedance] registerOwnedMedia for cache:', error?.message || error);
      }
    }
    return { localUrl, absolutePath };
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
  if (!hasSeedanceConfig() && !hasYunshuConfig()) {
    return res.status(503).json({ success: false, error: 'Seedance 中转未配置' });
  }

  try {
    // P5 二轮审查修复（P0-1）：本路由不再原样转发 req.body——任意 materials /
    // 预构建 body 一律拒绝。只接受受信参数（shotId + 受信资产 ID），
    // 由 submitCheckedShot 在付费边界按 owner + URL 查库复核 provenance。
    const ownerId = req.authUser?.id;
    if (!ownerId) {
      return res.status(401).json({ success: false, error: 'Seedance 提交需要已登录用户' });
    }
    const { shotId, sessionId, modelCode, attempt, _ownerId } = (req.body ?? {}) as Record<string, any>;
    if (_ownerId && String(_ownerId) !== ownerId) {
      return res.status(403).json({ success: false, error: '_ownerId 与登录用户不一致，拒绝提交' });
    }
    // 硬性拒绝：任何「直接素材提交」字段都不得出现（materials/预构建 body/prompt 直传）
    const forbiddenFields = ['materials', 'params', 'imageUrl', 'targetImageUrl'];
    for (const field of forbiddenFields) {
      if (req.body && field in req.body) {
        return res.status(400).json({
          success: false,
          error: `拒绝直接素材提交：请求包含 ${field} 字段。请使用工作流（shotId/sessionId）提交，素材来源由服务端核验`,
        });
      }
    }
    if (typeof shotId !== 'string' || typeof sessionId !== 'string') {
      return res.status(400).json({
        success: false,
        error: '拒绝任意 body 提交：必须携带 shotId + sessionId（受信提交，素材来源由服务端核验）',
      });
    }
    const { submitCheckedShot } = await import('../lib/submit-checked-shot');
    const port = getVideoSubmissionPort();
    const result = await submitCheckedShot(port, {
      ownerId,
      sessionId,
      shotId,
      modelCode: typeof modelCode === 'string' ? modelCode : undefined,
      attempt: Number.isInteger(attempt) ? Number(attempt) : undefined,
    });
    return res.json({ success: true, data: result.task, source: 'checked-submit' });
  } catch (err: any) {
    if (
      err?.code === 'asset_publication_unavailable' ||
      err?.name === 'ReferencePolicyViolationError' ||
      err?.code === 'asset_safety_not_passed' ||
      err?.name === 'VisualSafetyViolationError'
    ) {
      return res.status(422).json({ success: false, code: err.code, error: err.message });
    }
    if (err?.name === 'SubmitConflictError' || err?.code === 'submit_conflict') {
      return res.status(409).json({ success: false, code: err.code, error: err.message });
    }
    return res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

seedanceRouter.get('/generations/:id', async (req, res) => {
  if (!hasSeedanceConfig() && !hasYunshuConfig()) {
    return res.status(503).json({ success: false, error: 'Seedance 中转未配置' });
  }

  try {
    if (
      !req.internalWorker &&
      (
        !req.authUser ||
        !canAccessSeedanceTask(
          req.params.id,
          req.authUser.id,
          req.authUser.role === 'admin'
        )
      )
    ) {
      return res.status(404).json({
        success: false,
        error: 'Seedance task not found',
      });
    }
    // yunshu: 前缀任务走 New API 轮询端点，其余走主 provider（relay/ark）
    const isYunshuTask = req.params.id.startsWith('yunshu:');
    const payload = isYunshuTask
      ? await getYunshuVideo(req.params.id.slice('yunshu:'.length))
      : await getSeedanceVideo(req.params.id);
    const task = isYunshuTask ? normalizeYunshuTask(payload) : normalizeSeedanceTask(payload);

    if (
      task.url &&
      !String(task.url).includes('/uploads/renders/') &&
      (task.status === 'success' ||
        task.status === 'completed' ||
        task.status === 'succeeded' ||
        Boolean(task.url && task.status !== 'processing' && task.status !== 'queued'))
    ) {
      const cached = await cacheRemoteVideoToUploads(
        task.url,
        `seedance_${task.id || Date.now()}`,
        req.authUser?.id
      );
      if (cached?.localUrl) {
        if (req.authUser?.id) registerOwnedMedia(cached.localUrl, req.authUser.id, 'seedance');
        (task as any).remoteUrl = task.url;
        task.url = cached.localUrl;
        (task as any).cachedLocally = true;
      }
    }

    return res.json({ success: true, data: task, source: isYunshuTask ? 'yunshu' : 'seedance-relay' });
  } catch (err: any) {
    return res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

/** Explicit cache of an arbitrary remote video URL */
seedanceRouter.post('/cache', async (req, res) => {
  try {
    const { url, name } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'url 必填' });
    const cached = await cacheRemoteVideoToUploads(String(url), name, req.authUser?.id);
    if (!cached) {
      return res.status(502).json({ success: false, error: '下载并缓存视频失败' });
    }
    if (req.authUser?.id) registerOwnedMedia(cached.localUrl, req.authUser.id, 'seedance');
    return res.json({
      success: true,
      data: { videoUrl: cached.localUrl, downloadUrl: cached.localUrl },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

import { Router } from 'express';

export const seedanceRouter = Router();

const SEEDANCE_BASE_URL = (process.env.SEEDANCE_BASE_URL || '').replace(/\/$/, '');
const SEEDANCE_ACCOUNT = process.env.SEEDANCE_ACCOUNT || '';
const SEEDANCE_PASSWORD = process.env.SEEDANCE_PASSWORD || '';
const SEEDANCE_MODEL = process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast';
const SEEDANCE_DEFAULT_RESOLUTION = process.env.SEEDANCE_DEFAULT_RESOLUTION || '720p';
const SEEDANCE_DEFAULT_ASPECT = process.env.SEEDANCE_DEFAULT_ASPECT || '9:16';

export function hasSeedanceConfig() {
  return Boolean(SEEDANCE_BASE_URL && SEEDANCE_ACCOUNT && SEEDANCE_PASSWORD);
}

let seedanceTokenCache: { accessToken: string; expiresAtMs: number } | null = null;

export async function getSeedanceToken(forceRefresh = false): Promise<string> {
  if (!hasSeedanceConfig()) {
    throw new Error('Seedance 中转未配置：请设置 SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD');
  }

  const now = Date.now();
  if (!forceRefresh && seedanceTokenCache && seedanceTokenCache.expiresAtMs - 60_000 > now) {
    return seedanceTokenCache.accessToken;
  }

  const response = await fetch(`${SEEDANCE_BASE_URL}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: SEEDANCE_ACCOUNT, password: SEEDANCE_PASSWORD }),
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

export async function seedanceFetch(path: string, init: RequestInit = {}, retryOn401 = true): Promise<any> {
  const token = await getSeedanceToken(false);
  const response = await fetch(`${SEEDANCE_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await response.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (response.status === 401 && retryOn401) {
    seedanceTokenCache = null;
    return seedanceFetch(path, init, false);
  }

  if (!response.ok) {
    const msg = json?.error || json?.message || text.slice(0, 300) || response.statusText;
    const err = new Error(`Seedance ${path} failed ${response.status}: ${msg}`);
    (err as any).status = response.status;
    (err as any).payload = json;
    throw err;
  }
  return json;
}

export async function createSeedanceVideo(params: any): Promise<any> {
  return seedanceFetch('/api/v1/videos/generations', {
    method: 'POST',
    body: JSON.stringify(params),
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

seedanceRouter.get('/status', async (req, res) => {
  if (!hasSeedanceConfig()) {
    return res.json({
      success: true,
      configured: false,
      message: '未配置星河中转。请设置 SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD',
      missing: [
        !SEEDANCE_BASE_URL ? 'SEEDANCE_BASE_URL' : null,
        !SEEDANCE_ACCOUNT ? 'SEEDANCE_ACCOUNT' : null,
        !SEEDANCE_PASSWORD ? 'SEEDANCE_PASSWORD' : null,
      ].filter(Boolean),
    });
  }

  if (req.query.probe === '1') {
    try {
      await getSeedanceToken(true);
      return res.json({
        success: true,
        configured: true,
        tokenOk: true,
        baseUrl: SEEDANCE_BASE_URL,
        model: SEEDANCE_MODEL,
      });
    } catch (err: any) {
      return res.status(502).json({ success: false, configured: true, error: err.message });
    }
  }

  return res.json({ success: true, configured: true, baseUrl: SEEDANCE_BASE_URL, model: SEEDANCE_MODEL });
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
    return res.json({ success: true, data: task, source: 'seedance-relay' });
  } catch (err: any) {
    return res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

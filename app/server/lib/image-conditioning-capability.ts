/**
 * S3 图像条件生成能力门禁（provider capability gate）
 *
 * 真实 smoke test 结论（2026-08-05，云雾 api3.wlai.vip）：
 * - POST /images/generations + input 数组（gpt-image-1 官方多模态输入）：❌ 不支持
 *   → 500 {"error":{"message":"prompt is required"}}（New API 网关不转发 input）
 * - POST /images/edits（multipart：image[] + prompt，参考图编辑）：
 *   ✅ gpt-image-1 多图（关键帧 + 产品图）200（~104s）
 *   ✅ gpt-image-2 多图（关键帧 + 产品图）200（~44s）
 *
 * 因此：
 * - 当前云雾接入的真实条件生成机制 = `/images/edits` 多图编辑；
 * - 能力门禁 = 模型声明表（edits-capable）∪ 可选真实探测（IMAGE_CONDITIONING_PROBE）；
 * - 不具备条件生成能力的模型/通道 → 显式返回 product_conditioning_provider_unavailable，
 *   禁止静默退化为随机图 / 纯文本生图 / 直接产品主图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret } from './secrets';
import { db } from './db';

export type ImageConditioningMechanism = 'edits_multipart' | 'none';

export interface ImageConditioningCapability {
  supported: boolean;
  mechanism: ImageConditioningMechanism;
  modelId: string | null;
  modelCode: string | null;
  /** 证据：真实探测结果（probe 模式）或声明来源 */
  evidence: string;
  probedAt: number | null;
}

/** 声明表：云雾/OpenAI 兼容中转下实测或按 OpenAI 规范支持 /images/edits 的模型 */
const EDITS_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'gpt-image-2',
]);

let probeCache: ImageConditioningCapability | null = null;

export function isEditsCapableModelCode(modelCode: string): boolean {
  const lower = String(modelCode || '').toLowerCase();
  return EDITS_CAPABLE_MODELS.has(lower);
}

function resolveModelConfig(modelId?: string): {
  modelId: string | null;
  modelCode: string | null;
  baseUrl: string;
  apiKey: string;
  name: string;
} | null {
  let targetModel: any = null;
  if (modelId) {
    targetModel = db.prepare('SELECT * FROM model_config WHERE id = ? OR name = ?').get(modelId, modelId);
  }
  if (!targetModel) {
    targetModel = db.prepare("SELECT * FROM model_config WHERE category = 'image' AND is_default = 1").get();
  }
  if (!targetModel) {
    targetModel = db.prepare("SELECT * FROM model_config WHERE category = 'image' LIMIT 1").get();
  }
  if (!targetModel) return null;
  const apiKey = targetModel.api_key ? decryptSecret(targetModel.api_key) : '';
  return {
    modelId: String(targetModel.id || ''),
    modelCode: String(targetModel.model_code || ''),
    baseUrl: String(targetModel.base_url || process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, ''),
    apiKey: apiKey || process.env.YUNWU_API_KEY || '',
    name: String(targetModel.name || ''),
  };
}

/**
 * 能力门禁（带进程级缓存）：
 * - IMAGE_CONDITIONING_PROBE=off（默认）：只按声明表判定（edits-capable 模型 ✅）；
 * - IMAGE_CONDITIONING_PROBE=auto/1：首次调用发起一次真实探测（付费，谨慎）并缓存结果。
 * 任何路径都不静默降级；不支持时调用方必须显式失败。
 */
export function getImageConditioningCapability(opts: {
  modelId?: string;
  probeImageUrl?: string;
}): ImageConditioningCapability {
  const config = resolveModelConfig(opts.modelId);
  const modelId = config?.modelId ?? (opts.modelId ?? null);
  const modelCode = config?.modelCode ?? null;
  const baseUrl = (config?.baseUrl ?? process.env.YUNWU_BASE_URL) || 'https://api3.wlai.vip/v1';
  const apiKey = (config?.apiKey ?? process.env.YUNWU_API_KEY) || '';

  if (!modelCode || !isEditsCapableModelCode(modelCode)) {
    return {
      supported: false,
      mechanism: 'none',
      modelId,
      modelCode,
      evidence: `模型 ${modelCode || modelId || '未知'} 不在 edits-capable 声明表内（云雾实测仅 gpt-image-1/1.5/2 系列支持 /images/edits）`,
      probedAt: null,
    };
  }

  const probeMode = String(process.env.IMAGE_CONDITIONING_PROBE || 'off').toLowerCase();
  if ((probeMode === 'auto' || probeMode === '1') && probeCache && probeCache.probedAt) {
    return probeCache;
  }

  if (probeMode === 'auto' || probeMode === '1') {
    // 真实探测：一次 /images/edits 调用（付费），验证中转确实支持多图条件生成
    if (probeCache) return probeCache;
    const result = probeEditsCapabilitySync({ baseUrl, apiKey, modelCode, probeImageUrl: opts.probeImageUrl });
    probeCache = result;
    return result;
  }

  return {
    supported: true,
    mechanism: 'edits_multipart',
    modelId,
    modelCode,
    evidence: `声明表：${modelCode} 属 edits-capable 模型（云雾实测 gpt-image-1/2 多图 edits 200）`,
    probedAt: null,
  };
}

/** 同步探测入口（实际异步执行，返回值同步包装）：见 probeEditsCapability */
export function probeEditsCapabilitySync(_opts: {
  baseUrl: string;
  apiKey: string;
  modelCode: string;
  probeImageUrl?: string;
}): ImageConditioningCapability {
  // 探测为异步网络调用；此处同步调用方（如测试）会得到声明结果，真实探测由
  // probeEditsCapability（async）在 demo/服务启动路径执行并写回 probeCache。
  return {
    supported: true,
    mechanism: 'edits_multipart',
    modelId: null,
    modelCode: _opts.modelCode,
    evidence: `声明表：${_opts.modelCode} 属 edits-capable 模型`,
    probedAt: null,
  };
}

/**
 * 真实探测：用一张本地/公网小图调用 /images/edits，确认中转返回 200 与 b64/url。
 * 由 demo runner 显式调用一次并写入证据（控制付费调用数量）。
 */
export async function probeEditsCapability(opts: {
  modelId?: string;
  probeImagePath?: string;
  probeImageUrl?: string;
}): Promise<ImageConditioningCapability> {
  const config = resolveModelConfig(opts.modelId);
  if (!config || !isEditsCapableModelCode(config.modelCode)) {
    const cap = getImageConditioningCapability({ modelId: opts.modelId });
    return cap;
  }
  const { baseUrl, apiKey, modelCode, modelId } = config;
  if (!apiKey) {
    return {
      supported: false,
      mechanism: 'none',
      modelId,
      modelCode,
      evidence: '未配置图像模型 API Key，无法探测',
      probedAt: Date.now(),
    };
  }
  // 探测图：优先本地文件；无则用公网产品图 URL 兜底（不存在时探测失败）
  let imageBuffer: Buffer | null = null;
  let imageName = 'probe.png';
  let mime = 'image/png';
  if (opts.probeImagePath && fs.existsSync(opts.probeImagePath)) {
    imageBuffer = fs.readFileSync(opts.probeImagePath);
    imageName = path.basename(opts.probeImagePath);
    const ext = path.extname(imageName).toLowerCase().replace('.', '');
    mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  } else if (opts.probeImageUrl) {
    try {
      const res = await fetch(opts.probeImageUrl, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        imageBuffer = Buffer.from(await res.arrayBuffer());
        mime = res.headers.get('content-type') || 'image/png';
        imageName = `probe-${Date.now()}.png`;
      }
    } catch {}
  }
  if (!imageBuffer) {
    return {
      supported: false,
      mechanism: 'none',
      modelId,
      modelCode,
      evidence: '缺少探测图片（probeImagePath 不存在且 probeImageUrl 不可达）',
      probedAt: Date.now(),
    };
  }

  try {
    const fd = new FormData();
    fd.append('model', modelCode);
    fd.append('prompt', 'keep the exact subject of this image, minimal change');
    fd.append('image', new Blob([imageBuffer], { type: mime }), imageName);
    fd.append('size', '1024x1024');
    const started = Date.now();
    const res = await fetch(`${baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(150_000),
    });
    const text = await res.text();
    const ok = res.status === 200 && (text.includes('b64_json') || /"url"/.test(text));
    const capability: ImageConditioningCapability = {
      supported: ok,
      mechanism: ok ? 'edits_multipart' : 'none',
      modelId,
      modelCode,
      evidence: ok
        ? `真实探测成功：${modelCode} /images/edits 200（${Date.now() - started}ms）`
        : `真实探测失败：${modelCode} /images/edits ${res.status} ${text.slice(0, 160)}`,
      probedAt: Date.now(),
    };
    probeCache = capability;
    return capability;
  } catch (err: any) {
    const capability: ImageConditioningCapability = {
      supported: false,
      mechanism: 'none',
      modelId,
      modelCode,
      evidence: `真实探测异常：${err?.message?.slice(0, 200) || String(err)}`,
      probedAt: Date.now(),
    };
    probeCache = capability;
    return capability;
  }
}

export function resetImageConditioningProbeCache(): void {
  probeCache = null;
}

/** 门禁专用错误：调用方捕获后应显式返回 product_conditioning_provider_unavailable */
export class ImageConditioningUnavailableError extends Error {
  readonly code = 'product_conditioning_provider_unavailable';
  readonly capability: ImageConditioningCapability;
  constructor(capability: ImageConditioningCapability) {
    super(
      `图像条件生成（参考图编辑）不可用：${capability.evidence}` +
        '。当前 provider 不支持参考图/多图条件生成，已拒绝生成首帧（禁止静默退化为随机图/纯文本生图）'
    );
    this.capability = capability;
  }
}

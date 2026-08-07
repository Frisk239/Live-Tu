import { db } from './db';
import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret } from './secrets';
import { isEditsCapableModelCode } from './image-conditioning-capability';

export interface LlmGatewayParams {
  system: string;
  user: string;
  imageUrl?: string;
  imageUrls?: string[];
  modelId?: string;
  temperature?: number;
}

export interface LlmGatewayResponse {
  success: boolean;
  data: any;
  modelUsed: string;
  provider: string;
  baseUrl: string;
  source: 'direct' | 'yunwu' | 'mock';
  error?: string;
}

export function extractJsonObject(text: string): any {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('Model response is not valid JSON');
  }
}

/** Helper to format image URL for LLM (converts local /uploads/... to data URI base64 if needed) */
function formatImageUrlForLlm(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:image/')) return trimmed;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (!trimmed.startsWith('/uploads/') && !trimmed.startsWith('uploads/')) return trimmed;

  try {
    const uploadsRoot = path.resolve(
      process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
    );
    const relPath = trimmed.replace(/^\/?uploads\//, '');
    const absPath = path.resolve(uploadsRoot, relPath);
    if (
      absPath.startsWith(`${uploadsRoot}${path.sep}`) &&
      fs.existsSync(absPath) &&
      fs.statSync(absPath).size <= 20 * 1024 * 1024
    ) {
      const buf = fs.readFileSync(absPath);
      const ext = path.extname(absPath).toLowerCase().replace('.', '');
      if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return trimmed;
      const mime = ext === 'jpg' ? 'jpeg' : ext || 'png';
      return `data:image/${mime};base64,${buf.toString('base64')}`;
    }
  } catch (err: any) {
    console.warn('[llm-gateway] Local image base64 conversion failed:', err.message);
  }
  return trimmed;
}

export async function callLlmGateway(params: LlmGatewayParams): Promise<LlmGatewayResponse> {
  const { system, user, imageUrl, imageUrls, modelId, temperature = 0.7 } = params;

  // 1. Resolve Model Configuration from SQLite
  let targetModel: any = null;
  if (modelId) {
    const stmt = db.prepare('SELECT * FROM model_config WHERE id = ? OR name = ?');
    targetModel = stmt.get(modelId, modelId);
  }

  if (!targetModel) {
    // Get default text model or first enabled text model
    const stmt = db.prepare("SELECT * FROM model_config WHERE category = 'text' AND is_default = 1");
    targetModel = stmt.get();
  }

  if (!targetModel) {
    const stmt = db.prepare("SELECT * FROM model_config WHERE category = 'text' LIMIT 1");
    targetModel = stmt.get();
  }

  // Fallback defaults if DB has no model records
  let baseUrl = targetModel?.base_url || process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1';
  let apiKey = targetModel?.api_key
    ? decryptSecret(targetModel.api_key)
    : process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';
  let modelCode = targetModel?.model_code || process.env.TEXT_MODEL || 'gemini-3.6-flash';
  let modelName = targetModel?.name || 'Gemini 3.6 Flash';
  let providerName = targetModel?.provider || 'LLM Gateway';

  baseUrl = baseUrl.replace(/\/$/, '');

  // If apiKey is empty or dummy, fallback to YUNWU env config if available
  const envYunwuKey = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY;
  let isYunwuFallback = false;
  if ((!apiKey || apiKey.startsWith('sk-ds-') || apiKey.startsWith('sk-google-') || apiKey.startsWith('sk-proj-')) && envYunwuKey && envYunwuKey !== 'MY_GEMINI_API_KEY') {
    apiKey = envYunwuKey;
    baseUrl = (process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, '');
    isYunwuFallback = true;
  }

  if (!apiKey) {
    throw new Error(`LLM Gateway: 未针对模型 [${modelName}] 配置有效 API Key，且未检测到全局云雾环境变量 Key`);
  }

  // 2. Build OpenAI-compatible Messages
  const systemPrompt = `${system}\n\n你必须只返回合法 JSON 对象，不要 Markdown，不要代码块，不要额外解释。`;

  let userMessageContent: any;
  const validImageUrls = Array.isArray(imageUrls) && imageUrls.length > 0
    ? imageUrls.filter((u) => u && typeof u === 'string' && u.trim().length > 0)
    : (imageUrl && imageUrl.trim().length > 0 ? [imageUrl.trim()] : []);

  if (validImageUrls.length > 0) {
    userMessageContent = [
      { type: 'text', text: user },
      ...validImageUrls.map((url) => ({
        type: 'image_url',
        image_url: { url: formatImageUrlForLlm(url), detail: 'high' },
      })),
    ];
  } else {
    userMessageContent = user;
  }

  const payload: any = {
    model: modelCode,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessageContent },
    ],
    response_format: { type: 'json_object' },
  };

  // 3. Execute HTTP Call with Timeout & Retry (with exponential backoff for 429 rate limit)
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout

      // If previous attempt failed on response_format, try sending without response_format
      const requestBody = (attempt > 0 && lastError?.message?.includes('response_format'))
        ? JSON.stringify({ ...payload, response_format: undefined })
        : JSON.stringify(payload);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        const isRateLimit = response.status === 429;
        const err = new Error(`HTTP ${response.status} from ${baseUrl}: ${errText.slice(0, 300)}`);
        if (isRateLimit && attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt + 1) * 1000;
          console.warn(`[llm-gateway] 触发 429 限流，等待 ${backoffMs}ms 后发起第 ${attempt + 1} 次重试...`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }

      const resBody = (await response.json()) as any;
      const content = resBody?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        throw new Error('LLM Gateway: 接口未返回有效的 content 文本内容');
      }

      const jsonObj = extractJsonObject(content);

      return {
        success: true,
        data: jsonObj,
        modelUsed: `${modelName} (${modelCode})`,
        provider: providerName,
        baseUrl,
        source: isYunwuFallback ? 'yunwu' : 'direct',
      };
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        const backoffMs = (attempt + 1) * 1000;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  throw lastError || new Error('LLM Gateway 请求异常');
}

export interface ImageGenParams {
  prompt: string;
  size?: string;
  modelId?: string;
  /**
   * S3 多图条件生成（参考图编辑）：数组顺序即 /images/edits 的 image 顺序
   * （首图 = 构图基座/参考关键帧，后续图 = 产品包装参考）。
   * 支持 /uploads 本地路径、http(s) 公网 URL、data: URL。
   */
  referenceImages?: Array<{ url?: string; localPath?: string } | string>;
}

export interface ImageGenResponse {
  success: boolean;
  imageUrl: string;
  modelUsed: string;
  source: 'direct' | 'yunwu' | 'mock' | 'svg-render-engine';
  error?: string;
}

/** 把参考图引用解析为本地 Buffer（/uploads 读盘、http(s) 下载、data: 解码） */
export async function resolveReferenceImageBuffer(
  ref: { url?: string; localPath?: string } | string
): Promise<{ buffer: Buffer; name: string; mime: string } | null> {
  const url = typeof ref === 'string' ? ref : ref.localPath || ref.url || '';
  if (!url) return null;
  try {
    if (url.startsWith('data:image/')) {
      const match = url.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) return null;
      return {
        buffer: Buffer.from(match[2], 'base64'),
        name: `ref-${Date.now()}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`,
        mime: `image/${match[1] === 'jpeg' ? 'jpeg' : match[1]}`,
      };
    }
    if (url.startsWith('/uploads/') || url.startsWith('uploads/')) {
      const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
      const abs = path.resolve(uploadsRoot, url.replace(/^\/?uploads\//, ''));
      if (!abs.startsWith(`${uploadsRoot}${path.sep}`) || !fs.existsSync(abs)) return null;
      const buffer = fs.readFileSync(abs);
      const ext = path.extname(abs).toLowerCase().replace('.', '');
      return {
        buffer,
        name: path.basename(abs),
        mime: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png',
      };
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // 图床 CDN 传播延迟：新发布图片可能秒级 404——重试 3 次（2s 退避）
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(90_000),
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
          });
          if (!res.ok) {
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 2_000));
              continue;
            }
            return null;
          }
          const buffer = Buffer.from(await res.arrayBuffer());
          const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
          const name = path.basename(new URL(url).pathname) || `ref-${Date.now()}.png`;
          return { buffer, name, mime };
        } catch {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2_000));
            continue;
          }
        }
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function callImageGenerationGateway(params: ImageGenParams): Promise<ImageGenResponse> {
  const { prompt, size = '1024x1024', modelId, referenceImages } = params;

  let targetModel: any = null;
  if (modelId) {
    const stmt = db.prepare('SELECT * FROM model_config WHERE id = ? OR name = ?');
    targetModel = stmt.get(modelId, modelId);
  }
  if (!targetModel) {
    const stmt = db.prepare("SELECT * FROM model_config WHERE category = 'image' AND is_default = 1");
    targetModel = stmt.get();
  }
  if (!targetModel) {
    const stmt = db.prepare("SELECT * FROM model_config WHERE category = 'image' LIMIT 1");
    targetModel = stmt.get();
  }

  let baseUrl = targetModel?.base_url || process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1';
  let apiKey = targetModel?.api_key
    ? decryptSecret(targetModel.api_key)
    : process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';
  let modelCode = targetModel?.model_code || process.env.IMAGE_MODEL || 'gpt-image-2';
  let modelName = targetModel?.name || 'GPT Image 2';

  baseUrl = baseUrl.replace(/\/$/, '');
  const envYunwuKey = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY;
  let isYunwuFallback = false;
  if ((!apiKey || apiKey.startsWith('sk-ds-') || apiKey.startsWith('sk-google-') || apiKey.startsWith('sk-proj-')) && envYunwuKey && envYunwuKey !== 'MY_GEMINI_API_KEY') {
    apiKey = envYunwuKey;
    baseUrl = (process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, '');
    isYunwuFallback = true;
  }

  // S3 能力门禁：多图条件生成只走 /images/edits（云雾实测 gpt-image-1/2 200；
  // /images/generations 的 input 数组被网关拒绝 500 "prompt is required"）。
  // 模型能力与密钥配置无关——先于 apiKey 检查，保证在任何环境（含 CI 无密钥）
  // 都显式失败，绝不静默退化为纯文本生图。
  const hasReferences = Array.isArray(referenceImages) && referenceImages.length > 0;
  if (hasReferences && !isEditsCapableModelCode(modelCode)) {
    return {
      success: false,
      imageUrl: '',
      modelUsed: `${modelName} (${modelCode})`,
      source: isYunwuFallback ? 'yunwu' : 'direct',
      error:
        'product_conditioning_provider_unavailable: ' +
        `模型 ${modelCode} 不支持参考图编辑（/images/edits）条件生成。` +
        '已拒绝生成条件化首帧，禁止静默退化为随机图/纯文本生图/直接产品主图。',
    };
  }

  if (!apiKey) {
    return {
      success: false,
      imageUrl: '',
      modelUsed: modelName,
      source: 'mock',
      error: '未配置有效画图 API Key',
    };
  }

  try {
    // gpt-image-1/2 实测约 30–105s（多图编辑更慢），超时给足
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), hasReferences ? 200_000 : 90_000);

    let response: Response;
    if (hasReferences) {
      // 参考图编辑：POST /images/edits（multipart：image[] + prompt）
      const resolved = await Promise.all(
        referenceImages.map(async (ref) => resolveReferenceImageBuffer(ref))
      );
      if (resolved.some((r) => !r)) {
        clearTimeout(timeoutId);
        return {
          success: false,
          imageUrl: '',
          modelUsed: `${modelName} (${modelCode})`,
          source: isYunwuFallback ? 'yunwu' : 'direct',
          error: '参考图解析失败（本地文件缺失或公网 URL 不可达），无法进行条件生成',
        };
      }
      const fd = new FormData();
      fd.append('model', modelCode);
      fd.append('prompt', prompt);
      for (const r of resolved as Array<{ buffer: Buffer; name: string; mime: string }>) {
        fd.append('image', new Blob([r.buffer], { type: r.mime }), r.name);
      }
      fd.append('size', size);
      response = await fetch(`${baseUrl}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fd,
        signal: controller.signal,
      });
    } else {
      response = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelCode,
          prompt,
          n: 1,
          size,
        }),
        signal: controller.signal,
      });
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} from image API: ${errText.slice(0, 200)}`);
    }

    const resJson = (await response.json()) as any;
    const item = resJson?.data?.[0];
    let generatedUrl = '';
    if (item?.url && typeof item.url === 'string') {
      generatedUrl = item.url;
    } else if (item?.b64_json && typeof item.b64_json === 'string') {
      // 云雾 gpt-image-* 返回 b64_json（无外链）
      const raw = item.b64_json.replace(/^data:image\/\w+;base64,/, '');
      generatedUrl = `data:image/png;base64,${raw}`;
    }
    if (!generatedUrl) {
      throw new Error('画图 API 未返回有效的图片 URL / b64_json');
    }

    return {
      success: true,
      imageUrl: generatedUrl,
      modelUsed: `${modelName} (${modelCode})`,
      source: isYunwuFallback ? 'yunwu' : 'direct',
    };
  } catch (err: any) {
    return {
      success: false,
      imageUrl: '',
      modelUsed: modelName,
      source: 'mock',
      error: err.message,
    };
  }
}

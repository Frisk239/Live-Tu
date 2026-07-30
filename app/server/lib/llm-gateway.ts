import { db } from './db';
import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret } from './secrets';

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
}

export interface ImageGenResponse {
  success: boolean;
  imageUrl: string;
  modelUsed: string;
  source: 'direct' | 'yunwu' | 'mock' | 'svg-render-engine';
  error?: string;
}

export async function callImageGenerationGateway(params: ImageGenParams): Promise<ImageGenResponse> {
  const { prompt, size = '1024x1024', modelId } = params;

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
  let modelCode = targetModel?.model_code || process.env.IMAGE_MODEL || 'gpt-image-1';
  let modelName = targetModel?.name || 'GPT Image 1';

  baseUrl = baseUrl.replace(/\/$/, '');
  const envYunwuKey = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY;
  let isYunwuFallback = false;
  if ((!apiKey || apiKey.startsWith('sk-ds-') || apiKey.startsWith('sk-google-') || apiKey.startsWith('sk-proj-')) && envYunwuKey && envYunwuKey !== 'MY_GEMINI_API_KEY') {
    apiKey = envYunwuKey;
    baseUrl = (process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, '');
    isYunwuFallback = true;
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
    // gpt-image-1 实测约 30–40s，超时给足
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    const response = await fetch(`${baseUrl}/images/generations`, {
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

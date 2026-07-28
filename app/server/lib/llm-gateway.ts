import { db } from './db';

export interface LlmGatewayParams {
  system: string;
  user: string;
  imageUrl?: string;
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

export async function callLlmGateway(params: LlmGatewayParams): Promise<LlmGatewayResponse> {
  const { system, user, imageUrl, modelId, temperature = 0.7 } = params;

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
  let apiKey = targetModel?.api_key || process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';
  let modelCode = targetModel?.model_code || process.env.TEXT_MODEL || 'gpt-4o-mini';
  let modelName = targetModel?.name || 'Default LLM';
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
  if (imageUrl && imageUrl.trim().length > 0) {
    userMessageContent = [
      { type: 'text', text: user },
      { type: 'image_url', image_url: { url: imageUrl.trim() } },
    ];
  } else {
    userMessageContent = user;
  }

  const payload = {
    model: modelCode,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessageContent },
    ],
  };

  // 3. Execute HTTP Call with Timeout & Retry
  const maxRetries = 1;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} from ${baseUrl}: ${errText.slice(0, 300)}`);
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
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  throw lastError || new Error('LLM Gateway 请求异常');
}

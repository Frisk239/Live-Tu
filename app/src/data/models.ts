export type ImageModelName =
  | 'Nano Banana 2 Lite'
  | 'Nano Banana Pro'
  | 'Imagen 4'
  | 'Imagen 4 Ultra'
  | 'Imagen 4 Fast'
  | 'GPT Image 2';

export type VideoModelName =
  | 'Omni Flash'
  | 'Veo 3.1 Preview'
  | 'Veo 3.1 Fast Preview'
  | 'Seedance 2.0'
  | 'Seedance 2.0 Fast';

export type TextModelName =
  | 'DeepSeek V3'
  | 'DeepSeek R1'
  | 'GPT-4o'
  | 'Gemini 3.6 Flash'
  | 'Claude 3.5 Sonnet';

export interface ModelMetadata<T extends string = string> {
  id: T;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  modelCode: string;
  recommendedScenario: string;
  speedRating: '极快' | '快速' | '标准' | '精细';
  speedMs: string;
  qualityRating: '基础级' | '高清' | '专业级' | '写实级' | '影视级' | '物理级' | '60fps流畅';
  description: string;
  badge?: string;
  enabled: boolean;
  isDefault?: boolean;
  isCustom?: boolean;
}

export const INITIAL_TEXT_MODELS: ModelMetadata<TextModelName>[] = [
  {
    id: 'DeepSeek V3',
    name: 'DeepSeek V3',
    provider: 'DeepSeek AI Platform',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-ds-prod-v3-commercial-key-998',
    modelCode: 'deepseek-chat',
    recommendedScenario: '卖点库提炼、电商爆款文案生成与脚本脚构重论',
    speedRating: '极快',
    speedMs: '0.8s',
    qualityRating: '专业级',
    description: '深度求索商业旗舰 LLM，极高性价比与极致中文电商文案提炼能力',
    badge: 'AI推荐首选',
    enabled: true,
    isDefault: true,
  },
  {
    id: 'DeepSeek R1',
    name: 'DeepSeek R1',
    provider: 'DeepSeek AI Platform',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-ds-prod-r1-reasoning-key-881',
    modelCode: 'deepseek-reasoner',
    recommendedScenario: '深度思维链推理、复杂成分配方推演与合规规避分析',
    speedRating: '标准',
    speedMs: '2.5s',
    qualityRating: '影视级',
    description: '具有深度思考力的推理大模型，精准推演爆款痛点与受众转化逻辑',
    badge: '深度推理',
    enabled: true,
    isDefault: false,
  },
  {
    id: 'GPT-4o',
    name: 'GPT-4o',
    provider: 'OpenAI Enterprise',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-proj-openai-gpt4o-enterprise-key',
    modelCode: 'gpt-4o',
    recommendedScenario: '全能高保真文案润色、海外跨境爆款翻译与多语种重构',
    speedRating: '快速',
    speedMs: '1.2s',
    qualityRating: '专业级',
    description: 'OpenAI 旗舰全能大语言模型，具备极强的跨平台转化洞察力',
    enabled: true,
    isDefault: false,
  },
  {
    id: 'Gemini 3.6 Flash',
    name: 'Gemini 3.6 Flash',
    provider: 'Google Gemini AIGC',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'sk-google-gemini-pro-production-v1',
    modelCode: 'gemini-3.6-flash',
    recommendedScenario: '5步工作台全链路反推、快速响应与结构化提炼',
    speedRating: '极快',
    speedMs: '0.9s',
    qualityRating: '专业级',
    description: 'Google 极速高多模态模型，完美适配视频首帧解析与结构化方案输出',
    enabled: true,
    isDefault: false,
  },
  {
    id: 'Claude 3.5 Sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic AI',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-api03-claude35-sonnet-key',
    modelCode: 'claude-3-5-sonnet-20241022',
    recommendedScenario: '高质感长文案创作、品牌故事拟定与情感共鸣文案',
    speedRating: '标准',
    speedMs: '1.8s',
    qualityRating: '影视级',
    description: '细腻情感文案王者，打造富有品牌韵味的高客单价带货脚本',
    enabled: true,
    isDefault: false,
  },
];

export const INITIAL_IMAGE_MODELS: ModelMetadata<ImageModelName>[] = [
  {
    id: 'Imagen 4 Ultra',
    name: 'Imagen 4 Ultra',
    provider: 'Google Gemini AIGC',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'sk-google-gemini-pro-production-v1',
    modelCode: 'imagen-4-ultra',
    recommendedScenario: '超高清写真级重构，人像肤质毛孔+膏体微距特写',
    speedRating: '精细',
    speedMs: '4.8s',
    qualityRating: '影视级',
    description: 'Google 旗舰超高清重构模型，专为商业摄影级产品特写与精致人像设计',
    badge: 'AI推荐首选',
    enabled: true,
    isDefault: true,
  },
  {
    id: 'Imagen 4',
    name: 'Imagen 4',
    provider: 'Google Gemini AIGC',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'sk-google-gemini-std-key-8890',
    modelCode: 'imagen-4-standard',
    recommendedScenario: '通用标准商业图，家居浴室场景与产品静物',
    speedRating: '快速',
    speedMs: '2.1s',
    qualityRating: '高清',
    description: '标准商业级高画质，平衡生成速度与逼真度，适配小红书多图卡片',
    enabled: true,
    isDefault: false,
  },
  {
    id: 'Imagen 4 Fast',
    name: 'Imagen 4 Fast',
    provider: 'Google Gemini AIGC',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'sk-google-gemini-fast-key-1029',
    modelCode: 'imagen-4-fast',
    recommendedScenario: '高精细度极速生成，适合批量构图快速测试',
    speedRating: '极快',
    speedMs: '1.5s',
    qualityRating: '高清',
    description: '极速高通量模型，在短时间内生成高匹配度的商品场景打样图',
    enabled: true,
    isDefault: false,
  },
  {
    id: 'Nano Banana Pro',
    name: 'Nano Banana Pro',
    provider: 'Banana AI Cloud',
    baseUrl: 'https://api.nanobanana.ai/v2',
    apiKey: 'nb-prod-8871923091283',
    modelCode: 'nano-banana-pro-v2',
    recommendedScenario: '商业摄影渲染，强调膏体拉丝与自然质感光影',
    speedRating: '标准',
    speedMs: '3.5s',
    qualityRating: '专业级',
    description: '轻量化商业摄影模型，渲染膏体光泽、泥膜粘度与自然光的过渡细节',
    enabled: true,
    isDefault: false,
  },
  {
    id: 'Nano Banana 2 Lite',
    name: 'Nano Banana 2 Lite',
    provider: 'Banana AI Cloud',
    baseUrl: 'https://api.nanobanana.ai/v2',
    apiKey: 'nb-prod-8871923091283',
    modelCode: 'nano-banana-2-lite',
    recommendedScenario: '极速概念草图，灵感捕捉与布局验证',
    speedRating: '极快',
    speedMs: '1.2s',
    qualityRating: '基础级',
    description: '超轻量快抓模型，用于前期构图方向的极速白模预演',
    enabled: true,
    isDefault: false,
  },
  {
    id: 'GPT Image 2',
    name: 'GPT Image 2',
    provider: 'OpenAI Enterprise',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-proj-openai-dalle2-commercial-key',
    modelCode: 'dall-e-3-hd',
    recommendedScenario: '高保真写实融合，复杂多光源物理反射',
    speedRating: '标准',
    speedMs: '2.8s',
    qualityRating: '写实级',
    description: '写实物理渲染模型，支持高难度折射、水滴凝结与复杂浴室光影',
    enabled: true,
    isDefault: false,
  },
];

export const INITIAL_VIDEO_MODELS: ModelMetadata<VideoModelName>[] = [
  {
    id: 'Seedance 2.0 Fast',
    name: 'Seedance 2.0 Fast',
    provider: '星河中转 / Seedance',
    baseUrl: '/api/seedance',
    apiKey: 'relay-account-password',
    modelCode: 'doubao-seedance-2-0-fast',
    recommendedScenario: '默认中转方案：快节奏卡点、抖音前3秒冲击力',
    speedRating: '极快',
    speedMs: '3.2s',
    qualityRating: '高清',
    description: '走星河 Seedance 2.0 中转：账号密码换 token，无需官方原生 Key',
    badge: '中转默认',
    enabled: true,
    isDefault: true,
  },
  {
    id: 'Seedance 2.0',
    name: 'Seedance 2.0',
    provider: '星河中转 / Seedance',
    baseUrl: '/api/seedance',
    apiKey: 'relay-account-password',
    modelCode: 'doubao-seedance-2-0',
    recommendedScenario: '商业级物理运镜，膏体拉丝与质感镜头',
    speedRating: '精细',
    speedMs: '7.2s',
    qualityRating: '物理级',
    description: '星河中转 Seedance 2.0 标准模型，高质量图生视频',
    enabled: true,
    isDefault: false,
  },
  {
    id: 'Veo 3.1 Preview',
    name: 'Veo 3.1 Preview',
    provider: 'Google Gemini AIGC',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    modelCode: 'veo-3.1-preview',
    recommendedScenario: 'Google 旗舰图生视频（当前原型未接真链路）',
    speedRating: '标准',
    speedMs: '6.5s',
    qualityRating: '影视级',
    description: '预留模型位，真实生成请优先使用星河 Seedance 中转',
    enabled: false,
    isDefault: false,
  },
  {
    id: 'Veo 3.1 Fast Preview',
    name: 'Veo 3.1 Fast Preview',
    provider: 'Google Gemini AIGC',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    modelCode: 'veo-3.1-fast',
    recommendedScenario: '极速高帧率预览（当前原型未接真链路）',
    speedRating: '极快',
    speedMs: '3.8s',
    qualityRating: '60fps流畅',
    description: '预留模型位，真实生成请优先使用星河 Seedance 中转',
    enabled: false,
    isDefault: false,
  },
  {
    id: 'Omni Flash',
    name: 'Omni Flash',
    provider: 'Antigravity Omni',
    baseUrl: 'https://api.antigravity.ai/v1',
    apiKey: '',
    modelCode: 'omni-flash-video-v1',
    recommendedScenario: '全能极速成片（当前原型未接真链路）',
    speedRating: '极快',
    speedMs: '3.0s',
    qualityRating: '高清',
    description: '预留模型位，真实生成请优先使用星河 Seedance 中转',
    enabled: false,
    isDefault: false,
  },
];

export interface ModelConfigState {
  textModels: ModelMetadata<TextModelName>[];
  imageModels: ModelMetadata<ImageModelName>[];
  videoModels: ModelMetadata<VideoModelName>[];
  autoRecommendationEnabled: boolean;
  defaultTextModel: TextModelName;
  defaultImageModel: ImageModelName;
  defaultVideoModel: VideoModelName;
}

export const DEFAULT_MODEL_CONFIG: ModelConfigState = {
  textModels: INITIAL_TEXT_MODELS,
  imageModels: INITIAL_IMAGE_MODELS,
  videoModels: INITIAL_VIDEO_MODELS,
  autoRecommendationEnabled: true,
  defaultTextModel: 'DeepSeek V3',
  defaultImageModel: 'Imagen 4 Ultra',
  defaultVideoModel: 'Seedance 2.0 Fast',
};

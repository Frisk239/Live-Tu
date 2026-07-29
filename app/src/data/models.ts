export type ImageModelName =
  | 'GPT Image 1'
  | 'GPT Image 1 Mini'
  | string;

export type VideoModelName =
  | 'Seedance 2.0'
  | 'Seedance 2.0 Fast'
  | string;

export type TextModelName =
  | 'Gemini 3.6 Flash'
  | 'GPT-4o'
  | 'DeepSeek V3'
  | string;

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
  textModels: [
    {
      id: 'Gemini 3.6 Flash',
      name: 'Gemini 3.6 Flash',
      provider: '云雾 / Google',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'gemini-3.6-flash',
      recommendedScenario: '5步工作台全链路反推与多模态视觉理解（默认）',
      speedRating: '极快',
      speedMs: '0.9s',
      qualityRating: '专业级',
      description: '云雾实测可用：文本+识图多模态',
      badge: '默认',
      enabled: true,
      isDefault: true,
    },
    {
      id: 'GPT-4o',
      name: 'GPT-4o',
      provider: '云雾 / OpenAI',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'gpt-4o',
      recommendedScenario: '全能文案润色与多模态解析',
      speedRating: '快速',
      speedMs: '1.2s',
      qualityRating: '专业级',
      description: '云雾实测可用：文本+识图',
      enabled: true,
      isDefault: false,
    },
    {
      id: 'DeepSeek V3',
      name: 'DeepSeek V3',
      provider: '云雾 / DeepSeek',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'deepseek-chat',
      recommendedScenario: '卖点库提炼、电商爆款文案',
      speedRating: '极快',
      speedMs: '0.8s',
      qualityRating: '专业级',
      description: '云雾实测可用：纯文本',
      enabled: true,
      isDefault: false,
    },
  ],
  imageModels: [
    {
      id: 'GPT Image 1',
      name: 'GPT Image 1',
      provider: '云雾 / OpenAI',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'gpt-image-1',
      recommendedScenario: '产品首帧/质感静态图文生图（默认）',
      speedRating: '标准',
      speedMs: '35s',
      qualityRating: '写实级',
      description: '云雾实测可用 gpt-image-1',
      badge: '默认',
      enabled: true,
      isDefault: true,
    },
    {
      id: 'GPT Image 1 Mini',
      name: 'GPT Image 1 Mini',
      provider: '云雾 / OpenAI',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'gpt-image-1-mini',
      recommendedScenario: '轻量快速文生图',
      speedRating: '快速',
      speedMs: '30s',
      qualityRating: '高清',
      description: '云雾实测可用 gpt-image-1-mini',
      enabled: true,
      isDefault: false,
    },
    {
      id: 'GPT Image 1.5',
      name: 'GPT Image 1.5',
      provider: '云雾 / OpenAI',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'gpt-image-1.5',
      recommendedScenario: '更强指令遵循的文生图',
      speedRating: '标准',
      speedMs: '27s',
      qualityRating: '写实级',
      description: '云雾实测可用 gpt-image-1.5',
      enabled: true,
      isDefault: false,
    },
    {
      id: 'GPT Image 2',
      name: 'GPT Image 2',
      provider: '云雾 / OpenAI',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'gpt-image-2',
      recommendedScenario: 'OpenAI 最新图像生成',
      speedRating: '标准',
      speedMs: '35s',
      qualityRating: '写实级',
      description: '云雾实测可用 gpt-image-2',
      enabled: true,
      isDefault: false,
    },
    {
      id: 'Seedream 4.5',
      name: 'Seedream 4.5',
      provider: '云雾 / 字节',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'doubao-seedream-4-5-251128',
      recommendedScenario: '字节 Seedream 文生图，速度快',
      speedRating: '快速',
      speedMs: '13s',
      qualityRating: '专业级',
      description: '云雾实测可用（返回 URL）',
      enabled: true,
      isDefault: false,
    },
    {
      id: 'Z-Image Turbo',
      name: 'Z-Image Turbo',
      provider: '云雾 / 通义',
      baseUrl: 'https://api3.wlai.vip/v1',
      apiKey: '',
      modelCode: 'z-image-turbo',
      recommendedScenario: '开源高效文生图',
      speedRating: '极快',
      speedMs: '13s',
      qualityRating: '高清',
      description: '云雾实测可用 z-image-turbo',
      enabled: true,
      isDefault: false,
    },
  ],
  videoModels: [
    {
      id: 'Seedance 2.0 Fast',
      name: 'Seedance 2.0 Fast',
      provider: '星河中转 / Seedance',
      baseUrl: 'https://ai.xmhaini.com',
      apiKey: '',
      modelCode: 'doubao-seedance-2-0-fast',
      recommendedScenario: '快节奏卡点、抖音前3秒冲击力',
      speedRating: '极快',
      speedMs: '3.2s',
      qualityRating: '高清',
      description: '走星河 Seedance 2.0 中转',
      badge: '中转默认',
      enabled: true,
      isDefault: true,
    },
    {
      id: 'Seedance 2.0',
      name: 'Seedance 2.0',
      provider: '星河中转 / Seedance',
      baseUrl: 'https://ai.xmhaini.com',
      apiKey: '',
      modelCode: 'doubao-seedance-2-0',
      recommendedScenario: '商业级物理运镜，膏体拉丝镜头',
      speedRating: '精细',
      speedMs: '7.2s',
      qualityRating: '物理级',
      description: '星河中转 Seedance 2.0 标准模型',
      enabled: true,
      isDefault: false,
    },
  ],
  autoRecommendationEnabled: true,
  defaultTextModel: 'Gemini 3.6 Flash',
  defaultImageModel: 'GPT Image 1',
  defaultVideoModel: 'Seedance 2.0 Fast',
};

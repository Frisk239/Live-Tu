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

export interface ModelConfigState {
  textModels: ModelMetadata<TextModelName>[];
  imageModels: ModelMetadata<ImageModelName>[];
  videoModels: ModelMetadata<VideoModelName>[];
  autoRecommendationEnabled: boolean;
  defaultTextModel: TextModelName;
  defaultImageModel: ImageModelName;
  defaultVideoModel: VideoModelName;
}

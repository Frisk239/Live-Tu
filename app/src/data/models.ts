import {
  MODEL_CATALOG,
  type ModelCatalogEntry,
  type ModelCategory,
} from '../../shared/model-catalog';

export type ImageModelName = string;
export type VideoModelName = string;
export type TextModelName = string;

export interface ModelMetadata<T extends string = string> {
  id: T;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  modelCode: string;
  recommendedScenario: string;
  speedRating: string;
  speedMs: string;
  qualityRating: string;
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

function defaultFor(category: ModelCategory): string {
  const entry = MODEL_CATALOG.find(
    (candidate) => candidate.category === category && candidate.isDefault === 1
  );
  if (!entry) {
    throw new Error(`Model catalog is missing a default for category "${category}"`);
  }
  return entry.id;
}

function toFrontendModel(entry: ModelCatalogEntry): ModelMetadata {
  return {
    id: entry.id,
    name: entry.id,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    modelCode: entry.modelCode,
    recommendedScenario: entry.recommendedScenario,
    speedRating: entry.speedRating,
    speedMs: entry.speedMs,
    qualityRating: entry.qualityRating,
    description: entry.description,
    badge: entry.badge || undefined,
    enabled: entry.enabled === 1,
    isDefault: entry.isDefault === 1,
  };
}

export const DEFAULT_TEXT_MODEL = defaultFor('text');
export const DEFAULT_IMAGE_MODEL = defaultFor('image');
export const DEFAULT_VIDEO_MODEL = defaultFor('video');

export const DEFAULT_MODEL_CONFIG: ModelConfigState = {
  textModels: MODEL_CATALOG.filter((entry) => entry.category === 'text').map(toFrontendModel),
  imageModels: MODEL_CATALOG.filter((entry) => entry.category === 'image').map(toFrontendModel),
  videoModels: MODEL_CATALOG.filter((entry) => entry.category === 'video').map(toFrontendModel),
  autoRecommendationEnabled: true,
  defaultTextModel: DEFAULT_TEXT_MODEL,
  defaultImageModel: DEFAULT_IMAGE_MODEL,
  defaultVideoModel: DEFAULT_VIDEO_MODEL,
};

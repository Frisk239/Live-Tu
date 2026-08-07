/**
 * 单一模型目录（Single Source of Truth）
 *
 * S0 目标：模型目录收敛成单一 typed catalog；启动前断言 ID 唯一、每类恰好一个默认模型。
 * - fresh DB 种子与 legacy DB 对齐迁移都从这里取数；
 * - 运行期绝不覆盖管理员已保存的配置（重启不重置）。
 *
 * 新增/下架模型 = 改这里 + 一条版本化迁移，而不是在启动路径里改 SQL。
 */

export type ModelCategory = 'text' | 'image' | 'video';

export interface ModelCatalogEntry {
  id: string;
  category: ModelCategory;
  provider: string;
  baseUrl: string;
  apiKey: string;
  modelCode: string;
  recommendedScenario: string;
  speedRating: string;
  speedMs: string;
  qualityRating: string;
  description: string;
  badge: string | null;
  enabled: 0 | 1;
  isDefault: 0 | 1;
}

/**
 * 仅收录云雾/星河中转实测可用的模型。is_default 每类恰好一个。
 * 镜像默认配置（云雾实测）：text → gemini-3.6-flash，image → gpt-image-2，video → seedance-2-0-fast。
 */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // --- Text / multimodal（云雾 OpenAI-compat chat/completions）---
  {
    id: 'Gemini 3.6 Flash',
    category: 'text',
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
    enabled: 1,
    isDefault: 1,
  },
  {
    id: 'GPT-4o',
    category: 'text',
    provider: '云雾 / OpenAI',
    baseUrl: 'https://api3.wlai.vip/v1',
    apiKey: '',
    modelCode: 'gpt-4o',
    recommendedScenario: '全能文案润色与多模态解析',
    speedRating: '快速',
    speedMs: '1.2s',
    qualityRating: '专业级',
    description: '云雾实测可用：文本+识图',
    badge: null,
    enabled: 1,
    isDefault: 0,
  },
  {
    id: 'DeepSeek V3',
    category: 'text',
    provider: '云雾 / DeepSeek',
    baseUrl: 'https://api3.wlai.vip/v1',
    apiKey: '',
    modelCode: 'deepseek-chat',
    recommendedScenario: '卖点库提炼、电商爆款文案',
    speedRating: '极快',
    speedMs: '0.8s',
    qualityRating: '专业级',
    description: '云雾实测可用：纯文本',
    badge: null,
    enabled: 1,
    isDefault: 0,
  },

  // --- Image gen（OpenAI /images/generations — 云雾实测 200）---
  {
    id: 'GPT Image 1',
    category: 'image',
    provider: '云雾 / OpenAI',
    baseUrl: 'https://api3.wlai.vip/v1',
    apiKey: '',
    modelCode: 'gpt-image-1',
    recommendedScenario: '产品首帧/质感静态图文生图',
    speedRating: '标准',
    speedMs: '35s',
    qualityRating: '写实级',
    description: '云雾实测可用 gpt-image-1',
    badge: null,
    enabled: 1,
    isDefault: 0,
  },
  {
    id: 'GPT Image 2',
    category: 'image',
    provider: '云雾 / OpenAI',
    baseUrl: 'https://api3.wlai.vip/v1',
    apiKey: '',
    modelCode: 'gpt-image-2',
    recommendedScenario: '产品首帧/质感静态图文生图（默认）',
    speedRating: '标准',
    speedMs: '35s',
    qualityRating: '写实级',
    description: '云雾实测可用 gpt-image-2',
    badge: '默认',
    enabled: 1,
    isDefault: 1,
  },
  {
    id: 'GPT Image 1 Mini',
    category: 'image',
    provider: '云雾 / OpenAI',
    baseUrl: 'https://api3.wlai.vip/v1',
    apiKey: '',
    modelCode: 'gpt-image-1-mini',
    recommendedScenario: '轻量快速文生图',
    speedRating: '快速',
    speedMs: '30s',
    qualityRating: '高清',
    description: '云雾实测可用 gpt-image-1-mini',
    badge: null,
    enabled: 1,
    isDefault: 0,
  },
  {
    id: 'GPT Image 1.5',
    category: 'image',
    provider: '云雾 / OpenAI',
    baseUrl: 'https://api3.wlai.vip/v1',
    apiKey: '',
    modelCode: 'gpt-image-1.5',
    recommendedScenario: '更强指令遵循的文生图',
    speedRating: '标准',
    speedMs: '27s',
    qualityRating: '写实级',
    description: '云雾实测可用 gpt-image-1.5',
    badge: null,
    enabled: 1,
    isDefault: 0,
  },
  {
    id: 'Seedream 4.5',
    category: 'image',
    provider: '云雾 / 字节',
    baseUrl: 'https://api3.wlai.vip/v1',
    apiKey: '',
    modelCode: 'doubao-seedream-4-5-251128',
    recommendedScenario: '字节 Seedream 文生图，速度快',
    speedRating: '快速',
    speedMs: '13s',
    qualityRating: '专业级',
    description: '云雾实测可用（返回 URL）',
    badge: null,
    enabled: 1,
    isDefault: 0,
  },
  {
    id: 'Z-Image Turbo',
    category: 'image',
    provider: '云雾 / 通义',
    baseUrl: 'https://api3.wlai.vip/v1',
    apiKey: '',
    modelCode: 'z-image-turbo',
    recommendedScenario: '开源高效文生图',
    speedRating: '极快',
    speedMs: '13s',
    qualityRating: '高清',
    description: '云雾实测可用 z-image-turbo',
    badge: null,
    enabled: 1,
    isDefault: 0,
  },

  // --- Video（星河中转 Seedance，非云雾）---
  {
    id: 'Seedance 2.0 Fast',
    category: 'video',
    provider: '星河中转 / Seedance',
    baseUrl: '/api/seedance',
    apiKey: '',
    modelCode: 'doubao-seedance-2-0-fast',
    recommendedScenario: '快节奏卡点、抖音前3秒冲击力',
    speedRating: '极快',
    speedMs: '3.2s',
    qualityRating: '高清',
    description: '走星河 Seedance 2.0 中转',
    badge: '中转默认',
    enabled: 1,
    isDefault: 1,
  },
  {
    id: 'Seedance 2.0',
    category: 'video',
    provider: '星河中转 / Seedance',
    baseUrl: '/api/seedance',
    apiKey: '',
    modelCode: 'doubao-seedance-2-0',
    recommendedScenario: '商业级物理运镜，膏体拉丝镜头',
    speedRating: '精细',
    speedMs: '7.2s',
    qualityRating: '物理级',
    description: '星河中转 Seedance 2.0 标准模型',
    badge: null,
    enabled: 1,
    isDefault: 0,
  },
];

/** 启动前断言：目录本身必须 ID 唯一、每类恰好一个默认模型。违反即抛错，阻止带病启动。 */
export function assertModelCatalogIntegrity(): void {
  const seen = new Map<string, ModelCategory>();
  const defaults = new Map<ModelCategory, string>();
  for (const entry of MODEL_CATALOG) {
    if (seen.has(entry.id)) {
      throw new Error(
        `模型目录断言失败：模型 ID 重复（${entry.id}，category=${seen.get(entry.id)} / ${entry.category}）。` +
          '这是 P0 级缺陷（fresh DB 初始化会 UNIQUE constraint failed），请修复 model-catalog.ts。'
      );
    }
    seen.set(entry.id, entry.category);
    if (entry.isDefault === 1) {
      if (defaults.has(entry.category)) {
        throw new Error(
          `模型目录断言失败：category=${entry.category} 有多个默认模型（${defaults.get(entry.category)} 与 ${entry.id}）。` +
            '每类恰好一个默认模型。'
        );
      }
      defaults.set(entry.category, entry.id);
    }
  }
  for (const category of ['text', 'image', 'video'] as ModelCategory[]) {
    if (!defaults.has(category)) {
      throw new Error(`模型目录断言失败：category=${category} 缺少默认模型。`);
    }
  }
}

/** 按模型 ID 查询目录条目 */
export function findCatalogModel(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}

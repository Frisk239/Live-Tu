import { ModelMetadata, ModelConfigState } from '../data/models';
import { PipelineData, TaskItem, MaterialItem, ProductItem, StepId } from '../types';

/**
 * Standard REST API Client for AIGC Video Processing Pipeline
 * Endpoints are designed for seamless integration with backends (Node.js/Express, Python/FastAPI, GCP Cloud Run)
 */

export interface ApiTestConnectionResponse {
  success: boolean;
  message: string;
  latencyMs: number;
  statusCode: number;
}

export interface ApiGenerateResponse<T> {
  success: boolean;
  data: T;
  requestId: string;
  executionTimeMs: number;
  modelUsed: string;
}

export interface BgmTrack {
  id: string;
  track_name: string;
  artist: string;
  style_tags: string[];
  bpm: number;
  mood: string;
  license_type: string;
  audio_path?: string;
  audio_url?: string;
  created_at?: string;
}

export const API_BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL || '/api';

export const apiService = {
  // --- 1. Model Configuration REST API ---
  models: {
    async fetchModels(): Promise<ModelConfigState> {
      try {
        const res = await fetch(`${API_BASE_URL}/models/config`);
        if (!res.ok) throw new Error('Failed to fetch model configuration');
        const json = await res.json();
        if (!json || json.success === false) throw new Error(json?.error || 'model config unavailable');
        return {
          textModels: json.textModels || [],
          imageModels: json.imageModels || [],
          videoModels: json.videoModels || [],
          autoRecommendationEnabled: json.autoRecommendationEnabled ?? true,
          defaultTextModel: json.defaultTextModel || 'Gemini 3.6 Flash',
          defaultImageModel: json.defaultImageModel || 'GPT Image 1',
          defaultVideoModel: json.defaultVideoModel || 'Seedance 2.0 Fast',
        };
      } catch (err) {
        console.warn('[API Client] Falling back to local model configuration');
        const local = JSON.parse(localStorage.getItem('aigc_model_config') || 'null');
        if (local && (local.textModels?.length > 0 || local.imageModels?.length > 0 || local.videoModels?.length > 0)) {
          return local;
        }
        throw err;
      }
    },

    async saveConfig(config: ModelConfigState): Promise<{ success: boolean }> {
      try {
        const res = await fetch(`${API_BASE_URL}/models/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        if (!res.ok) throw new Error('Save model config failed');
        return await res.json();
      } catch (err) {
        console.log('[API Client] Saved model config locally');
        localStorage.setItem('aigc_model_config', JSON.stringify(config));
        return { success: true };
      }
    },

    async testConnection(model: ModelMetadata): Promise<ApiTestConnectionResponse> {
      const startTime = Date.now();
      try {
        const res = await fetch(`${API_BASE_URL}/models/test-connection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return {
          success: Boolean(json.success),
          message: json.message || (json.success ? '连通成功' : '连通失败'),
          latencyMs: json.latencyMs || (Date.now() - startTime),
          statusCode: res.status,
        };
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        return {
          success: false,
          message: `✗ 探测接口异常: ${err?.message || '网络连接超时'}`,
          latencyMs: elapsed,
          statusCode: 0,
        };
      }
    },
  },

  // --- 2. Products Knowledge Base REST API ---
  products: {
    async fetchProducts(): Promise<ProductItem[]> {
      const res = await fetch(`${API_BASE_URL}/products`);
      if (!res.ok) throw new Error('Failed to fetch products');
      const json = await res.json();
      return json.data || [];
    },

    async createProduct(product: Partial<ProductItem>): Promise<{ success: boolean; id: string }> {
      const res = await fetch(`${API_BASE_URL}/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(product),
      });
      return await res.json();
    },

    async updateProduct(id: string, product: Partial<ProductItem>): Promise<{ success: boolean }> {
      const res = await fetch(`${API_BASE_URL}/products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(product),
      });
      return await res.json();
    },

    async deleteProduct(id: string): Promise<{ success: boolean }> {
      const res = await fetch(`${API_BASE_URL}/products/${id}`, {
        method: 'DELETE',
      });
      return await res.json();
    },
  },

  // --- 3. Material & Asset REST API ---
  materials: {
    async fetchMaterials(): Promise<MaterialItem[]> {
      try {
        const res = await fetch(`${API_BASE_URL}/materials`);
        if (!res.ok) throw new Error('Fetch materials failed');
        const json = await res.json();
        return json.data || [];
      } catch (err) {
        console.warn('[API Client] Materials fetch fallback');
        return [];
      }
    },

    async uploadMaterial(file: File): Promise<MaterialItem> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const dataUrl = reader.result as string;
            const res = await fetch(`${API_BASE_URL}/materials/upload`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: file.name,
                dataUrl,
                mediaType: file.type.startsWith('video') ? 'video' : 'image',
                size: (file.size / (1024 * 1024)).toFixed(1) + ' MB',
              }),
            });
            if (!res.ok) throw new Error('Upload material failed');
            const json = await res.json();
            resolve(json.data);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error('FileReader failed'));
        reader.readAsDataURL(file);
      });
    },

    async deleteMaterial(id: string): Promise<{ success: boolean }> {
      try {
        const res = await fetch(`${API_BASE_URL}/materials/${id}`, {
          method: 'DELETE',
        });
        return await res.json();
      } catch (err) {
        return { success: false };
      }
    },
  },

  // --- 4. Pipeline Task Execution & History REST API ---
  tasks: {
    async fetchTasks(): Promise<TaskItem[]> {
      try {
        const res = await fetch(`${API_BASE_URL}/tasks`);
        if (!res.ok) throw new Error('Fetch tasks failed');
        const json = await res.json();
        return json.data || [];
      } catch (err) {
        return [];
      }
    },

    async createTask(taskData: { id?: string; title?: string; status?: string; currentStep?: number; pipelineData: any; thumbnailUrl?: string }): Promise<{ success: boolean; data: TaskItem }> {
      const res = await fetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData),
      });
      if (!res.ok) throw new Error('Task creation failed');
      return await res.json();
    },

    async deleteTask(id: string): Promise<{ success: boolean }> {
      try {
        const res = await fetch(`${API_BASE_URL}/tasks/${id}`, {
          method: 'DELETE',
        });
        return await res.json();
      } catch (err) {
        return { success: false };
      }
    },

    async runPipelineStep(stepId: StepId, inputs: any, modelInfo?: any): Promise<any> {
      try {
        const res = await fetch(`${API_BASE_URL}/pipeline/step${stepId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs, modelInfo }),
        });
        if (!res.ok) throw new Error(`Step ${stepId} API execution failed`);
        return await res.json();
      } catch (err) {
        console.log(`[API Client] Step ${stepId} fallback execution`);
        return null;
      }
    },

    async generateImage(prompt: string, productId?: string, imageModel?: string): Promise<{ success: boolean; data?: { imageUrl: string; materialId: string; promptUsed: string }; error?: string }> {
      try {
        const res = await fetch(`${API_BASE_URL}/pipeline/generate-image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, productId, imageModel }),
        });
        if (!res.ok) throw new Error('Generate image API failed');
        return await res.json();
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  },

  // --- 5. BGM Library REST API ---
  bgm: {
    async fetchBgm(): Promise<BgmTrack[]> {
      try {
        const res = await fetch(`${API_BASE_URL}/bgm`);
        if (!res.ok) throw new Error('Fetch BGM failed');
        const json = await res.json();
        return json.data || [];
      } catch {
        return [];
      }
    },

    async uploadBgm(params: {
      name: string;
      artist?: string;
      bpm?: number;
      mood?: string;
      styleTags?: string[];
      file?: File;
      url?: string;
    }): Promise<{ success: boolean; data?: BgmTrack; error?: string }> {
      try {
        let fileDataUrl: string | undefined;
        if (params.file) {
          fileDataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(params.file!);
          });
        }
        const res = await fetch(`${API_BASE_URL}/bgm/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: params.name,
            artist: params.artist,
            bpm: params.bpm,
            mood: params.mood,
            styleTags: params.styleTags,
            fileDataUrl,
            url: params.url,
          }),
        });
        return await res.json();
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    async deleteBgm(id: string): Promise<{ success: boolean }> {
      try {
        const res = await fetch(`${API_BASE_URL}/bgm/${id}`, { method: 'DELETE' });
        return await res.json();
      } catch {
        return { success: false };
      }
    },
  },

  // --- 6. Presets Preset Templates REST API ---
  presets: {
    async fetchPresets(): Promise<any[]> {
      try {
        const res = await fetch(`${API_BASE_URL}/presets`);
        if (!res.ok) throw new Error('Fetch presets failed');
        const json = await res.json();
        return json.data || [];
      } catch (err) {
        return [];
      }
    },

    async createPreset(preset: { title: string; tag?: string; description?: string; coverImage?: string; pipelineData: any }): Promise<{ success: boolean; data: any }> {
      try {
        const res = await fetch(`${API_BASE_URL}/presets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(preset),
        });
        return await res.json();
      } catch (err) {
        return { success: false, data: null };
      }
    },

    async deletePreset(id: string): Promise<{ success: boolean }> {
      try {
        const res = await fetch(`${API_BASE_URL}/presets/${id}`, {
          method: 'DELETE',
        });
        return await res.json();
      } catch (err) {
        return { success: false };
      }
    },
  },
};

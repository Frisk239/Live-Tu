import { ModelMetadata, ModelConfigState, DEFAULT_TEXT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '../data/models';
import { PipelineData, TaskItem, MaterialItem, ProductItem, ProductAsset, StepId } from '../types';
// S0 状态契约单一来源：与后端 SQLite CHECK 约束 / 编排器同一份定义（shared/run-state.ts）
import type { RunStatus, StepStatus } from '../../shared/run-state';
// S2 工作台契约单一来源：自主模式 / SaveState / 预检 / 确认点 / 重试（shared/workbench-contract.ts）
import type {
  AutonomyMode,
  ConfirmResult,
  ConfirmType,
  PreflightResult,
  RetryShotResult,
  SaveState,
  WorkbenchState,
} from '../../shared/workbench-contract';

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

export type Permission =
  | 'module.pipeline.read'
  | 'module.pipeline.write'
  | 'module.materials.read'
  | 'module.materials.write'
  | 'module.tasks.read'
  | 'module.tasks.write'
  | 'module.presets.read'
  | 'module.presets.write'
  | 'module.knowledge.read'
  | 'module.knowledge.write'
  | 'module.bgm.read'
  | 'module.bgm.write'
  | 'module.models.read'
  | 'module.models.write'
  | 'admin.users.manage'
  | 'admin.metrics.read'
  | 'admin.audit.read';

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'operator';
  permissions: string[];
}

function parseAuthUser(value: any): AuthUser {
  return {
    id: String(value?.id || ''),
    username: String(value?.username || ''),
    role: value?.role === 'admin' ? 'admin' : 'operator',
    permissions: Array.isArray(value?.permissions)
      ? value.permissions.filter((permission: unknown): permission is string => typeof permission === 'string')
      : [],
  };
}

export interface PipelineRunSnapshot {
  id: string;
  ownerId: string;
  status: RunStatus;
  currentStep: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  steps: Array<{
    step: number;
    status: StepStatus;
    attempt: number;
    output?: any;
    errorCode?: string;
    errorMessage?: string;
    updatedAt: string;
  }>;
}

export const API_BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL || '/api';

export const apiService = {
  auth: {
    async login(username: string, password: string) {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '登录失败');
      return parseAuthUser(json.user);
    },

    async me() {
      const res = await fetch(`${API_BASE_URL}/auth/me`);
      if (!res.ok) return null;
      const json = await res.json();
      return parseAuthUser(json.user);
    },

    async logout() {
      await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST' });
    },
  },

  runs: {
    async list(): Promise<PipelineRunSnapshot[]> {
      const res = await fetch(`${API_BASE_URL}/runs`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '读取后台任务列表失败');
      return json.data || [];
    },

    async start(
      pipelineData: PipelineData,
      productId: string | undefined,
      productInfo: ProductItem | undefined,
      idempotencyKey: string,
      options?: {
        productAssetIds?: string[];
        directOutMode?: 'viral' | 'legacy' | string;
      }
    ): Promise<PipelineRunSnapshot> {
      const productAssetIds =
        options?.productAssetIds ||
        productInfo?.assets?.map((a) => a.id).filter(Boolean) ||
        [];
      const directOutMode =
        options?.directOutMode ||
        (pipelineData as any)?.directOutMode ||
        undefined;
      const res = await fetch(`${API_BASE_URL}/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          pipelineData: {
            ...pipelineData,
            directOutMode,
            productAssetIds,
          },
          productId,
          productInfo,
          productAssetIds,
          directOutMode,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '创建后台任务失败');
      return json.data;
    },

    async get(id: string): Promise<PipelineRunSnapshot> {
      const res = await fetch(`${API_BASE_URL}/runs/${encodeURIComponent(id)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '读取后台任务失败');
      return json.data;
    },

    async cancel(id: string): Promise<PipelineRunSnapshot> {
      const res = await fetch(`${API_BASE_URL}/runs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '取消后台任务失败');
      return json.data;
    },

    async retry(id: string, step: number): Promise<PipelineRunSnapshot> {
      const res = await fetch(`${API_BASE_URL}/runs/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '重试后台任务失败');
      return json.data;
    },
  },

  // --- S2 工作台（shared/workbench-contract 契约驱动） ---
  workbench: {
    async getState(opts: { runId?: string | null; sessionId?: string | null }): Promise<WorkbenchState> {
      const params = new URLSearchParams();
      if (opts.runId) params.set('runId', opts.runId);
      if (opts.sessionId) params.set('sessionId', opts.sessionId);
      const res = await fetch(`${API_BASE_URL}/workbench/state?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '读取工作台状态失败');
      if (!json.data || typeof json.data !== 'object' || Array.isArray(json.data)) {
        throw new Error('工作台状态格式无效');
      }
      return json.data as WorkbenchState;
    },

    async saveDraft(opts: {
      runId?: string | null;
      sessionId?: string | null;
      draftJson?: string | null;
      autonomyMode?: AutonomyMode;
      saveState?: SaveState;
    }): Promise<WorkbenchState> {
      const res = await fetch(`${API_BASE_URL}/workbench/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // P1-2：草稿接口不接受 paidAuthEnabled（付费授权唯一入口 = /workbench/paid-auth）
        body: JSON.stringify({
          runId: opts.runId ?? null,
          sessionId: opts.sessionId ?? null,
          draftJson: opts.draftJson ?? null,
          autonomyMode: opts.autonomyMode,
          saveState: opts.saveState,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '保存草稿失败');
      return json.data;
    },

    async setAutonomy(opts: {
      runId?: string | null;
      sessionId?: string | null;
      autonomyMode: AutonomyMode;
    }): Promise<WorkbenchState> {
      const res = await fetch(`${API_BASE_URL}/workbench/autonomy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: opts.runId ?? null,
          sessionId: opts.sessionId ?? null,
          autonomyMode: opts.autonomyMode,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '切换自主模式失败');
      return json.data;
    },

    async setPaidAuth(opts: {
      runId?: string | null;
      sessionId?: string | null;
      enabled: boolean;
    }): Promise<WorkbenchState> {
      const res = await fetch(`${API_BASE_URL}/workbench/paid-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: opts.runId ?? null,
          sessionId: opts.sessionId ?? null,
          enabled: opts.enabled,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '更新付费授权失败');
      return json.data;
    },

    async runPreflight(opts: { runId?: string | null; sessionId?: string | null }): Promise<PreflightResult> {
      const res = await fetch(`${API_BASE_URL}/workbench/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: opts.runId ?? null, sessionId: opts.sessionId ?? null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '预检失败');
      return json.data;
    },

    async confirm(opts: {
      runId?: string | null;
      sessionId?: string | null;
      type: ConfirmType;
    }): Promise<ConfirmResult> {
      const res = await fetch(`${API_BASE_URL}/workbench/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: opts.runId ?? null,
          sessionId: opts.sessionId ?? null,
          type: opts.type,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        const error = new Error(json.error || '确认失败') as Error & { code?: string; preflight?: PreflightResult };
        error.code = json.code;
        error.preflight = json.preflight;
        throw error;
      }
      return json.data;
    },

    async retryShot(opts: {
      runId: string;
      shotId: string;
      attempt: number;
      failureReason: string;
      promptOverride?: string | null;
    }): Promise<RetryShotResult> {
      const res = await fetch(`${API_BASE_URL}/workbench/retry-shot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '重试镜头失败');
      return json.data;
    },

    async cancel(opts: { runId?: string | null; sessionId?: string | null }): Promise<WorkbenchState> {
      const res = await fetch(`${API_BASE_URL}/workbench/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: opts.runId ?? null, sessionId: opts.sessionId ?? null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '取消失败');
      return json.data;
    },

    // --- P3 质量闭环 ---
    async qaShot(opts: { runId: string; shotId: string }): Promise<any> {
      const res = await fetch(`${API_BASE_URL}/workbench/qa-shot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || 'QA 检查失败');
      return json.data;
    },

    async fixShot(opts: { runId: string; shotId: string; skipAutoFix?: boolean }): Promise<any> {
      const res = await fetch(`${API_BASE_URL}/workbench/fix-shot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '修复失败');
      return json.data;
    },

    async manualPass(opts: { runId: string; shotId: string; comment?: string }): Promise<any> {
      const res = await fetch(`${API_BASE_URL}/workbench/manual-pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '人工通过失败');
      return json.data;
    },

    async useVersion(opts: { runId: string; shotId: string; versionId: string }): Promise<any> {
      const res = await fetch(`${API_BASE_URL}/workbench/use-version`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || '版本选择失败');
      return json.data;
    },

    async getShotVersions(shotId: string): Promise<any[]> {
      const res = await fetch(`${API_BASE_URL}/workbench/shot-versions?shotId=${encodeURIComponent(shotId)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) return [];
      return json.data || [];
    },
  },

  // --- 1. Model Configuration REST API ---
  models: {
    async fetchModels(): Promise<ModelConfigState> {
      try {
        localStorage.removeItem('aigc_model_config');
        const res = await fetch(`${API_BASE_URL}/models/config`);
        if (!res.ok) throw new Error('Failed to fetch model configuration');
        const json = await res.json();
        if (!json || json.success === false) throw new Error(json?.error || 'model config unavailable');
        return {
          textModels: json.textModels || [],
          imageModels: json.imageModels || [],
          videoModels: json.videoModels || [],
          autoRecommendationEnabled: json.autoRecommendationEnabled ?? true,
          defaultTextModel: json.defaultTextModel || DEFAULT_TEXT_MODEL,
          defaultImageModel: json.defaultImageModel || DEFAULT_IMAGE_MODEL,
          defaultVideoModel: json.defaultVideoModel || DEFAULT_VIDEO_MODEL,
        };
      } catch (err) {
        localStorage.removeItem('aigc_model_config');
        throw err;
      }
    },

    async saveConfig(config: ModelConfigState): Promise<{ success: boolean }> {
      localStorage.removeItem('aigc_model_config');
      const res = await fetch(`${API_BASE_URL}/models/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        throw new Error(json.error || `Save model config failed (${res.status})`);
      }
      return json;
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
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '创建产品失败');
      return json;
    },

    async updateProduct(id: string, product: Partial<ProductItem>): Promise<{ success: boolean }> {
      const res = await fetch(`${API_BASE_URL}/products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(product),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '更新产品失败');
      return json;
    },

    async deleteProduct(id: string): Promise<{ success: boolean }> {
      const res = await fetch(`${API_BASE_URL}/products/${id}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '删除产品失败');
      return json;
    },

    async listAssets(productId: string): Promise<ProductAsset[]> {
      const res = await fetch(`${API_BASE_URL}/products/${encodeURIComponent(productId)}/assets`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '读取产品图失败');
      return json.data || [];
    },

    async addAsset(
      productId: string,
      payload: { url?: string; role?: string; sortOrder?: number; file?: File }
    ): Promise<{ success: boolean; data: ProductAsset; assets?: ProductAsset[] }> {
      if (payload.file) {
        const form = new FormData();
        form.append('file', payload.file, payload.file.name);
        if (payload.role) form.append('role', payload.role);
        if (payload.sortOrder != null) form.append('sortOrder', String(payload.sortOrder));
        const res = await fetch(`${API_BASE_URL}/products/${encodeURIComponent(productId)}/assets`, {
          method: 'POST',
          body: form,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) throw new Error(json.error || '上传产品图失败');
        return json;
      }
      const res = await fetch(`${API_BASE_URL}/products/${encodeURIComponent(productId)}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: payload.url,
          role: payload.role || 'hero',
          sortOrder: payload.sortOrder ?? 0,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '添加产品图失败');
      return json;
    },

    async deleteAsset(productId: string, assetId: string): Promise<{ success: boolean }> {
      const res = await fetch(
        `${API_BASE_URL}/products/${encodeURIComponent(productId)}/assets/${encodeURIComponent(assetId)}`,
        { method: 'DELETE' }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '删除产品图失败');
      return json;
    },

    /**
     * S0：切换工作台产品上下文。旧产品绑定 Run 的下游产物全部标记 stale，
     * 之后发布/合成引用旧产物会被服务端 409 阻断。
     */
    async switchContext(
      productId: string
    ): Promise<{ success: boolean; staleCount: number; message: string }> {
      const res = await fetch(
        `${API_BASE_URL}/products/${encodeURIComponent(productId)}/context-switch`,
        { method: 'POST' }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '切换产品上下文失败');
      return json;
    },
  },

  // --- 3. Material & Asset REST API ---
  materials: {
    async fetchMaterials(): Promise<MaterialItem[]> {
      // S0：失败必须抛错（loading/error/empty 三态由调用方维护），不得吞成空数组
      const res = await fetch(`${API_BASE_URL}/materials`);
      if (!res.ok) throw new Error(`读取素材库失败 (HTTP ${res.status})`);
      const json = await res.json();
      if (json.success === false) throw new Error(json.error || '读取素材库失败');
      return json.data || [];
    },

    async uploadMaterial(file: File, onProgress?: (percent: number) => void): Promise<MaterialItem> {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('name', file.name);
      // XHR 才能拿到上传进度；错误响应体与 fetch 版本保持一致
      const { json, status } = await new Promise<{ json: any; status: number }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE_URL}/materials/upload-file`);
        xhr.upload.onprogress = (e) => {
          if (onProgress && e.lengthComputable) {
            onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
          }
        };
        xhr.onload = () => {
          let json: any = {};
          try {
            json = JSON.parse(xhr.responseText || '{}');
          } catch {
            json = { raw: xhr.responseText };
          }
          resolve({ json, status: xhr.status });
          if (onProgress) onProgress(100);
        };
        xhr.onerror = () => reject(new Error('网络异常，上传失败'));
        xhr.onabort = () => reject(new Error('上传已取消'));
        xhr.send(form);
      });
      if (status < 200 || status >= 300 || json.success !== true) {
        throw new Error(json.error || `上传素材失败 (${status})`);
      }
      return json.data;
    },

    async deleteMaterial(id: string): Promise<{ success: boolean }> {
      const res = await fetch(`${API_BASE_URL}/materials/${id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '删除素材失败');
      return json;
    },

    async updateMaterialTags(id: string, tags: string[]): Promise<{ success: boolean; tags?: string[] }> {
      const res = await fetch(`${API_BASE_URL}/materials/${id}/tags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '更新素材标签失败');
      return json;
    },

    async importDirectory(dirPath?: string): Promise<{ success: boolean; message: string; importedCount: number; items: MaterialItem[] }> {
      try {
        const res = await fetch(`${API_BASE_URL}/materials/import-directory`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dirPath }),
        });
        return await res.json();
      } catch (err: any) {
        return { success: false, message: err.message, importedCount: 0, items: [] };
      }
    },
  },

  // --- 4. Pipeline Task Execution & History REST API ---
  tasks: {
    async fetchTasks(): Promise<TaskItem[]> {
      // S0：失败必须抛错（loading/error/empty 三态由调用方维护），不得吞成空数组
      const res = await fetch(`${API_BASE_URL}/tasks`);
      if (!res.ok) throw new Error(`读取任务列表失败 (HTTP ${res.status})`);
      const json = await res.json();
      if (json.success === false) throw new Error(json.error || '读取任务列表失败');
      return json.data || [];
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
      const res = await fetch(`${API_BASE_URL}/tasks/${id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '删除任务失败');
      return json;
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
      // S0：失败必须抛错（loading/error/empty 三态由调用方维护），不得吞成空数组
      const res = await fetch(`${API_BASE_URL}/bgm`);
      if (!res.ok) throw new Error(`读取 BGM 库失败 (HTTP ${res.status})`);
      const json = await res.json();
      if (json.success === false) throw new Error(json.error || '读取 BGM 库失败');
      return json.data || [];
    },

    async uploadBgm(params: {
      name: string;
      artist?: string;
      bpm?: number;
      mood?: string;
      styleTags?: string[];
      file?: File;
      url?: string;
      licenseConfirmed: boolean;
    }): Promise<{ success: boolean; data?: BgmTrack; error?: string }> {
      try {
        if (params.file) {
          const form = new FormData();
          form.set('file', params.file);
          form.set('name', params.name);
          if (params.artist) form.set('artist', params.artist);
          if (params.bpm !== undefined) form.set('bpm', String(params.bpm));
          if (params.mood) form.set('mood', params.mood);
          if (params.styleTags) form.set('styleTags', params.styleTags.join(','));
          form.set('licenseConfirmed', String(params.licenseConfirmed));
          const res = await fetch(`${API_BASE_URL}/bgm/upload-file`, {
            method: 'POST',
            body: form,
          });
          return await res.json();
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
            url: params.url,
            licenseConfirmed: params.licenseConfirmed,
          }),
        });
        return await res.json();
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },

    async deleteBgm(id: string): Promise<{ success: boolean }> {
      const res = await fetch(`${API_BASE_URL}/bgm/${id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || '删除 BGM 失败');
      return json;
    },
  },

  // --- 6. Presets Preset Templates REST API ---
  presets: {
    async fetchPresets(): Promise<any[]> {
      // S0：失败必须抛错（loading/error/empty 三态由调用方维护），不得吞成空数组
      const res = await fetch(`${API_BASE_URL}/presets`);
      if (!res.ok) throw new Error(`读取预设模板失败 (HTTP ${res.status})`);
      const json = await res.json();
      if (json.success === false) throw new Error(json.error || '读取预设模板失败');
      return json.data || [];
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

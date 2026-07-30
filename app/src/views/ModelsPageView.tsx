import React, { useState } from 'react';
import {
  ShieldCheck,
  Cpu,
  Check,
  Sliders,
  Plus,
  Trash2,
  Edit2,
  Activity,
  Eye,
  EyeOff,
  Globe,
  Key,
  ArrowLeft,
  Server,
  X,
} from 'lucide-react';
import {
  ImageModelName,
  VideoModelName,
  ModelConfigState,
  ModelMetadata,
} from '../data/models';
import { apiService, ApiTestConnectionResponse } from '../services/api';
import { notify } from '../services/notifications';

interface ModelsPageViewProps {
  config: ModelConfigState;
  onSaveConfig: (newConfig: ModelConfigState) => void;
  userRole: 'admin' | 'user';
  onToggleRole?: () => void;
  onBackToPipeline: () => void;
}

export const ModelsPageView: React.FC<ModelsPageViewProps> = ({
  config,
  onSaveConfig,
  userRole,
  onBackToPipeline,
}) => {
  const [localConfig, setLocalConfig] = useState<ModelConfigState>(config);
  const [activeTab, setActiveTab] = useState<'text' | 'image' | 'video'>('text');
  const [saveSuccess, setSaveSuccess] = useState(false);

  const reloadModelsFromApi = async () => {
    try {
      const fresh = await apiService.models.fetchModels();
      if (fresh && (fresh.textModels?.length || fresh.imageModels?.length || fresh.videoModels?.length)) {
        setLocalConfig(fresh);
        onSaveConfig(fresh);
      }
    } catch (err) {
      console.warn('[ModelsPageView] fetchModels failed:', err);
    }
  };

  // Sync when parent finishes bootstrapping models from API, or auto-fetch if empty
  React.useEffect(() => {
    if (
      !config.textModels?.length &&
      !config.imageModels?.length &&
      !config.videoModels?.length
    ) {
      reloadModelsFromApi();
    } else {
      setLocalConfig((prev) => (JSON.stringify(prev) !== JSON.stringify(config) ? config : prev));
    }
  }, [config]);

  // Edit / Add Form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelMetadata | null>(null);
  const [formType, setFormType] = useState<'text' | 'image' | 'video'>('text');

  // Connection testing states
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ApiTestConnectionResponse>>({});

  // Show/Hide API key toggles
  const [showKeyMap, setShowKeyMap] = useState<Record<string, boolean>>({});

  // Form Fields
  const [formName, setFormName] = useState('');
  const [formProvider, setFormProvider] = useState('Google Gemini AIGC');
  const [formBaseUrl, setFormBaseUrl] = useState('https://generativelanguage.googleapis.com/v1beta');
  const [formApiKey, setFormApiKey] = useState('');
  const [formModelCode, setFormModelCode] = useState('');
  const [formScenario, setFormScenario] = useState('');
  const [formSpeedRating, setFormSpeedRating] = useState<'极快' | '快速' | '标准' | '精细'>('标准');
  const [formSpeedMs, setFormSpeedMs] = useState('2.5s');
  const [formQualityRating, setFormQualityRating] = useState<
    '基础级' | '高清' | '专业级' | '写实级' | '影视级' | '物理级' | '60fps流畅'
  >('影视级');
  const [formDescription, setFormDescription] = useState('');
  const [formBadge, setFormBadge] = useState('');

  const persistAndSyncConfig = async (nextConfig: ModelConfigState): Promise<boolean> => {
    try {
      await apiService.models.saveConfig(nextConfig);
      setLocalConfig(nextConfig);
      onSaveConfig(nextConfig);
      return true;
    } catch (err: any) {
      notify(err?.message || '模型配置保存失败，未应用任何更改', 'error');
      return false;
    }
  };

  const handleToggleEnable = (id: string, category: 'text' | 'image' | 'video') => {
    if (userRole !== 'admin') return;
    const key = category === 'text' ? 'textModels' : category === 'image' ? 'imageModels' : 'videoModels';
    const nextConfig = {
      ...localConfig,
      [key]: localConfig[key].map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)),
    };
    persistAndSyncConfig(nextConfig);
  };

  const handleSetDefault = async (id: string, category: 'text' | 'image' | 'video') => {
    if (userRole !== 'admin') return;
    let nextConfig: ModelConfigState;
    if (category === 'text') {
      nextConfig = {
        ...localConfig,
        defaultTextModel: id as any,
        textModels: localConfig.textModels.map((m) => ({ ...m, isDefault: m.id === id })),
      };
    } else if (category === 'image') {
      nextConfig = {
        ...localConfig,
        defaultImageModel: id as any,
        imageModels: localConfig.imageModels.map((m) => ({ ...m, isDefault: m.id === id })),
      };
    } else {
      nextConfig = {
        ...localConfig,
        defaultVideoModel: id as any,
        videoModels: localConfig.videoModels.map((m) => ({ ...m, isDefault: m.id === id })),
      };
    }
    if (!(await persistAndSyncConfig(nextConfig))) return;
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
    }, 1500);
  };

  const handleDeleteModel = (id: string, type: 'text' | 'image' | 'video') => {
    if (userRole !== 'admin') return;
    if (!window.confirm(`确定要删除模型 [${id}] 吗？`)) return;

    let nextConfig: ModelConfigState;
    if (type === 'text') {
      nextConfig = { ...localConfig, textModels: localConfig.textModels.filter((m) => m.id !== id) };
    } else if (type === 'image') {
      nextConfig = { ...localConfig, imageModels: localConfig.imageModels.filter((m) => m.id !== id) };
    } else {
      nextConfig = { ...localConfig, videoModels: localConfig.videoModels.filter((m) => m.id !== id) };
    }
    persistAndSyncConfig(nextConfig);
  };

  const handleTestConnection = async (model: ModelMetadata) => {
    setTestingModelId(model.id);
    const result = await apiService.models.testConnection(model);
    setTestResults((prev) => ({ ...prev, [model.id]: result }));
    setTestingModelId(null);
  };

  const handleOpenAddForm = (type: 'text' | 'image' | 'video') => {
    setFormType(type);
    setEditingModel(null);
    setFormName('');
    setFormProvider(type === 'video' ? '星河中转 / Seedance' : '云雾');
    setFormBaseUrl(type === 'video' ? '/api/seedance' : 'https://api3.wlai.vip/v1');
    setFormApiKey('');
    setFormModelCode(type === 'text' ? 'gemini-3.6-flash' : type === 'image' ? 'gpt-image-1' : 'doubao-seedance-2-0-fast');
    setFormScenario(type === 'text' ? '文案/多模态拆解' : type === 'image' ? '产品首帧文生图' : '图生视频');
    setFormSpeedRating('标准');
    setFormSpeedMs(type === 'image' ? '30s' : '1.0s');
    setFormQualityRating(type === 'image' ? '写实级' : '专业级');
    setFormDescription('自定义云雾模型');
    setFormBadge('自定义');
    setIsFormOpen(true);
  };

  const handleOpenEditForm = (model: ModelMetadata, type: 'text' | 'image' | 'video') => {
    setFormType(type);
    setEditingModel(model);
    setFormName(model.name);
    setFormProvider(model.provider || '云雾');
    setFormBaseUrl(model.baseUrl || 'https://api3.wlai.vip/v1');
    setFormApiKey(model.apiKey || '');
    setFormModelCode(model.modelCode || model.id);
    setFormScenario(model.recommendedScenario || '');
    setFormSpeedRating(model.speedRating || '标准');
    setFormSpeedMs(model.speedMs || '2.5s');
    setFormQualityRating(model.qualityRating || '专业级');
    setFormDescription(model.description || '');
    setFormBadge(model.badge || '');
    setIsFormOpen(true);
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) return;

    const newId = editingModel ? editingModel.id : formName.trim();

    const updatedModel: ModelMetadata = {
      id: newId,
      name: formName.trim(),
      provider: formProvider.trim(),
      baseUrl: formBaseUrl.trim(),
      apiKey: formApiKey.trim(),
      modelCode: formModelCode.trim() || formName.trim(),
      recommendedScenario: formScenario.trim(),
      speedRating: formSpeedRating,
      speedMs: formSpeedMs.trim(),
      qualityRating: formQualityRating,
      description: formDescription.trim(),
      badge: formBadge.trim() || undefined,
      enabled: editingModel ? editingModel.enabled : true,
      isDefault: editingModel ? editingModel.isDefault : false,
      isCustom: true,
    };

    const key = formType === 'text' ? 'textModels' : formType === 'image' ? 'imageModels' : 'videoModels';
    const list = localConfig[key];
    const exists = list.some((m) => m.id === newId);
    const nextList = exists
      ? list.map((m) => (m.id === newId ? updatedModel : m))
      : [...list, updatedModel];

    const nextConfig = { ...localConfig, [key]: nextList as any };
    if (await persistAndSyncConfig(nextConfig)) setIsFormOpen(false);
  };

  const handleSave = async () => {
    if (!(await persistAndSyncConfig(localConfig))) return;
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
    }, 1500);
  };

  const toggleShowKey = (id: string) => {
    setShowKeyMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBackToPipeline}
            className="p-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 shadow-2xs transition-all flex items-center gap-1.5 text-xs font-semibold shrink-0 cursor-pointer"
            title="返回主工作台"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
            <span>返回工作台</span>
          </button>

          <div className="p-3 rounded-xl bg-blue-50 text-blue-600 border border-blue-200/60 shrink-0">
            <Cpu className="w-6 h-6" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">大模型与提示词规则配置中心</h1>
              <span
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border flex items-center gap-1 ${
                  userRole === 'admin'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-blue-50 text-blue-700 border-blue-200/60'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                {userRole === 'admin' ? '超级管理员视图 (完整权限)' : '普通用户视图 (只读展示)'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              系统根据当前用户角色（{userRole === 'admin' ? '管理员' : '普通用户'}）自动匹配并接入模型配置。
            </p>
          </div>
        </div>
      </div>

      {/* Mode / Tabs Bar */}
      <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-2xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('text')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'text'
                ? 'bg-blue-600 text-white shadow-2xs'
                : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            🧠 文本 / 卖点 AI 模型 ({(localConfig.textModels || []).length})
          </button>
          <button
            onClick={() => setActiveTab('image')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'image'
                ? 'bg-blue-600 text-white shadow-2xs'
                : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            📷 静态图片模型 ({localConfig.imageModels.length})
          </button>
          <button
            onClick={() => setActiveTab('video')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'video'
                ? 'bg-blue-600 text-white shadow-2xs'
                : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            🎬 图生视频模型 ({localConfig.videoModels.length})
          </button>
        </div>

        <div className="flex items-center gap-3">
          {userRole === 'admin' && (
            <button
              onClick={() => handleOpenAddForm(activeTab)}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-white border border-slate-200/80 hover:bg-slate-50 text-slate-700 transition-all shadow-2xs flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4 text-blue-600" />
              <span>
                新增
                {activeTab === 'text' ? '文本' : activeTab === 'image' ? '图片' : '视频'} AI 模型
              </span>
            </button>
          )}

          {userRole === 'admin' && (
            <button
              onClick={handleSave}
              className="px-5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
            >
              {saveSuccess ? (
                <>
                  <Check className="w-4 h-4" />
                  已成功保存并生效！
                </>
              ) : (
                '保存设置'
              )}
            </button>
          )}
        </div>
      </div>

      {/* Models Grid */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        {(() => {
          const currentModels =
            activeTab === 'text'
              ? localConfig.textModels || []
              : activeTab === 'image'
              ? localConfig.imageModels || []
              : localConfig.videoModels || [];

          if (currentModels.length === 0) {
            return (
              <div className="py-12 px-4 text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto border border-blue-200/60">
                  <Cpu className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    当前分类下暂无已加载的 AI 模型
                  </h3>
                  <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                    系统已内置 SQLite 嵌入式数据库并自动同步 11 款实测可用模型（Gemini 3.6 Flash、GPT Image 1、Seedance 2.0 等）。点击下方按钮可立即一键同步！
                  </p>
                </div>
                <button
                  onClick={reloadModelsFromApi}
                  className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-2xs transition-all cursor-pointer inline-flex items-center gap-2"
                >
                  <Activity className="w-4 h-4" />
                  <span>一键同步后端数据库预置模型</span>
                </button>
              </div>
            );
          }

          return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {currentModels.map((model: ModelMetadata) => {
                const testResult = testResults[model.id];
                const isTesting = testingModelId === model.id;
                const isKeyShown = Boolean(showKeyMap[model.id]);

              return (
                <div
                  key={model.id}
                  className={`p-5 rounded-xl border transition-all flex flex-col justify-between ${
                    model.enabled
                      ? 'bg-white border-slate-200/80 shadow-2xs'
                      : 'bg-slate-50/50 border-slate-200/60 opacity-60'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-bold text-base text-slate-900">{model.name}</h3>
                          {model.isDefault && (
                            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              默认首选
                            </span>
                          )}
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
                            {model.provider || 'AI Provider'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                          {model.description}
                        </p>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {userRole === 'admin' && (
                          <>
                            <button
                              onClick={() => handleOpenEditForm(model, activeTab)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
                              title="编辑"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteModel(model.id, activeTab)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                              title="删除"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}

                        <button
                          disabled={userRole !== 'admin'}
                          onClick={() => handleToggleEnable(model.id, activeTab)}
                          className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                            model.enabled
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-slate-100 text-slate-500 border border-slate-200'
                          }`}
                        >
                          {model.enabled ? '已启用' : '未启用'}
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 p-3 rounded-lg bg-slate-50 border border-slate-200/80 space-y-2 text-xs font-mono">
                      <div className="flex items-center justify-between text-slate-600 gap-2">
                        <span className="flex items-center gap-1 font-semibold text-slate-700 shrink-0">
                          <Server className="w-3.5 h-3.5 text-blue-600" />
                          <span>model_code:</span>
                        </span>
                        <span className="truncate max-w-[240px] text-slate-800 font-medium">
                          {model.modelCode || model.id}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-600">
                        <span className="flex items-center gap-1 font-semibold text-slate-700">
                          <Globe className="w-3.5 h-3.5 text-blue-600" />
                          <span>Base URL:</span>
                        </span>
                        <span className="truncate max-w-[240px] text-slate-800 font-medium">
                          {model.baseUrl || 'https://api3.wlai.vip/v1'}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-slate-600">
                        <span className="flex items-center gap-1 font-semibold text-slate-700">
                          <Key className="w-3.5 h-3.5 text-blue-600" />
                          <span>API Key:</span>
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-800 font-medium">
                            {isKeyShown
                              ? model.apiKey || '环境变量 GEMINI_API_KEY'
                              : model.apiKey
                              ? model.apiKey.slice(0, 7) + '••••••••'
                              : '环境受保护密钥'}
                          </span>
                          {model.apiKey && (
                            <button
                              type="button"
                              onClick={() => toggleShowKey(model.id)}
                              className="text-slate-400 hover:text-slate-600"
                            >
                              {isKeyShown ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleTestConnection(model)}
                        disabled={isTesting}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 shadow-2xs transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <Activity className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin text-blue-600' : ''}`} />
                        <span>{isTesting ? '检测中...' : '测试接口连通性'}</span>
                      </button>

                      {testResult && (
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                            testResult.success
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-rose-50 text-rose-700 border-rose-200'
                          }`}
                        >
                          {testResult.message}
                        </span>
                      )}
                    </div>

                    {userRole === 'admin' && model.enabled && !model.isDefault && (
                      <button
                        onClick={() => handleSetDefault(model.id, activeTab)}
                        className="text-xs text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1 cursor-pointer"
                      >
                        <Sliders className="w-3.5 h-3.5" />
                        <span>设为默认</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
      </div>

      {/* Edit Form Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="bg-white text-slate-900 border border-slate-200/90 rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Server className="w-4 h-4 text-blue-600" />
                <span>
                  {editingModel
                    ? '编辑 AI 模型'
                    : `新增${formType === 'text' ? '文本' : formType === 'image' ? '图片' : '视频'} AI 模型`}
                </span>
              </h3>
              <button
                onClick={() => setIsFormOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveForm} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">模型展示名称 *</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="例如：Gemini 3.6 Ultra HD"
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs font-medium"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">API Base URL *</label>
                <input
                  type="text"
                  required
                  value={formBaseUrl}
                  onChange={(e) => setFormBaseUrl(e.target.value)}
                  placeholder="https://generativelanguage.googleapis.com/v1beta"
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 font-mono text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">API Key</label>
                <input
                  type="password"
                  value={formApiKey}
                  onChange={(e) => setFormApiKey(e.target.value)}
                  placeholder="sk-proj-..."
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 font-mono text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">场景描述</label>
                <textarea
                  rows={2}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="描述模型适用场景"
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-200/80 text-xs font-semibold bg-white text-slate-700 hover:bg-slate-100 shadow-2xs cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs cursor-pointer"
                >
                  保存模型
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

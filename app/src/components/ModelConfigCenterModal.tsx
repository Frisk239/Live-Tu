import React, { useState } from 'react';
import {
  X,
  ShieldCheck,
  Cpu,
  Check,
  Sparkles,
  Sliders,
  Lock,
  Plus,
  Trash2,
  Edit2,
  Activity,
  Eye,
  EyeOff,
  AlertCircle,
  Globe,
  Key,
  Server,
} from 'lucide-react';
import {
  ImageModelName,
  VideoModelName,
  ModelConfigState,
  ModelMetadata,
} from '../data/models';
import { apiService, ApiTestConnectionResponse } from '../services/api';

interface ModelConfigCenterModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ModelConfigState;
  onSaveConfig: (newConfig: ModelConfigState) => void;
  userRole: 'admin' | 'user';
  onToggleRole: () => void;
}

export const ModelConfigCenterModal: React.FC<ModelConfigCenterModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaveConfig,
  userRole,
  onToggleRole,
}) => {
  const [localConfig, setLocalConfig] = useState<ModelConfigState>(config);
  const [activeTab, setActiveTab] = useState<'text' | 'image' | 'video'>('text');
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Edit / Add Modal state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelMetadata | null>(null);
  const [formType, setFormType] = useState<'image' | 'video'>('image');

  // Connection testing states
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ApiTestConnectionResponse>>({});

  // Show/Hide API key toggles for form or cards
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

  if (!isOpen) return null;

  const handleToggleEnableImage = (id: ImageModelName) => {
    if (userRole !== 'admin') return;
    setLocalConfig((prev) => ({
      ...prev,
      imageModels: prev.imageModels.map((m) =>
        m.id === id ? { ...m, enabled: !m.enabled } : m
      ),
    }));
  };

  const handleToggleEnableVideo = (id: VideoModelName) => {
    if (userRole !== 'admin') return;
    setLocalConfig((prev) => ({
      ...prev,
      videoModels: prev.videoModels.map((m) =>
        m.id === id ? { ...m, enabled: !m.enabled } : m
      ),
    }));
  };

  const handleSetDefaultImage = (id: ImageModelName) => {
    if (userRole !== 'admin') return;
    setLocalConfig((prev) => ({
      ...prev,
      defaultImageModel: id,
      imageModels: prev.imageModels.map((m) => ({
        ...m,
        isDefault: m.id === id,
      })),
    }));
  };

  const handleSetDefaultVideo = (id: VideoModelName) => {
    if (userRole !== 'admin') return;
    setLocalConfig((prev) => ({
      ...prev,
      defaultVideoModel: id,
      videoModels: prev.videoModels.map((m) => ({
        ...m,
        isDefault: m.id === id,
      })),
    }));
  };

  const handleDeleteModel = (id: string, type: 'image' | 'video') => {
    if (userRole !== 'admin') return;
    if (!window.confirm(`确定要删除模型 [${id}] 吗？`)) return;

    setLocalConfig((prev) => {
      if (type === 'image') {
        return { ...prev, imageModels: prev.imageModels.filter((m) => m.id !== id) };
      } else {
        return { ...prev, videoModels: prev.videoModels.filter((m) => m.id !== id) };
      }
    });
  };

  const handleTestConnection = async (model: ModelMetadata) => {
    setTestingModelId(model.id);
    const result = await apiService.models.testConnection(model);
    setTestResults((prev) => ({ ...prev, [model.id]: result }));
    setTestingModelId(null);
  };

  const handleOpenAddForm = (type: 'image' | 'video') => {
    setFormType(type);
    setEditingModel(null);
    setFormName('');
    setFormProvider('Google Gemini AIGC');
    setFormBaseUrl('https://generativelanguage.googleapis.com/v1beta');
    setFormApiKey('');
    setFormModelCode('');
    setFormScenario('适合爆款画质重构与细节渲染');
    setFormSpeedRating('标准');
    setFormSpeedMs('3.0s');
    setFormQualityRating('影视级');
    setFormDescription('企业级微调算法接入模型');
    setFormBadge('自定义模型');
    setIsFormOpen(true);
  };

  const handleOpenEditForm = (model: ModelMetadata, type: 'image' | 'video') => {
    setFormType(type);
    setEditingModel(model);
    setFormName(model.name);
    setFormProvider(model.provider || 'Google Gemini AIGC');
    setFormBaseUrl(model.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
    setFormApiKey(model.apiKey || '');
    setFormModelCode(model.modelCode || model.id);
    setFormScenario(model.recommendedScenario || '');
    setFormSpeedRating(model.speedRating || '标准');
    setFormSpeedMs(model.speedMs || '2.5s');
    setFormQualityRating(model.qualityRating || '影视级');
    setFormDescription(model.description || '');
    setFormBadge(model.badge || '');
    setIsFormOpen(true);
  };

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) return;

    const newId = editingModel ? editingModel.id : (formName.trim() as any);

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

    setLocalConfig((prev) => {
      if (formType === 'image') {
        const exists = prev.imageModels.some((m) => m.id === newId);
        const imageModels = exists
          ? prev.imageModels.map((m) => (m.id === newId ? updatedModel : m))
          : [...prev.imageModels, updatedModel];
        return { ...prev, imageModels: imageModels as any };
      } else {
        const exists = prev.videoModels.some((m) => m.id === newId);
        const videoModels = exists
          ? prev.videoModels.map((m) => (m.id === newId ? updatedModel : m))
          : [...prev.videoModels, updatedModel];
        return { ...prev, videoModels: videoModels as any };
      }
    });

    setIsFormOpen(false);
  };

  const handleSave = async () => {
    await apiService.models.saveConfig(localConfig);
    onSaveConfig(localConfig);
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
      onClose();
    }, 800);
  };

  const toggleShowKey = (id: string) => {
    setShowKeyMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white text-slate-900 border border-slate-200/90 rounded-2xl shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden transition-all">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/80">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600 border border-blue-200/60">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900">
                  AI 模型配置中心 (Model Management Center)
                </h2>
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border flex items-center gap-1 ${
                    userRole === 'admin'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {userRole === 'admin' ? '超级管理员模式' : '普通用户模式 (只读选择)'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                管理图片/视频 AI 接入模型、自定义 Base URL & API Key、连接状态校验与默认推荐策略
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Switch Role Button */}
            <button
              onClick={onToggleRole}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-200/80 bg-white text-slate-700 font-medium hover:bg-slate-100 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
              title="切换管理员/普通用户身份"
            >
              <Eye className="w-3.5 h-3.5 text-slate-500" />
              <span>切换身份: {userRole === 'admin' ? '普通用户视图' : '管理员模式'}</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* User Role Banner */}
        {userRole === 'user' && (
          <div className="bg-amber-50 border-b border-amber-200/60 px-6 py-2.5 flex items-center justify-between text-xs text-amber-800">
            <div className="flex items-center gap-2">
              <Lock className="w-4 h-4 shrink-0 text-amber-600" />
              <span>
                当前为普通用户只读状态，只能选择管理员开启的模型。如需添加新模型、修改 API 密钥或调整默认模型，请切换至【管理员模式】。
              </span>
            </div>
            <button
              onClick={onToggleRole}
              className="underline font-semibold text-amber-900 hover:text-amber-700 shrink-0 ml-2 cursor-pointer"
            >
              快速开启管理员
            </button>
          </div>
        )}

        {/* Tab & Global Controls Bar */}
        <div className="px-6 py-3 bg-white border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('text')}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'text'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span>🧠 文本 / 卖点 AI 模型 ({(localConfig.textModels || []).length})</span>
            </button>
            <button
              onClick={() => setActiveTab('image')}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'image'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span>📷 静态图片模型 ({localConfig.imageModels.length})</span>
            </button>
            <button
              onClick={() => setActiveTab('video')}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'video'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span>🎬 图生视频模型 ({localConfig.videoModels.length})</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                disabled={userRole !== 'admin'}
                checked={localConfig.autoRecommendationEnabled}
                onChange={(e) =>
                  userRole === 'admin' &&
                  setLocalConfig((prev) => ({
                    ...prev,
                    autoRecommendationEnabled: e.target.checked,
                  }))
                }
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              <span>启用 AI 智能自动场景匹配与模型推荐</span>
            </label>

            {userRole === 'admin' && (
              <button
                onClick={() => handleOpenAddForm(activeTab)}
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-all flex items-center gap-1.5 shadow-2xs shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新增{activeTab === 'image' ? '图片' : '视频'}模型</span>
              </button>
            )}
          </div>
        </div>

        {/* Modal Main Content */}
        <div className="p-6 overflow-y-auto flex-1 bg-slate-50/50 space-y-4">
          {/* Models Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(activeTab === 'text'
              ? (localConfig.textModels || [])
              : activeTab === 'image'
              ? localConfig.imageModels
              : localConfig.videoModels
            ).map((model: ModelMetadata) => {
                const testResult = testResults[model.id];
                const isTesting = testingModelId === model.id;
                const isKeyShown = Boolean(showKeyMap[model.id]);

                return (
                  <div
                    key={model.id}
                    className={`p-4 rounded-xl border transition-all flex flex-col justify-between relative shadow-2xs ${
                      model.enabled
                        ? 'bg-white border-slate-200/80 text-slate-900'
                        : 'bg-slate-100/60 border-slate-200/60 text-slate-400 opacity-70'
                    }`}
                  >
                    <div>
                      {/* Top bar */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h4 className="font-bold text-sm text-slate-900">
                              {model.name}
                            </h4>
                            {model.isDefault && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200/60">
                                默认模型
                              </span>
                            )}
                            {model.badge && !model.isDefault && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                                {model.badge}
                              </span>
                            )}
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-500">
                              {model.provider || 'AI Provider'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                            {model.description}
                          </p>
                        </div>

                        {/* Admin quick actions */}
                        <div className="flex items-center gap-1 shrink-0">
                          {userRole === 'admin' && (
                            <>
                              <button
                                onClick={() => handleOpenEditForm(model, activeTab)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
                                title="编辑模型配置"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteModel(model.id, activeTab)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                                title="删除模型"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          <button
                            disabled={userRole !== 'admin'}
                            onClick={() =>
                              activeTab === 'image'
                                ? handleToggleEnableImage(model.id as any)
                                : handleToggleEnableVideo(model.id as any)
                            }
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold shadow-2xs transition-colors ${
                              model.enabled
                                ? 'bg-emerald-600 text-white'
                                : 'bg-slate-200 text-slate-500'
                            } ${userRole !== 'admin' ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'}`}
                          >
                            {model.enabled ? '已启用' : '已停用'}
                          </button>
                        </div>
                      </div>

                      {/* Endpoint & Key Display Box */}
                      <div className="mt-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 space-y-1.5 text-xs font-mono">
                        <div className="flex items-center justify-between text-slate-600 text-[11px]">
                          <span className="flex items-center gap-1 font-semibold">
                            <Globe className="w-3 h-3 text-slate-400" />
                            <span>Base URL:</span>
                          </span>
                          <span className="truncate max-w-[220px] text-slate-900 font-medium">
                            {model.baseUrl || 'https://api.aigc.studio'}
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-slate-600 text-[11px]">
                          <span className="flex items-center gap-1 font-semibold">
                            <Key className="w-3 h-3 text-slate-400" />
                            <span>API Key:</span>
                          </span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-900 font-medium">
                              {isKeyShown
                                ? model.apiKey || '未配置'
                                : model.apiKey
                                ? model.apiKey.slice(0, 7) + '••••••••' + model.apiKey.slice(-4)
                                : '未配置'}
                            </span>
                            {model.apiKey && (
                              <button
                                type="button"
                                onClick={() => toggleShowKey(model.id)}
                                className="text-slate-400 hover:text-slate-600 cursor-pointer"
                              >
                                {isKeyShown ? (
                                  <EyeOff className="w-3 h-3" />
                                ) : (
                                  <Eye className="w-3 h-3" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-slate-200/60 text-[11px]">
                          <span className="text-slate-500 font-semibold">推荐场景:</span>
                          <span className="text-slate-600 text-right truncate max-w-[200px]">
                            {model.recommendedScenario}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Footer Actions */}
                    <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleTestConnection(model)}
                          disabled={isTesting}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 shadow-2xs transition-colors flex items-center gap-1 cursor-pointer"
                        >
                          <Activity className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin text-blue-600' : 'text-slate-400'}`} />
                          <span>{isTesting ? '检测中...' : '测试连接'}</span>
                        </button>

                        {testResult && (
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 ${
                              testResult.success
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : 'bg-rose-50 text-rose-700 border border-rose-200'
                            }`}
                          >
                            {testResult.message}
                          </span>
                        )}
                      </div>

                      {userRole === 'admin' && model.enabled && !model.isDefault && (
                        <button
                          onClick={() =>
                            activeTab === 'image'
                              ? handleSetDefaultImage(model.id as any)
                              : handleSetDefaultVideo(model.id as any)
                          }
                          className="text-[11px] text-blue-600 hover:text-blue-700 font-medium underline flex items-center gap-1 cursor-pointer"
                        >
                          <Sliders className="w-3 h-3" />
                          <span>设为默认</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              }
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4 text-slate-400 shrink-0" />
            <span>所有模型变更已通过 REST API 架构进行状态同步与本地持久化</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 bg-white border border-slate-200/80 shadow-2xs hover:bg-slate-100 transition-colors cursor-pointer"
            >
              关闭
            </button>
            {userRole === 'admin' && (
              <button
                onClick={handleSave}
                className="px-5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
              >
                {saveSuccess ? (
                  <>
                    <Check className="w-4 h-4" />
                    已成功保存更新！
                  </>
                ) : (
                  '保存模型配置方案'
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Add / Edit Model Dialog Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="bg-white text-slate-900 border border-slate-200/90 rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Server className="w-4 h-4 text-blue-600" />
                <span>{editingModel ? '编辑 AI 模型配置' : `新增${formType === 'image' ? '图片' : '视频'} AI 模型`}</span>
              </h3>
              <button
                onClick={() => setIsFormOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveForm} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  模型展示名称 (Model Name) *
                </label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="例如：Gemini 3.6 Ultra HD"
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    AI 服务商 (Provider)
                  </label>
                  <select
                    value={formProvider}
                    onChange={(e) => setFormProvider(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs cursor-pointer"
                  >
                    <option value="Google Gemini AIGC">Google Gemini AIGC</option>
                    <option value="OpenAI Enterprise">OpenAI Enterprise</option>
                    <option value="ByteDance Volcengine">ByteDance Volcengine</option>
                    <option value="Banana AI Cloud">Banana AI Cloud</option>
                    <option value="RunwayML Studio">RunwayML Studio</option>
                    <option value="Kling AI Engine">Kling AI Engine</option>
                    <option value="MiniMax Video">MiniMax Video</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    模型代码 (Model Code)
                  </label>
                  <input
                    type="text"
                    value={formModelCode}
                    onChange={(e) => setFormModelCode(e.target.value)}
                    placeholder="例如：gemini-3.6-ultra"
                    className="w-full bg-white border border-slate-200 rounded-lg p-2.5 font-mono text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  API Base URL (接口地址)
                </label>
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
                <label className="block font-semibold text-slate-700 mb-1">
                  API Key (密钥)
                </label>
                <input
                  type="password"
                  value={formApiKey}
                  onChange={(e) => setFormApiKey(e.target.value)}
                  placeholder="sk-proj-..."
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 font-mono text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  推荐应用场景
                </label>
                <input
                  type="text"
                  value={formScenario}
                  onChange={(e) => setFormScenario(e.target.value)}
                  placeholder="例如：适合爆款短视频 4K 质感极速重构"
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    生成速度评级
                  </label>
                  <select
                    value={formSpeedRating}
                    onChange={(e) => setFormSpeedRating(e.target.value as any)}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs cursor-pointer"
                  >
                    <option value="极快">极快</option>
                    <option value="快速">快速</option>
                    <option value="标准">标准</option>
                    <option value="精细">精细</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    预估生成耗时
                  </label>
                  <input
                    type="text"
                    value={formSpeedMs}
                    onChange={(e) => setFormSpeedMs(e.target.value)}
                    placeholder="例如：2.5s"
                    className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  模型描述
                </label>
                <textarea
                  rows={2}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="模型核心能力与适用参数"
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="px-3.5 py-2 rounded-lg text-xs font-medium bg-white border border-slate-200/80 text-slate-700 hover:bg-slate-100 shadow-2xs cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs cursor-pointer"
                >
                  保存模型配置
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

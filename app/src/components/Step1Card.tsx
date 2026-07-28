import React, { useState, useEffect } from 'react';
import { Step1Inputs, Step1Output, StepStatus, MaterialItem, ProductItem } from '../types';
import { copyToClipboard, downloadJsonFile } from '../utils/format';
import {
  Upload,
  Play,
  RotateCcw,
  Download,
  Copy,
  Check,
  Image as ImageIcon,
  Sparkles,
  ArrowRight,
  Palette,
  Eye,
  FileCode,
  Info,
  Edit3,
  RefreshCw,
  Cpu,
  Layers,
  ListChecks,
  Trash2,
  Plus,
  Clock,
  CheckCircle2,
  AlertCircle,
  Zap,
  X,
  FileVideo,
  FolderPlus,
  SlidersHorizontal,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { ModelConfigState } from '../data/models';
import { PromptEditorModal } from './PromptEditorModal';
import { apiService } from '../services/api';

export interface BatchStep1QueueItem {
  id: string;
  name: string;
  url: string;
  type: 'video' | 'image';
  size?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  executionTimeMs?: number;
  output?: Step1Output;
  errorMessage?: string;
  createdAt: string;
}

interface Step1CardProps {
  inputs: Step1Inputs;
  output?: Step1Output;
  status: StepStatus;
  useMockMode: boolean;
  modelConfig: ModelConfigState;
  materials?: MaterialItem[];
  activeProduct?: ProductItem;
  onUpdateInputs: (inputs: Partial<Step1Inputs>) => void;
  onUpdateOutput?: (updatedOutput: Partial<Step1Output>) => void;
  onRun: () => void;
  onReset: () => void;
  onNext: () => void;
  onOpenMaterials?: () => void;
}

export const Step1Card: React.FC<Step1CardProps> = ({
  inputs,
  output,
  status,
  useMockMode,
  modelConfig,
  materials = [],
  activeProduct,
  onUpdateInputs,
  onUpdateOutput,
  onRun,
  onReset,
  onNext,
  onOpenMaterials,
}) => {
  // Mode Switch State: 'single' | 'batch'
  const [executionMode, setExecutionMode] = useState<'single' | 'batch'>('single');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Single Mode UI states
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [activeTab, setActiveTab] = useState<'visual' | 'json'>('visual');
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);

  // Batch Queue State
  const [batchQueue, setBatchQueue] = useState<BatchStep1QueueItem[]>([
    {
      id: 'batch_demo_1',
      name: '纯净高质感膏体拉丝.mp4',
      url: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
      type: 'video',
      size: '2.4 MB',
      status: 'pending',
      progress: 0,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
    {
      id: 'batch_demo_2',
      name: '沉浸式晨间洗漱与泡泡揉搓.mp4',
      url: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
      type: 'video',
      size: '4.8 MB',
      status: 'pending',
      progress: 0,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
    {
      id: 'batch_demo_3',
      name: '油敏肌高清毛孔对比特写.mp4',
      url: 'https://images.unsplash.com/photo-1512290900673-7002fffe929a?auto=format&fit=crop&w=600&q=80',
      type: 'image',
      size: '3.1 MB',
      status: 'pending',
      progress: 0,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [copiedBatchAll, setCopiedBatchAll] = useState(false);
  const [editingQueueItemId, setEditingQueueItemId] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);

  const isRunning = status === 'running';
  const isCompleted = status === 'completed' && Boolean(output);

  // Available image models from config
  const enabledImageModels = modelConfig.imageModels.filter((m) => m.enabled);

  // Auto-recommendation logic based on platform and blogger type
  useEffect(() => {
    if (modelConfig.autoRecommendationEnabled && !inputs.imageModel) {
      if (inputs.platform === 'xiaohongshu') {
        onUpdateInputs({ imageModel: 'Imagen 4 Ultra' });
      } else if (inputs.bloggerType === 'skincare_expert') {
        onUpdateInputs({ imageModel: 'Nano Banana Pro' });
      } else {
        onUpdateInputs({ imageModel: 'Imagen 4 Fast' });
      }
    }
  }, [inputs.platform, inputs.bloggerType, modelConfig.autoRecommendationEnabled]);

  const sampleImages = [
    {
      name: '晨间阳光浴室（小红书爆款）',
      url: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
    },
    {
      name: '左右脸对比测评（抖音卡点）',
      url: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
    },
  ];

  const handleCopyPrompt = async () => {
    if (output?.static_image_prompt) {
      await copyToClipboard(output.static_image_prompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    }
  };

  const handleCopyJson = async () => {
    if (output) {
      await copyToClipboard(JSON.stringify(output, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  };

  const handleSavePromptFromEditor = (updatedPromptText: string) => {
    if (editingQueueItemId) {
      setBatchQueue((prev) =>
        prev.map((item) =>
          item.id === editingQueueItemId && item.output
            ? { ...item, output: { ...item.output, static_image_prompt: updatedPromptText } }
            : item
        )
      );
    } else if (output && onUpdateOutput) {
      onUpdateOutput({ static_image_prompt: updatedPromptText });
    }
  };

  const handleRegenerateFromEditor = (updatedPromptText: string) => {
    if (editingQueueItemId) {
      runSingleQueueItem(editingQueueItemId);
    } else {
      if (output && onUpdateOutput) {
        onUpdateOutput({ static_image_prompt: updatedPromptText });
      }
      onRun();
    }
  };

  // --- BATCH PARALLEL QUEUE LOGIC ---
  const handleBatchFileUpload = async (files: FileList | File[]) => {
    const newItems: BatchStep1QueueItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const uploaded = await apiService.materials.uploadMaterial(file);
      newItems.push({
        id: 'batch_upload_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substring(2, 5),
        name: file.name,
        url: uploaded.url,
        type: file.type.startsWith('video') ? 'video' : 'image',
        size: (file.size / (1024 * 1024)).toFixed(1) + ' MB',
        status: 'pending',
        progress: 0,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
    }
    setBatchQueue((prev) => [...prev, ...newItems]);
  };

  // Run single item in queue
  const runSingleQueueItem = async (itemId: string) => {
    const item = batchQueue.find((q) => q.id === itemId);
    if (!item) return;

    setBatchQueue((prev) =>
      prev.map((q) => (q.id === itemId ? { ...q, status: 'running', progress: 30 } : q))
    );

    const startTime = Date.now();
    try {
      const res = await fetch('/api/pipeline/step1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaUrl: item.url,
          platform: inputs.platform,
          bloggerType: inputs.bloggerType,
          viralReason: inputs.viralReason || item.name,
          imageModel: inputs.imageModel,
          productInfo: activeProduct,
        }),
      });

      const result = await res.json();
      const executionTimeMs = Date.now() - startTime;

      if (result.success && result.data) {
        setBatchQueue((prev) =>
          prev.map((q) =>
            q.id === itemId
              ? {
                  ...q,
                  status: 'completed',
                  progress: 100,
                  output: result.data,
                  executionTimeMs,
                }
              : q
          )
        );
      } else {
        throw new Error(result.message || 'Reverse inference failed');
      }
    } catch (err: any) {
      setBatchQueue((prev) =>
        prev.map((q) =>
          q.id === itemId
            ? { ...q, status: 'failed', progress: 0, errorMessage: err.message || '处理异常' }
            : q
        )
      );
    }
  };

  // Run full batch queue in parallel (多任务并行同步处理)
  const runAllBatchParallel = async () => {
    const pendingItems = batchQueue.filter((q) => q.status === 'pending' || q.status === 'failed');
    if (pendingItems.length === 0) return;

    setIsBatchRunning(true);

    // Set all pending items to running status simultaneously
    setBatchQueue((prev) =>
      prev.map((q) =>
        q.status === 'pending' || q.status === 'failed' ? { ...q, status: 'running', progress: 20 } : q
      )
    );

    // Launch parallel HTTP requests concurrently using Promise.allSettled
    const parallelPromises = pendingItems.map(async (item) => {
      const startTime = Date.now();
      try {
        const res = await fetch('/api/pipeline/step1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mediaUrl: item.url,
            platform: inputs.platform,
            bloggerType: inputs.bloggerType,
            viralReason: inputs.viralReason || item.name,
            imageModel: inputs.imageModel,
            productInfo: activeProduct,
          }),
        });

        const result = await res.json();
        const executionTimeMs = Date.now() - startTime;

        if (result.success && result.data) {
          setBatchQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? {
                    ...q,
                    status: 'completed',
                    progress: 100,
                    output: result.data,
                    executionTimeMs,
                  }
                : q
            )
          );
        } else {
          throw new Error('API return failed');
        }
      } catch (err: any) {
        setBatchQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? { ...q, status: 'failed', progress: 0, errorMessage: '处理失败' }
              : q
          )
        );
      }
    });

    await Promise.allSettled(parallelPromises);
    setIsBatchRunning(false);
  };

  // Copy all completed prompts
  const handleCopyAllBatchPrompts = async () => {
    const completedItems = batchQueue.filter((q) => q.status === 'completed' && q.output);
    if (completedItems.length === 0) return;

    const formattedText = completedItems
      .map(
        (item, index) =>
          `【任务 #${index + 1} - ${item.name}】\nModel: ${inputs.imageModel || 'Imagen 4 Ultra'}\nPrompt: ${
            item.output?.static_image_prompt
          }\n`
      )
      .join('\n----------------------------------------\n\n');

    await copyToClipboard(formattedText);
    setCopiedBatchAll(true);
    setTimeout(() => setCopiedBatchAll(false), 2000);
  };

  // Export batch report
  const handleExportBatchJson = () => {
    const completedItems = batchQueue.filter((q) => q.status === 'completed' && q.output);
    const reportData = completedItems.map((item) => ({
      id: item.id,
      name: item.name,
      mediaUrl: item.url,
      executionTimeMs: item.executionTimeMs,
      output: item.output,
    }));
    downloadJsonFile(reportData, `batch_step1_prompts_${Date.now()}.json`);
  };

  // Set batch queue item as main pipeline active asset
  const handleApplyToMainPipeline = (item: BatchStep1QueueItem) => {
    if (!item.output) return;

    onUpdateInputs({
      mediaUrl: item.url,
    });

    if (onUpdateOutput) {
      onUpdateOutput(item.output);
    }

    setExecutionMode('single');
  };

  // Add demo package to queue
  const handleAddDemoPackage = () => {
    const demoPackage: BatchStep1QueueItem[] = [
      {
        id: 'demo_pack_1_' + Date.now(),
        name: '4K画质高清膏体拉丝特写.mp4',
        url: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
        type: 'video',
        size: '5.2 MB',
        status: 'pending',
        progress: 0,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: 'demo_pack_2_' + Date.now(),
        name: '真实晨间浴室自然光全效展示.mp4',
        url: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
        type: 'video',
        size: '3.8 MB',
        status: 'pending',
        progress: 0,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: 'demo_pack_3_' + Date.now(),
        name: '极简展台微距高光质感.mp4',
        url: 'https://images.unsplash.com/photo-1512290900673-7002fffe929a?auto=format&fit=crop&w=600&q=80',
        type: 'image',
        size: '2.9 MB',
        status: 'pending',
        progress: 0,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: 'demo_pack_4_' + Date.now(),
        name: '成分实验室自然绿植对比图.mp4',
        url: 'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=600&q=80',
        type: 'image',
        size: '4.1 MB',
        status: 'pending',
        progress: 0,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ];
    setBatchQueue((prev) => [...prev, ...demoPackage]);
  };

  // Import selected items from materials library
  const handleConfirmImportMaterials = () => {
    const selectedMaterials = materials.filter((m) => selectedImportIds.includes(m.id));
    const newItems: BatchStep1QueueItem[] = selectedMaterials.map((m) => ({
      id: 'import_' + m.id + '_' + Date.now(),
      name: m.name,
      url: m.url,
      type: m.type,
      size: m.size,
      status: 'pending',
      progress: 0,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }));
    setBatchQueue((prev) => [...prev, ...newItems]);
    setSelectedImportIds([]);
    setIsImportModalOpen(false);
  };

  const currentSelectedModelMeta = enabledImageModels.find(
    (m) => m.id === (inputs.imageModel || 'Imagen 4 Ultra')
  );

  // Queue Statistics
  const totalTasks = batchQueue.length;
  const pendingTasks = batchQueue.filter((q) => q.status === 'pending').length;
  const runningTasks = batchQueue.filter((q) => q.status === 'running').length;
  const completedTasks = batchQueue.filter((q) => q.status === 'completed').length;
  const failedTasks = batchQueue.filter((q) => q.status === 'failed').length;
  const batchOverallProgress =
    totalTasks > 0 ? Math.round(((completedTasks + failedTasks) / totalTasks) * 100) : 0;

  // Active modal target output prompt
  const editingQueueItem = batchQueue.find((q) => q.id === editingQueueItemId);

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-white dark:bg-slate-900 overflow-y-auto p-6 md:p-8 flex flex-col shadow-2xl transition-all'
          : 'bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl shadow-surface-md overflow-hidden transition-all'
      }
    >
      {/* Top Header & Mode Toggle Bar */}
      <div className="px-6 py-4 bg-slate-50/80 dark:bg-slate-900 border-b border-slate-200/80 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-slate-900 text-white font-bold flex items-center justify-center shadow-xs shrink-0">
            1
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                第 1 步：视频 / Live图 → 同款静态图提示词
              </h3>
              <span className="text-[11px] font-bold text-indigo-900 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/80 border border-indigo-200 dark:border-indigo-800 px-2.5 py-0.5 rounded-full">
                AI 视觉拆解引擎
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              视觉深度理解 + 结构化 Prompt 拆解（支持单素材精细拆解与多素材批量反推）
            </p>
          </div>
        </div>

        {/* Header Right Actions & Fullscreen Toggle */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs ${
              isFullscreen
                ? 'bg-slate-900 text-white hover:bg-slate-800'
                : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
            }`}
            title={isFullscreen ? '退出全屏沉浸模式' : '进入全屏沉浸模式操作'}
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" />
                <span>退出全屏</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5 text-indigo-600" />
                <span>全屏沉浸</span>
              </>
            )}
          </button>
        </div>

        {/* Mode Switcher Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-200/80 dark:bg-slate-800 rounded-xl border border-slate-300/60 dark:border-slate-700/60 shrink-0">
          <button
            onClick={() => setExecutionMode('single')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              executionMode === 'single'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-600" />
            <span>单素材精细拆解</span>
          </button>

          <button
            onClick={() => setExecutionMode('batch')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all relative ${
              executionMode === 'batch'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            <Zap className="w-3.5 h-3.5 text-amber-300 fill-current" />
            <span>⚡ 批量并发反推 (多任务队列)</span>
            {pendingTasks > 0 && (
              <span className="ml-1 px-1.5 py-0.2 bg-amber-400 text-slate-950 font-black text-[10px] rounded-full">
                {pendingTasks}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ------------------- MODE 1: SINGLE MATERIAL DETAILED REVERSE INFERENCE ------------------- */}
      {executionMode === 'single' && (
        <div>
          {/* Action Bar for Single Mode */}
          <div className="px-6 py-2.5 bg-slate-100/60 dark:bg-slate-900/60 border-b border-slate-200/60 dark:border-slate-800 flex items-center justify-end gap-2">
            <button
              onClick={onReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shadow-surface-sm"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>重置</span>
            </button>

            {isCompleted && (
              <button
                onClick={() => downloadJsonFile(output, 'step1_static_prompt.json')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shadow-surface-sm"
              >
                <Download className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>下载 Prompt</span>
              </button>
            )}

            <button
              onClick={onRun}
              disabled={isRunning}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all shadow-md shadow-emerald-600/20"
            >
              {isRunning ? (
                <>
                  <Sparkles className="w-3.5 h-3.5 animate-spin" />
                  <span>AI 拆解中...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>运行 </span>
                </>
              )}
            </button>

            <button
              onClick={onNext}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shadow-surface-sm"
            >
              <span>下一步</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Inputs Column */}
            <div className="lg:col-span-5 space-y-4 border-r border-slate-200/80 pr-0 lg:pr-6">
              <div className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Upload className="w-4 h-4" />
                  <span>1. 输入画面与场景上下文</span>
                </span>
                <button
                  onClick={() => setExecutionMode('batch')}
                  className="text-[11px] text-amber-600 dark:text-amber-400 hover:underline flex items-center gap-1 font-bold"
                >
                  <Zap className="w-3 h-3 fill-current" />
                  切换多素材批量反推
                </button>
              </div>

              {/* Media Preview / Drag Area */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    爆款视频帧 / Live 图 / 封面图 (必填)
                  </label>
                  {onOpenMaterials && (
                    <button
                      type="button"
                      onClick={onOpenMaterials}
                      className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold hover:underline flex items-center gap-1"
                    >
                      <ImageIcon className="w-3 h-3" />
                      从素材库中挑选
                    </button>
                  )}
                </div>

                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={async (e) => {
                    e.preventDefault();
                    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                      const uploaded = await apiService.materials.uploadMaterial(e.dataTransfer.files[0]);
                      onUpdateInputs({ mediaUrl: uploaded.url });
                    }
                  }}
                  className="relative group border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-emerald-500 dark:hover:border-emerald-400 rounded-xl p-3 bg-slate-50 dark:bg-slate-900 text-center transition-all cursor-pointer overflow-hidden"
                >
                  <input
                    type="file"
                    accept="video/*,image/*"
                    onChange={async (e) => {
                      if (e.target.files && e.target.files[0]) {
                        const uploaded = await apiService.materials.uploadMaterial(e.target.files[0]);
                        onUpdateInputs({ mediaUrl: uploaded.url });
                      }
                    }}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  />

                  {inputs.mediaUrl ? (
                    <div className="relative w-full h-44 rounded-lg overflow-hidden group">
                      <img
                        src={inputs.mediaUrl}
                        alt="Uploaded source"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity pointer-events-none">
                        <span className="text-xs text-white font-medium">点击或拖拽更换画面素材</span>
                      </div>
                    </div>
                  ) : (
                    <div className="py-6 flex flex-col items-center justify-center gap-2 pointer-events-none">
                      <ImageIcon className="w-8 h-8 text-slate-400 group-hover:text-emerald-600 transition-colors" />
                      <p className="text-xs text-slate-700 dark:text-slate-300 font-medium">
                        拖拽视频/图片至此，或点击本地上传
                      </p>
                      <p className="text-[11px] text-slate-400">支持 MP4 抽帧 / JPG / PNG / Live Photo</p>
                    </div>
                  )}
                </div>

                {/* Quick Sample Selector */}
                <div className="pt-1">
                  <span className="text-[11px] text-slate-500 block mb-1.5">或选择内置爆款素材：</span>
                  <div className="grid grid-cols-2 gap-2">
                    {sampleImages.map((sample, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => onUpdateInputs({ mediaUrl: sample.url })}
                        className={`flex items-center gap-2 p-2 rounded-lg text-left border text-xs transition-all ${
                          inputs.mediaUrl === sample.url
                            ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        <img src={sample.url} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                        <span className="line-clamp-1 truncate text-[11px]">{sample.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Context Options */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1">
                    来源平台
                  </label>
                  <select
                    value={inputs.platform}
                    onChange={(e) => onUpdateInputs({ platform: e.target.value as any })}
                    className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500 font-medium shadow-sm"
                  >
                    <option value="xiaohongshu">小红书（治愈种草）</option>
                    <option value="douyin">抖音（卡点冲击）</option>
                    <option value="shipinhao">视频号（信任品质）</option>
                    <option value="general">通用平台</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1">
                    博主类型
                  </label>
                  <select
                    value={inputs.bloggerType}
                    onChange={(e) => onUpdateInputs({ bloggerType: e.target.value as any })}
                    className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500 font-medium shadow-sm"
                  >
                    <option value="daily_seeding">日常种草（真实生活）</option>
                    <option value="skincare_expert">护肤达人（成分解析）</option>
                    <option value="ingredient_geek">成分党（硬核测评）</option>
                    <option value="review_beauty">美妆测评（红黑榜）</option>
                  </select>
                </div>
              </div>

              {/* Image Model Selector */}
              <div className="p-3 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl space-y-2">
                <div className="flex items-center justify-between text-xs font-medium text-slate-800 dark:text-slate-200">
                  <span className="flex items-center gap-1.5 font-bold">
                    <Cpu className="w-3.5 h-3.5 text-emerald-600" />
                    目标图片生成 AI 模型 (Image Model)
                  </span>
                  <span className="text-[10px] text-emerald-700 bg-emerald-100 dark:bg-emerald-950/80 px-2 py-0.5 rounded font-medium">
                    AI 自动推荐适配
                  </span>
                </div>

                <select
                  value={inputs.imageModel || 'Imagen 4 Ultra'}
                  onChange={(e) => onUpdateInputs({ imageModel: e.target.value as any })}
                  className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-500 font-semibold shadow-sm"
                >
                  {enabledImageModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} — {m.recommendedScenario} ({m.speedRating})
                    </option>
                  ))}
                </select>

                {currentSelectedModelMeta && (
                  <div className="text-[11px] bg-white dark:bg-slate-900 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">推荐场景:</span>
                      <span className="font-medium text-slate-800 dark:text-slate-200">{currentSelectedModelMeta.recommendedScenario}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">预估速度:</span>
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                        {currentSelectedModelMeta.speedRating} ({currentSelectedModelMeta.speedMs})
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">画质评级:</span>
                      <span className="font-semibold text-indigo-600 dark:text-indigo-400">{currentSelectedModelMeta.qualityRating}</span>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1">
                  爆款转化因（可选）
                </label>
                <textarea
                  value={inputs.viralReason}
                  onChange={(e) => onUpdateInputs({ viralReason: e.target.value })}
                  placeholder="例如：自然透光+膏体冰淇淋质感+低饱和度视觉，带来强治愈信任感"
                  className="w-full h-20 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500 placeholder:text-slate-400 resize-none shadow-sm"
                />
              </div>
            </div>

            {/* Right Output Column */}
            <div className="lg:col-span-7 flex flex-col justify-between bg-slate-950 p-5 rounded-2xl border border-slate-800 shadow-inner">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4" />
                    <span>2. 静态图 Prompt 结构化产物</span>
                  </div>

                  {isCompleted && (
                    <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                      <button
                        onClick={() => setActiveTab('visual')}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                          activeTab === 'visual'
                            ? 'bg-emerald-500 text-slate-950 font-bold'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <Eye className="w-3 h-3 inline mr-1" />
                        可视化卡片
                      </button>
                      <button
                        onClick={() => setActiveTab('json')}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                          activeTab === 'json'
                            ? 'bg-emerald-500 text-slate-950 font-bold'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <FileCode className="w-3 h-3 inline mr-1" />
                        JSON 代码
                      </button>
                    </div>
                  )}
                </div>

                {/* Output Display Area */}
                {!output ? (
                  <div className="h-64 rounded-xl border border-dashed border-slate-800 bg-slate-900/50 flex flex-col items-center justify-center p-6 text-center">
                    <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mb-3 text-slate-500">
                      <ImageIcon className="w-6 h-6" />
                    </div>
                    <p className="text-xs text-slate-300 font-medium">
                      点击【启动拆解】开始第 1 步视觉拆解与生成
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      （系统将自动提取画面色板、镜头构图、情绪与 Midjourney/Imagen 提示词）
                    </p>
                  </div>
                ) : activeTab === 'visual' ? (
                  <div className="space-y-4 animate-fade-in">
                    {/* Color Palette Badge Row */}
                    <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800">
                      <div className="flex items-center gap-2 mb-2 text-xs font-bold text-slate-300">
                        <Palette className="w-3.5 h-3.5 text-emerald-400" />
                        <span>画面拆解色板 (Palette)</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {output.palette.map((color, idx) => {
                          const hexMatch = color.match(/#[0-9A-Fa-f]{6}/);
                          const hex = hexMatch ? hexMatch[0] : '#00B060';
                          return (
                            <div
                              key={idx}
                              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono text-slate-200"
                            >
                              <span
                                className="w-3.5 h-3.5 rounded-full border border-white/20 shadow-sm"
                                style={{ backgroundColor: hex }}
                              />
                              <span>{color}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Structured Attributes Grid */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="p-3 rounded-lg bg-slate-900 border border-slate-800/80">
                        <span className="text-[10px] text-slate-400 block font-mono uppercase">场景 (Scene)</span>
                        <span className="text-xs font-semibold text-slate-200">{output.scene}</span>
                      </div>

                      <div className="p-3 rounded-lg bg-slate-900 border border-slate-800/80">
                        <span className="text-[10px] text-slate-400 block font-mono uppercase">主体 (Subject)</span>
                        <span className="text-xs font-semibold text-slate-200">{output.subject}</span>
                      </div>

                      <div className="p-3 rounded-lg bg-slate-900 border border-slate-800/80">
                        <span className="text-[10px] text-slate-400 block font-mono uppercase">光线 (Lighting)</span>
                        <span className="text-xs font-semibold text-slate-200">{output.lighting}</span>
                      </div>

                      <div className="p-3 rounded-lg bg-slate-900 border border-slate-800/80">
                        <span className="text-[10px] text-slate-400 block font-mono uppercase">镜头语言 (Camera)</span>
                        <span className="text-xs font-semibold text-slate-200">{output.camera}</span>
                      </div>
                    </div>

                    {/* Static Image Prompt Block */}
                    <div className="p-4 rounded-xl bg-slate-900 border border-emerald-500/30 relative group space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-emerald-400 font-mono flex items-center gap-2">
                          <span>static_image_prompt</span>
                          <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30 text-[10px] text-emerald-300">
                            {inputs.imageModel || 'Imagen 4 Ultra'} 适配
                          </span>
                        </span>

                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => {
                              setEditingQueueItemId(null);
                              setIsPromptEditorOpen(true);
                            }}
                            className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors border border-slate-700"
                            title="查看与完整编辑 Prompt"
                          >
                            <Edit3 className="w-3.5 h-3.5 text-emerald-400" />
                            <span>查看 / 编辑</span>
                          </button>

                          <button
                            onClick={handleCopyPrompt}
                            className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-xs transition-colors border border-emerald-500/30"
                          >
                            {copiedPrompt ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            <span>{copiedPrompt ? '已复制' : '复制 Prompt'}</span>
                          </button>
                        </div>
                      </div>

                      <p className="text-xs text-slate-200 font-mono leading-relaxed bg-slate-950 p-3 rounded-lg border border-slate-800 select-all">
                        {output.static_image_prompt}
                      </p>

                      <div className="pt-1 flex items-center justify-between">
                        <span className="text-[11px] text-slate-400">
                          💡 核心资产：点击右侧按钮可用修改后的 Prompt 重新生图
                        </span>
                        <button
                          onClick={() => {
                            setEditingQueueItemId(null);
                            setIsPromptEditorOpen(true);
                          }}
                          className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                        >
                          <RefreshCw className="w-3 h-3" />
                          <span>重新生成图片</span>
                        </button>
                      </div>
                    </div>

                    {/* Rationale explanation */}
                    <div className="p-3.5 rounded-xl bg-emerald-950/30 border border-emerald-500/20 text-xs text-emerald-200/90 flex items-start gap-2">
                      <Info className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold block text-emerald-300 mb-0.5">拆解转化逻辑：</span>
                        {output.rationale}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* JSON Code View */
                  <div className="relative group animate-fade-in">
                    <button
                      onClick={handleCopyJson}
                      className="absolute top-3 right-3 z-10 flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 text-slate-300 text-xs hover:bg-slate-700 transition-colors"
                    >
                      {copiedJson ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedJson ? '已复制 JSON' : '复制 JSON'}</span>
                    </button>

                    <pre className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-emerald-400 font-mono overflow-x-auto max-h-96 leading-relaxed">
                      {JSON.stringify(output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>

              {/* Bottom Step Transfer Notice */}
              {isCompleted && (
                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                  <span className="text-emerald-400/90 font-mono">
                    ✓ 静态图 Prompt 已生成，将自动注入第 2 步视频提示词引擎
                  </span>
                  <button
                    onClick={onNext}
                    className="flex items-center gap-1 font-bold text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    <span>下一步：生成视频提示词</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ------------------- MODE 2: BATCH MATERIAL PARALLEL REVERSE INFERENCE QUEUE ------------------- */}
      {executionMode === 'batch' && (
        <div className="p-6 space-y-6">
          {/* Top Control & Upload Bar */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
            {/* Batch Drag & Drop Upload Zone */}
            <div className="lg:col-span-7 bg-slate-50 dark:bg-slate-800/50 border-2 border-dashed border-emerald-300 dark:border-emerald-800 hover:border-emerald-500 rounded-2xl p-5 text-center flex flex-col items-center justify-center relative transition-all group cursor-pointer">
              <input
                type="file"
                multiple
                accept="video/*,image/*"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleBatchFileUpload(e.target.files);
                  }
                }}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              />
              <div className="w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-950/80 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-2 shadow-sm group-hover:scale-105 transition-transform">
                <Upload className="w-6 h-6" />
              </div>
              <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                点击或拖拽【批量上传】多文件素材 (MP4 / GIF / PNG)
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md">
                按住 Ctrl / Shift 键可一次性挑选多个视频或爆款图片帧，系统将自动加入并发拆解队列
              </p>

              <div className="flex items-center gap-2 mt-3 z-20">
                {materials.length > 0 && (
                  <button
                    onClick={() => setIsImportModalOpen(true)}
                    className="px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold hover:border-emerald-400 flex items-center gap-1.5 shadow-sm"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-emerald-600" />
                    <span>从素材库批量导入 ({materials.length})</span>
                  </button>
                )}
              </div>
            </div>

            {/* Queue Stats & Parallel Launch Control Box */}
            <div className="lg:col-span-5 bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 rounded-2xl p-5 text-white flex flex-col justify-between shadow-xl space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-400 fill-current" />
                    <span className="text-xs font-bold font-mono text-emerald-400 uppercase tracking-wider">
                      多任务队列统计概览
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-mono border border-emerald-500/30">
                    AI 8 线程极速并发处理
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-2 mt-3 text-center">
                  <div className="p-2 rounded-xl bg-slate-900/80 border border-slate-800">
                    <span className="text-[10px] text-slate-400 block">队列总数</span>
                    <span className="text-base font-extrabold text-slate-100">{totalTasks}</span>
                  </div>
                  <div className="p-2 rounded-xl bg-slate-900/80 border border-slate-800">
                    <span className="text-[10px] text-amber-400 block">等待中</span>
                    <span className="text-base font-extrabold text-amber-300">{pendingTasks}</span>
                  </div>
                  <div className="p-2 rounded-xl bg-slate-900/80 border border-slate-800">
                    <span className="text-[10px] text-emerald-400 block">并发处理</span>
                    <span className="text-base font-extrabold text-emerald-400">{runningTasks}</span>
                  </div>
                  <div className="p-2 rounded-xl bg-slate-900/80 border border-slate-800">
                    <span className="text-[10px] text-indigo-400 block">已完成</span>
                    <span className="text-base font-extrabold text-indigo-300">{completedTasks}</span>
                  </div>
                </div>

                {/* Overall Batch Progress Bar */}
                <div className="mt-3 space-y-1">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                    <span>队列总体进度: {batchOverallProgress}%</span>
                    <span>
                      {completedTasks} / {totalTasks} 完成
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-300 h-full transition-all duration-300"
                      style={{ width: `${batchOverallProgress}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                <button
                  onClick={runAllBatchParallel}
                  disabled={isBatchRunning || pendingTasks === 0}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-extrabold text-xs transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                >
                  {isBatchRunning ? (
                    <>
                      <Sparkles className="w-4 h-4 animate-spin" />
                      <span>多任务 AI 同步并发反推中...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4 fill-current text-slate-950" />
                      <span> 一键全量并发拆解 ({pendingTasks}个等待中)</span>
                    </>
                  )}
                </button>

                {completedTasks > 0 && (
                  <button
                    onClick={handleCopyAllBatchPrompts}
                    className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition-all flex items-center gap-1.5"
                    title="复制所有已生成的静态图提示词"
                  >
                    {copiedBatchAll ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedBatchAll ? '已复制全部' : '复制 Prompt'}</span>
                  </button>
                )}

                {completedTasks > 0 && (
                  <button
                    onClick={handleExportBatchJson}
                    className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs transition-all"
                    title="导出批量 JSON 拆解报告"
                  >
                    <Download className="w-3.5 h-3.5 text-emerald-400" />
                  </button>
                )}

                <button
                  onClick={() => setBatchQueue([])}
                  disabled={isBatchRunning || totalTasks === 0}
                  className="p-2.5 rounded-xl bg-slate-800 hover:bg-rose-900/40 hover:text-rose-300 text-slate-400 border border-slate-700 text-xs transition-all disabled:opacity-40"
                  title="清空多任务队列"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Visual Task Queue List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ListChecks className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  可视化任务队列明细 ({totalTasks} 项)
                </h4>
              </div>

              <div className="text-xs text-slate-500 flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-slate-400" />
                  等待处理 ({pendingTasks})
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                  AI 并行中 ({runningTasks})
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-indigo-500" />
                  已完成 ({completedTasks})
                </span>
              </div>
            </div>

            {batchQueue.length === 0 ? (
              <div className="p-10 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-center">
                <Layers className="w-10 h-10 text-slate-300 dark:text-slate-700 mx-auto mb-2" />
                <p className="text-sm font-bold text-slate-700 dark:text-slate-300">队列为空</p>
                <p className="text-xs text-slate-400 mt-1">请在上方上传或选择素材加入多任务队列</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {batchQueue.map((item, index) => (
                  <div
                    key={item.id}
                    className={`p-4 rounded-2xl border transition-all ${
                      item.status === 'completed'
                        ? 'bg-white dark:bg-slate-900 border-emerald-200 dark:border-emerald-900/60 shadow-surface-sm hover:shadow-surface-md'
                        : item.status === 'running'
                        ? 'bg-slate-900 text-white border-emerald-500/80 shadow-lg'
                        : item.status === 'failed'
                        ? 'bg-rose-50/50 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/60'
                        : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800'
                    }`}
                  >
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      {/* Left File Info & Thumbnail */}
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="relative w-16 h-16 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 shrink-0 bg-slate-900">
                          <img
                            src={item.url}
                            alt={item.name}
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-slate-950/80 text-[9px] font-bold text-white font-mono uppercase">
                            {item.type === 'video' ? 'MP4' : 'IMG'}
                          </div>
                        </div>

                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-bold text-slate-400">
                              #{index + 1}
                            </span>
                            <h5 className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate max-w-xs md:max-w-md">
                              {item.name}
                            </h5>
                          </div>

                          <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                            <span>大小: {item.size || '未知'}</span>
                            <span>•</span>
                            <span>创建: {item.createdAt}</span>
                            {item.executionTimeMs && (
                              <>
                                <span>•</span>
                                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                                  耗时: {item.executionTimeMs}ms
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Middle Status Pill & Progress Bar */}
                      <div className="flex items-center gap-3 shrink-0">
                        {item.status === 'pending' && (
                          <span className="px-3 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-semibold flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-slate-400" />
                            <span>等待处理</span>
                          </span>
                        )}

                        {item.status === 'running' && (
                          <div className="space-y-1 text-right">
                            <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center gap-1.5 animate-pulse">
                              <Sparkles className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                              <span>AI 并发拆解中 ({item.progress}%)</span>
                            </span>
                            <div className="w-32 bg-slate-800 rounded-full h-1.5 overflow-hidden ml-auto">
                              <div
                                className="bg-emerald-400 h-full transition-all duration-300"
                                style={{ width: `${item.progress}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {item.status === 'completed' && (
                          <span className="px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800 text-xs font-bold flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span>拆解完成</span>
                          </span>
                        )}

                        {item.status === 'failed' && (
                          <span className="px-3 py-1 rounded-full bg-rose-100 dark:bg-rose-950/80 text-rose-800 dark:text-rose-300 border border-rose-300 dark:border-rose-800 text-xs font-bold flex items-center gap-1.5">
                            <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                            <span>处理异常</span>
                          </span>
                        )}

                        {/* Actions for Item */}
                        <div className="flex items-center gap-1.5">
                          {item.status === 'pending' || item.status === 'failed' ? (
                            <button
                              onClick={() => runSingleQueueItem(item.id)}
                              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              <span>反推</span>
                            </button>
                          ) : item.status === 'completed' ? (
                            <button
                              onClick={() => handleApplyToMainPipeline(item)}
                              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1"
                              title="将此任务素材与 Prompt 注入主流水线第1、2步"
                            >
                              <Zap className="w-3 h-3 fill-current text-amber-300" />
                              <span>设为主线素材</span>
                            </button>
                          ) : null}

                          <button
                            onClick={() =>
                              setBatchQueue((prev) => prev.filter((q) => q.id !== item.id))
                            }
                            disabled={item.status === 'running'}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition-colors disabled:opacity-30"
                            title="从队列删除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Output Result Preview for Completed Queue Item */}
                    {item.status === 'completed' && item.output && (
                      <div className="mt-3 pt-3 border-t border-slate-200/80 dark:border-slate-800 grid grid-cols-1 md:grid-cols-12 gap-3 text-xs">
                        <div className="md:col-span-8 p-3 rounded-xl bg-slate-900 text-slate-100 font-mono space-y-1.5 relative group">
                          <div className="flex items-center justify-between text-[11px] text-emerald-400 font-bold">
                            <span>static_image_prompt:</span>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={async () => {
                                  if (item.output?.static_image_prompt) {
                                    await copyToClipboard(item.output.static_image_prompt);
                                  }
                                }}
                                className="text-slate-400 hover:text-emerald-300 flex items-center gap-1"
                              >
                                <Copy className="w-3 h-3" />
                                <span>复制</span>
                              </button>
                              <button
                                onClick={() => {
                                  setEditingQueueItemId(item.id);
                                  setIsPromptEditorOpen(true);
                                }}
                                className="text-emerald-400 hover:underline flex items-center gap-1 font-semibold"
                              >
                                <Edit3 className="w-3 h-3" />
                                <span>精细编辑</span>
                              </button>
                            </div>
                          </div>
                          <p className="line-clamp-2 text-slate-200 text-xs leading-relaxed">
                            {item.output.static_image_prompt}
                          </p>
                        </div>

                        <div className="md:col-span-4 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 flex flex-col justify-between">
                          <span className="text-[10px] font-bold text-slate-500 uppercase">
                            拆解色板与场景
                          </span>
                          <div className="flex flex-wrap gap-1.5 my-1">
                            {item.output.palette.map((color, idx) => {
                              const hexMatch = color.match(/#[0-9A-Fa-f]{6}/);
                              const hex = hexMatch ? hexMatch[0] : '#00B060';
                              return (
                                <span
                                  key={idx}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white dark:bg-slate-900 border text-[10px] font-mono text-slate-700 dark:text-slate-300"
                                >
                                  <span
                                    className="w-2.5 h-2.5 rounded-full border"
                                    style={{ backgroundColor: hex }}
                                  />
                                  <span>{color.split(' ')[0]}</span>
                                </span>
                              );
                            })}
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                            场景: {item.output.scene}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal for importing materials from materials library */}
      {isImportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm animate-fade-in">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden text-slate-900 dark:text-slate-100 flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
              <div className="flex items-center gap-2">
                <FolderPlus className="w-5 h-5 text-emerald-600" />
                <h4 className="font-bold text-base">从素材库批量选中导入队列</h4>
              </div>
              <button
                onClick={() => setIsImportModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-3 flex-1">
              <p className="text-xs text-slate-500">
                勾选需要加入并发反推队列的素材，点击下方确认导入按钮：
              </p>

              <div className="space-y-2">
                {materials.map((m) => {
                  const isChecked = selectedImportIds.includes(m.id);
                  return (
                    <label
                      key={m.id}
                      onClick={() =>
                        setSelectedImportIds((prev) =>
                          isChecked ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                        )
                      }
                      className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                        isChecked
                          ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-500'
                          : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <img
                          src={m.url}
                          alt=""
                          className="w-12 h-12 rounded-lg object-cover border border-slate-200 shrink-0"
                        />
                        <div>
                          <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                            {m.name}
                          </p>
                          <p className="text-[11px] text-slate-400">
                            {m.type.toUpperCase()} • {m.size}
                          </p>
                        </div>
                      </div>

                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="w-4 h-4 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500"
                      />
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <span className="text-xs text-slate-500 font-mono">
                已选中 {selectedImportIds.length} 项素材
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsImportModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800"
                >
                  取消
                </button>
                <button
                  onClick={handleConfirmImportMaterials}
                  disabled={selectedImportIds.length === 0}
                  className="px-5 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 transition-all shadow-md shadow-emerald-600/20"
                >
                  确认导入队列
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Prompt Editor Modal */}
      {(output || editingQueueItem?.output) && (
        <PromptEditorModal
          isOpen={isPromptEditorOpen}
          onClose={() => {
            setIsPromptEditorOpen(false);
            setEditingQueueItemId(null);
          }}
          title={
            editingQueueItem
              ? `队列任务【${editingQueueItem.name}】静态图 Prompt 精细化编辑器`
              : '第 1 步：静态图 Prompt 精细化编辑器'
          }
          promptType="static_image_prompt"
          modelName={inputs.imageModel || 'Imagen 4 Ultra'}
          initialPrompt={
            editingQueueItem?.output?.static_image_prompt || output?.static_image_prompt || ''
          }
          onSavePrompt={handleSavePromptFromEditor}
          onRegenerate={handleRegenerateFromEditor}
          isRegenerating={editingQueueItem ? editingQueueItem.status === 'running' : isRunning}
        />
      )}
    </div>
  );
};

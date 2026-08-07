import React, { useState, useEffect } from 'react';
import { CandidateImageItem, Step2Inputs, Step2Output, Step1Output, StepStatus } from '../types';
import { copyToClipboard, downloadJsonFile } from '../utils/format';
import { notify } from '../services/notifications';
import {
  Video,
  Play,
  RotateCcw,
  Download,
  Copy,
  Check,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  MoveUpRight,
  Gauge,
  Film,
  FileCode,
  Eye,
  Edit3,
  RefreshCw,
  Cpu,
  Maximize2,
  Minimize2,
  Image as ImageIcon,
  Grid,
  CheckCircle2,
  Clock,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import { ModelConfigState, DEFAULT_TEXT_MODEL, DEFAULT_VIDEO_MODEL, DEFAULT_IMAGE_MODEL } from '../data/models';
import { PromptEditorModal } from './PromptEditorModal';
import { StepModelPicker } from './StepModelPicker';
import { ShotGenerationTracker } from './ShotGenerationTracker';

interface Step2CardProps {
  inputs: Step2Inputs;
  output?: Step2Output;
  step1Output?: Step1Output;
  status: StepStatus;
  modelConfig: ModelConfigState;
  onUpdateInputs: (inputs: Partial<Step2Inputs>) => void;
  onUpdateOutput?: (updatedOutput: Partial<Step2Output>) => void;
  onSyncFromStep1?: () => void;
  onRun: () => void;
  onAbort?: () => void;
  onReset: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Upstream Step1 re-ran; current step artifacts may be outdated */
  upstreamStale?: boolean;
}

export const Step2Card: React.FC<Step2CardProps> = React.memo(({
  inputs,
  output,
  step1Output,
  status,
  modelConfig,
  onUpdateInputs,
  onUpdateOutput,
  onSyncFromStep1,
  onRun,
  onAbort,
  onReset,
  onPrev,
  onNext,
  upstreamStale = false,
}) => {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [activeTab, setActiveTab] = useState<'visual' | 'json'>('visual');
  // S2：Step2 明确分为「首帧创意」与「镜头生成」两个认知阶段
  const [phase, setPhase] = useState<'first_frame' | 'shots'>('first_frame');
  useEffect(() => {
    if (output?.multiShotResult) setPhase('shots');
  }, [output?.multiShotResult]);
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // AI 生图候选集状态
  const [isGeneratingCandidates, setIsGeneratingCandidates] = useState(false);
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null);

  const isRunning = status === 'running';
  const isCompleted = status === 'completed' && Boolean(output);

  // Auto-pick defaults when model config loads
  useEffect(() => {
    if (!modelConfig.autoRecommendationEnabled) return;
    const patch: Partial<Step2Inputs> = {};
    if (!inputs.textModel) {
      patch.textModel =
        modelConfig.defaultTextModel ||
        modelConfig.textModels.find((m) => m.enabled && m.isDefault)?.id ||
        modelConfig.textModels.find((m) => m.enabled)?.id ||
        DEFAULT_TEXT_MODEL;
    }
    if (!inputs.videoModel) {
      patch.videoModel =
        modelConfig.defaultVideoModel ||
        modelConfig.videoModels.find((m) => m.enabled && m.isDefault)?.id ||
        modelConfig.videoModels.find((m) => m.enabled)?.id ||
        DEFAULT_VIDEO_MODEL;
    }
    if (Object.keys(patch).length) onUpdateInputs(patch);
  }, [
    modelConfig.autoRecommendationEnabled,
    modelConfig.defaultTextModel,
    modelConfig.defaultVideoModel,
    modelConfig.textModels.length,
    modelConfig.videoModels.length,
  ]);

  // 批量调用生图大模型（GPT-Image-1 / 云雾）生成 3 张素材选优
  const handleGenerateCandidates = async () => {
    const prompt =
      inputs.static_image_prompt ||
      step1Output?.static_image_prompt ||
      '高清商业爆款产品质感拉丝特写，小红书极简风摄影';
    if (!prompt.trim()) {
      notify('请先填写或解构出 static_image_prompt 生图提示词', 'error');
      return;
    }
    setIsGeneratingCandidates(true);
    try {
      const promises = [1, 2, 3].map(() =>
        fetch('/api/pipeline/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            imageModel: inputs.imageModel,
          }),
        }).then((res) => res.json())
      );

      const results = await Promise.all(promises);
      const newCandidates: CandidateImageItem[] = [];

      results.forEach((res, idx) => {
        if (res.success && res.data?.imageUrl) {
          newCandidates.push({
            id: `cand_${Date.now()}_${idx}`,
            url: res.data.imageUrl,
            promptUsed: res.data.promptUsed || prompt,
            createdAt: Date.now(),
          });
        }
      });

      if (newCandidates.length > 0) {
        const existing = inputs.candidateImages || [];
        const merged = [...newCandidates, ...existing];
        onUpdateInputs({
          candidateImages: merged,
          selectedImageId: newCandidates[0].id,
          imageUrl: newCandidates[0].url,
        });
      } else {
        notify('生成素材图失败，请检查画图大模型配置与 API Key', 'error');
      }
    } catch (err: any) {
      notify(`生成生图素材失败: ${err?.message || '网络异常'}`, 'error');
    } finally {
      setIsGeneratingCandidates(false);
    }
  };

  const handleSelectCandidate = (cand: CandidateImageItem) => {
    onUpdateInputs({
      selectedImageId: cand.id,
      imageUrl: cand.url,
    });
  };

  const [seedanceWaitSec, setSeedanceWaitSec] = useState(0);

  // Poll Seedance task until video URL is ready
  useEffect(() => {
    const taskId = output?.seedanceTaskId;
    const st = (output?.seedanceStatus || '').toLowerCase();
    const done =
      !taskId ||
      Boolean(output?.previewVideoUrl) ||
      st === 'success' ||
      st === 'completed' ||
      st === 'failed' ||
      st === 'error' ||
      st === 'submit_failed' ||
      st === 'unconfigured' ||
      st === 'not_configured' ||
      st === 'timeout';

    if (done || !onUpdateOutput) {
      if (output?.previewVideoUrl) setSeedanceWaitSec(0);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 60;
    const startedAt = Date.now();
    setSeedanceWaitSec(0);

    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      setSeedanceWaitSec(Math.floor((Date.now() - startedAt) / 1000));
      try {
        const res = await fetch(`/api/seedance/generations/${encodeURIComponent(taskId!)}`);
        const json = await res.json();
        if (!json.success || !json.data) {
          if (attempts >= maxAttempts) {
            onUpdateOutput({ seedanceStatus: 'error', seedanceError: json.error || '轮询超时' });
          }
          return;
        }
        const task = json.data as {
          status?: string;
          url?: string;
          error?: string;
          inferenceId?: string;
        };
        const nextStatus = task.status || 'processing';
        onUpdateOutput({
          seedanceStatus: nextStatus,
          previewVideoUrl: task.url || output?.previewVideoUrl,
          seedanceInferenceId: task.inferenceId || output?.seedanceInferenceId,
          seedanceError: task.error || undefined,
        });
        if (
          task.url ||
          nextStatus === 'success' ||
          nextStatus === 'completed' ||
          nextStatus === 'failed' ||
          nextStatus === 'error'
        ) {
          cancelled = true;
        }
      } catch (err: any) {
        if (attempts >= maxAttempts) {
          onUpdateOutput({ seedanceStatus: 'error', seedanceError: err?.message || '轮询失败' });
          cancelled = true;
        }
      }
    };

    void tick();
    const timer = setInterval(() => {
      if (cancelled || attempts >= maxAttempts) {
        clearInterval(timer);
        if (attempts >= maxAttempts && !cancelled) {
          onUpdateOutput({ seedanceStatus: 'error', seedanceError: 'Seedance 轮询超时（约 3 分钟）' });
        }
        return;
      }
      void tick();
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [output?.seedanceTaskId, output?.seedanceStatus, output?.previewVideoUrl, onUpdateOutput]);

  const handleCopyPrompt = async () => {
    if (output?.video_prompt) {
      await copyToClipboard(output.video_prompt);
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
    if (output && onUpdateOutput) {
      onUpdateOutput({ video_prompt: updatedPromptText });
    }
  };

  const handleRegenerateFromEditor = (updatedPromptText: string) => {
    if (output && onUpdateOutput) {
      onUpdateOutput({ video_prompt: updatedPromptText });
    }
    onRun();
  };

  const getMotionTypeName = (type: string) => {
    const map: Record<string, string> = {
      zoom_in: '镜头推近 (Zoom In)',
      zoom_out: '镜头拉远 (Zoom Out)',
      pan_left: '左摇镜头 (Pan Left)',
      pan_right: '右摇镜头 (Pan Right)',
      tilt_up: '仰摇镜头 (Tilt Up)',
      tilt_down: '俯摇镜头 (Tilt Down)',
      rotate: '环绕镜头 (Rotate)',
      static_micro_motion: '微动沉浸 (Static Micro-Motion)',
    };
    return map[type] || type;
  };

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-white text-slate-900 overflow-y-auto p-6 md:p-8 flex flex-col transition-all'
          : 'bg-white text-slate-900 border border-slate-200/80 rounded-2xl shadow-2xs overflow-hidden transition-all'
      }
    >
      {/* Header */}
      <div className="px-6 py-4 bg-slate-50/80 border-b border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-2xs">
            2
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              第 2 步：静态图 → 视频生成提示词
            </h3>
            <p className="text-xs text-slate-500">
              运镜控制 + 动态强度与视频 Prompt 生成（兼容 Veo 3.1 / Seedance / Omni Flash 等模型）
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5"
            title={isFullscreen ? '退出全屏沉浸模式' : '进入全屏沉浸模式操作'}
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="w-3.5 h-3.5 text-slate-500" />
                <span>退出全屏</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5 text-slate-500" />
                <span>全屏沉浸</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onPrev}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-slate-500" />
            <span>上一步</span>
          </button>

          <button
            type="button"
            onClick={onReset}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
            <span>重置</span>
          </button>

          {isCompleted && (
            <button
              type="button"
              onClick={() => downloadJsonFile(output, 'step2_video_prompt.json')}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5 text-slate-500" />
              <span>下载 Prompt</span>
            </button>
          )}

          {isRunning ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600/80 text-white shadow-2xs flex items-center gap-1.5 cursor-wait"
              >
                <Sparkles className="w-3.5 h-3.5 animate-spin" />
                <span>AI 动态合成中...</span>
              </button>
              {onAbort && (
                <button
                  type="button"
                  onClick={onAbort}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-xs transition-all flex items-center gap-1 cursor-pointer"
                  title="中断并终止当前动态合成阶段"
                >
                  <span>终止阶段</span>
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={onRun}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>运行</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              if (!isCompleted) {
                notify('请先运行当前步骤生成视频 Prompt 再进入下一步', 'error');
                return;
              }
              onNext();
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold shadow-2xs transition-all flex items-center gap-1.5 ${
              isCompleted
                ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
            }`}
          >
            <span>下一步</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* S2 认知阶段切换：首帧创意 / 镜头生成 */}
      <div className="px-6 pt-4" role="tablist" aria-label="第 2 步认知阶段">
        <div className="inline-flex p-1 bg-slate-100 rounded-xl border border-slate-200/80 gap-1 text-xs font-bold">
          <button
            role="tab"
            aria-selected={phase === 'first_frame'}
            onClick={() => setPhase('first_frame')}
            className={`px-3.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
              phase === 'first_frame' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-500 hover:text-slate-700'
            }`}
            data-testid="step2-phase-first-frame"
          >
            ① 首帧创意
          </button>
          <button
            role="tab"
            aria-selected={phase === 'shots'}
            onClick={() => setPhase('shots')}
            className={`px-3.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
              phase === 'shots' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-500 hover:text-slate-700'
            }`}
            data-testid="step2-phase-shots"
          >
            ② 镜头生成{output?.multiShotResult ? ' · 进行中' : ''}
          </button>
        </div>
        <p className="text-[11px] text-slate-400 mt-1.5">
          首帧创意：确定产品首帧与候选图；镜头生成：逐镜提交、轮询与局部重试（JSON/prompt 默认折叠）
        </p>
      </div>

      <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Inputs Column（首帧创意阶段） */}
        <div className={`${phase === 'first_frame' ? 'lg:col-span-12' : 'hidden'} space-y-4 lg:pr-6`}>
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wider flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Video className="w-4 h-4 text-slate-500" />
              <span>1. 首帧素材模式与视频参数设定</span>
            </div>
          </div>

          {/* Context Inheritance Banner */}
          <div
            className={`p-3 rounded-xl shadow-2xs flex items-center justify-between text-xs ${
              upstreamStale
                ? 'bg-amber-50 border border-amber-300 text-amber-950'
                : 'bg-emerald-50 border border-emerald-200/80 text-emerald-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  upstreamStale ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 animate-pulse'
                }`}
              />
              <span className={`font-semibold ${upstreamStale ? 'text-amber-900' : 'text-emerald-800'}`}>
                {upstreamStale
                  ? '上游 Step 1 已更新，下游产物仍保留 — 请点击同步后再重跑'
                  : '已自动引用 Step 1 产物'}
              </span>
            </div>
            {onSyncFromStep1 && (
              <button
                onClick={onSyncFromStep1}
                className={`px-2.5 py-1 bg-white rounded-lg text-[11px] font-semibold transition-colors flex items-center gap-1 shadow-2xs cursor-pointer ${
                  upstreamStale
                    ? 'border border-amber-300 text-amber-800 hover:bg-amber-50'
                    : 'border border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                }`}
                title="一键拉取 Step 1 最新 static_image_prompt"
              >
                <RefreshCw className={`w-3 h-3 ${upstreamStale ? 'text-amber-600' : 'text-emerald-600'}`} />
              </button>
            )}
          </div>

          {/* Mode Selector Tabs (Tab 1: AI 生图多素材生成选优 | Tab 2: 已有首帧图/Step1素材) */}
          <div className="p-1.5 bg-slate-100/90 rounded-xl border border-slate-200/80 flex items-center gap-1.5 text-xs font-bold">
            <button
              type="button"
              onClick={() => onUpdateInputs({ tabMode: 'text2image' })}
              className={`flex-1 py-2 px-2.5 rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                inputs.tabMode !== 'direct_image'
                  ? 'bg-white text-blue-600 shadow-2xs border border-slate-200/80 font-bold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span>AI 生图选优</span>
            </button>

            <button
              type="button"
              onClick={() => onUpdateInputs({ tabMode: 'direct_image' })}
              className={`flex-1 py-2 px-2.5 rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                inputs.tabMode === 'direct_image'
                  ? 'bg-white text-blue-600 shadow-2xs border border-slate-200/80 font-bold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ImageIcon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span>已有首帧图</span>
            </button>
          </div>

          {/* Tab 1 Content: AI 生图大模型生成多个素材图 (候选选优) */}
          {inputs.tabMode !== 'direct_image' ? (
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-blue-600" />
                  <span className="text-xs font-bold text-slate-800">生图大模型素材生成器</span>
                </div>
                <span className="text-[10px] text-slate-500">点击生成 3 张素材选优</span>
              </div>

              {/* 生图模型选择 */}
              <div>
                <label className="text-[11px] font-semibold text-slate-600 block mb-1">
                  生图大模型 (Text-to-Image Engine)
                </label>
                <select
                  value={inputs.imageModel || DEFAULT_IMAGE_MODEL}
                  onChange={(e) => onUpdateInputs({ imageModel: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs cursor-pointer"
                >
                  <option value="GPT Image 2">GPT Image 2 ★ 推荐（云雾实测可用）</option>
                  <option value="GPT Image 1">GPT Image 1（画质高、光影细腻）</option>
                  <option value="云雾矢量模组">云雾 Vision 生图模组</option>
                  <option value="Midjourney V6 Bridge">Midjourney V6.1 旗舰画质</option>
                </select>
              </div>

              {/* 生图 Prompt */}
              <div>
                <label className="text-[11px] font-semibold text-slate-600 block mb-1">
                  生图 Prompt (可自主微调)
                </label>
                <textarea
                  value={inputs.static_image_prompt}
                  onChange={(e) => onUpdateInputs({ static_image_prompt: e.target.value })}
                  placeholder="请输入用于 AI 生图的详细视觉描写 Prompt..."
                  className="w-full h-20 bg-white border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none shadow-2xs"
                />
              </div>

              {/* 生成 3 张素材图按钮 */}
              <button
                type="button"
                onClick={handleGenerateCandidates}
                disabled={isGeneratingCandidates}
                className="w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-2xs transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                {isGeneratingCandidates ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>大模型并发生成 3 张素材图中...</span>
                  </>
                ) : (
                  <>
                    <Grid className="w-4 h-4" />
                    <span>批量生成 3 张素材图选优 ▶</span>
                  </>
                )}
              </button>

              {/* Candidate Images Grid */}
              {inputs.candidateImages && inputs.candidateImages.length > 0 ? (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-600 font-semibold">
                    <span>素材候选池 ({inputs.candidateImages.length} 张)</span>
                    <span className="text-[10px] text-blue-600">点击选中作为视频首帧</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {inputs.candidateImages.map((cand, idx) => {
                      const isSelected =
                        inputs.selectedImageId === cand.id || inputs.imageUrl === cand.url;
                      return (
                        <div
                          key={cand.id || idx}
                          onClick={() => handleSelectCandidate(cand)}
                          className={`relative aspect-square rounded-lg overflow-hidden border-2 cursor-pointer transition-all group ${
                            isSelected
                              ? 'border-blue-600 ring-2 ring-blue-400/40 shadow-xs'
                              : 'border-slate-200 hover:border-blue-300'
                          }`}
                        >
                          <img
                            src={cand.url}
                            alt={`素材 ${idx + 1}`}
                            className="w-full h-full object-cover"
                          />
                          {isSelected && (
                            <div className="absolute top-1 left-1 bg-blue-600 text-white p-0.5 rounded-full shadow-2xs">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setZoomImageUrl(cand.url);
                            }}
                            className="absolute bottom-1 right-1 p-1 bg-slate-900/80 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                            title="放大预览图片"
                          >
                            <Maximize2 className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-white/80 border border-dashed border-slate-200 rounded-lg text-center text-[11px] text-slate-500">
                  尚无素材图，点击上按钮即可由大模型并发生成 3 张爆款素材图选优
                </div>
              )}
            </div>
          ) : (
            /* Tab 2 Content: 已有首帧图 / 继承 Step 1 素材 */
            <div className="space-y-3">
              {inputs.imageUrl ? (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-slate-600 font-semibold">
                    <span>🖼 当前首帧素材图片</span>
                    <span className="text-[10px] text-emerald-600 font-mono">已就绪</span>
                  </div>
                  <div className="relative aspect-video rounded-lg overflow-hidden border border-slate-200 bg-slate-900 group">
                    <img src={inputs.imageUrl} alt="首帧图片" className="w-full h-full object-contain" />
                    <button
                      type="button"
                      onClick={() => setZoomImageUrl(inputs.imageUrl)}
                      className="absolute top-2 right-2 p-1.5 bg-slate-900/80 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                      title="放大预览"
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                  </div>
                  <label className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-semibold text-blue-700 cursor-pointer transition-colors">
                    <Upload className="w-3.5 h-3.5" />
                    <span>更换首帧图片</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const fd = new FormData();
                        fd.append('file', file);
                        try {
                          const res = await fetch('/api/v1/materials/upload-file', { method: 'POST', body: fd });
                          const json = await res.json();
                          if (json.success && json.data?.url) {
                            onUpdateInputs({ imageUrl: json.data.url });
                          }
                        } catch {}
                      }}
                    />
                  </label>
                </div>
              ) : (
                <div className="p-3 bg-amber-50 border border-amber-200/80 rounded-xl space-y-2">
                  <p className="text-xs text-amber-800">
                    ⚠️ 尚未检测到首帧图片（请切换到【AI 生图选优】Tab 生成素材或在 Step 1 上传图片）
                  </p>
                  <label className="flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-bold text-white cursor-pointer transition-colors shadow-sm">
                    <Upload className="w-3.5 h-3.5" />
                    <span>从本地选择首帧图片</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const fd = new FormData();
                        fd.append('file', file);
                        try {
                          const res = await fetch('/api/v1/materials/upload-file', { method: 'POST', body: fd });
                          const json = await res.json();
                          if (json.success && json.data?.url) {
                            onUpdateInputs({ imageUrl: json.data.url });
                          }
                        } catch {}
                      }}
                    />
                  </label>
                </div>
              )}

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">
                  第 1 步生成的 static_image_prompt (自动接入)
                </label>
                <textarea
                  value={inputs.static_image_prompt}
                  onChange={(e) => onUpdateInputs({ static_image_prompt: e.target.value })}
                  placeholder="来自于第 1 步的静态图提示词..."
                  className="w-full h-24 bg-white border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none shadow-2xs"
                />
              </div>
            </div>
          )}
          <div>
            <label className="text-xs font-semibold text-slate-700 block mb-1">
              第 1 步生成的 static_image_prompt (自动接入)
            </label>
            <textarea
              value={inputs.static_image_prompt}
              onChange={(e) => onUpdateInputs({ static_image_prompt: e.target.value })}
              placeholder="来自于第 1 步的静态图提示词..."
              className="w-full h-24 bg-white border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none shadow-2xs"
            />
          </div>

          {/* Controls: Video Tone & Duration */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-700 block mb-1">
                视频调性
              </label>
              <select
                value={inputs.videoTone}
                onChange={(e) => onUpdateInputs({ videoTone: e.target.value as any })}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs cursor-pointer"
              >
                <option value="xiaohongshu_healing">小红书治愈（缓慢沉浸推镜）</option>
                <option value="douyin_beat">抖音卡点（强冲击横移）</option>
                <option value="brand_tvc">品牌 TVC（大牌柔影）</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-700 block mb-1">
                目标时长 (秒)
              </label>
              <select
                value={inputs.durationSec}
                onChange={(e) => onUpdateInputs({ durationSec: Number(e.target.value) })}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs cursor-pointer"
              >
                <option value={3}>3 秒（快节奏卡点）</option>
                <option value={4}>4 秒（标准种草）</option>
                <option value={5}>5 秒（硬核测评）</option>
                <option value={6}>6 秒（深度长质感）</option>
              </select>
            </div>
          </div>

          {/* 模型选择：运镜 LLM + 图生视频 */}
          <div className="space-y-2">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">模型选择</p>
            <StepModelPicker
              category="text"
              title="运镜 Prompt 文本模型"
              models={modelConfig.textModels}
              value={inputs.textModel}
              defaultId={modelConfig.defaultTextModel}
              onChange={(id) => onUpdateInputs({ textModel: id })}
            />
            <StepModelPicker
              category="video"
              title="图生视频 / Seedance 模型"
              models={modelConfig.videoModels}
              value={inputs.videoModel}
              defaultId={modelConfig.defaultVideoModel}
              onChange={(id) => onUpdateInputs({ videoModel: id })}
            />
          </div>
        </div>

        {/* Right Output Column（镜头生成阶段） */}
        <div className={`${phase === 'shots' ? 'lg:col-span-12' : 'hidden'} flex flex-col justify-between bg-slate-900 text-slate-100 p-5 rounded-xl border border-slate-800 shadow-2xs`}>
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-blue-400" />
                <span>2. 视频运动 PROMPT 结构化产物</span>
              </div>

              {isCompleted && (
                <div className="flex items-center gap-1 p-1 bg-slate-800/80 border border-slate-700/80 rounded-lg">
                  <button
                    onClick={() => setActiveTab('visual')}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      activeTab === 'visual'
                        ? 'bg-blue-600 text-white shadow-2xs'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Eye className="w-3 h-3 inline mr-1" />
                    可视化卡片
                  </button>
                  <button
                    onClick={() => setActiveTab('json')}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      activeTab === 'json'
                        ? 'bg-blue-600 text-white shadow-2xs'
                        : 'text-slate-400 hover:text-white'
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
              <div className="h-64 rounded-xl border border-dashed border-slate-800 bg-slate-950/50 flex flex-col items-center justify-center p-6 text-center">
                <div className="w-10 h-10 rounded-xl bg-blue-900/30 text-blue-400 flex items-center justify-center mb-3 border border-blue-500/20">
                  <Film className="w-5 h-5" />
                </div>
                <p className="text-xs font-medium text-slate-300">
                  点击【运行 ▶】启动第 2 步视频 Prompt 生成引擎
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  （系统将计算运镜轨迹、运动强度、音轨建议与 Veo 3.1 / Seedance 提示词）
                </p>
              </div>
            ) : activeTab === 'visual' ? (
              <div className="space-y-4">
                {/* Multi-Shot Generation Tracker Component */}
                {output.isMultiShot && output.multiShotResult && (
                  <ShotGenerationTracker
                    multiShotResult={output.multiShotResult}
                    onUpdateMultiShotResult={(updated) => {
                      if (onUpdateOutput) {
                        onUpdateOutput({ multiShotResult: updated });
                      }
                    }}
                    onConcatComplete={(concatVideoUrl) => {
                      if (onUpdateOutput) {
                        onUpdateOutput({ previewVideoUrl: concatVideoUrl });
                      }
                    }}
                  />
                )}

                {/* Motion Type & Intensity Row */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-slate-400 block font-mono uppercase">运镜类型 (motion_type)</span>
                      <span className="text-xs font-bold text-blue-400">
                        {getMotionTypeName(output.motion_type)}
                      </span>
                    </div>
                    <MoveUpRight className="w-5 h-5 text-blue-400" />
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-slate-400 block font-mono uppercase">运动幅度 (motion_intensity)</span>
                      <span className="text-xs font-bold text-emerald-400 uppercase font-mono">
                        {output.motion_intensity}
                      </span>
                    </div>
                    <Gauge className="w-5 h-5 text-emerald-400" />
                  </div>
                </div>

                {/* Motion Description */}
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <span className="text-[10px] text-slate-400 block font-mono uppercase">运镜轨迹描述</span>
                  <span className="text-xs text-slate-200">{output.motion_description}</span>
                </div>

                {/* Video Prompt Block with View, Edit, Copy & Regenerate Actions */}
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-blue-400 font-mono flex items-center gap-2">
                      <span>video_prompt</span>
                      <span className="px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300 font-medium text-[10px] border border-blue-700/50">
                        {inputs.videoModel || DEFAULT_VIDEO_MODEL} 适配
                      </span>
                    </span>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setIsPromptEditorOpen(true)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs border border-slate-700 transition-colors cursor-pointer"
                        title="查看与完整编辑 Video Prompt"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>查看 / 编辑</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleCopyPrompt}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs shadow-2xs transition-colors cursor-pointer"
                      >
                        {copiedPrompt ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedPrompt ? '已复制' : '复制 Video Prompt'}</span>
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-slate-200 font-mono leading-relaxed bg-slate-900 p-3 rounded-lg border border-slate-800/80 select-all">
                    {output.video_prompt}
                  </p>

                  <div className="pt-1 flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">
                      💡 核心资产：可编辑运镜逻辑并直接重新生成视频动画
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsPromptEditorOpen(true)}
                      className="text-xs font-semibold text-blue-400 hover:underline flex items-center gap-1 cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>重新生成视频</span>
                    </button>
                  </div>
                </div>

                {/* Audio & Negative Prompt info */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <span className="text-[10px] text-slate-400 block font-mono">环境音轨 suggested_audio</span>
                    <span className="text-xs text-slate-200">{output.audio_layer}</span>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-950 border border-rose-900/40">
                    <span className="text-[10px] text-rose-400 block font-mono">负面规避 negative_prompt</span>
                    <span className="text-xs text-rose-300">{output.negative_prompt}</span>
                  </div>
                </div>

                {/* 星河 Seedance 中转状态与 4 阶段进度条 */}
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-300 font-mono">星河 Seedance 视频生成引擎</span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        ({output.seedanceModel || inputs.videoModel || DEFAULT_VIDEO_MODEL})
                      </span>
                    </div>

                    <span
                      className={`text-[10px] px-2.5 py-0.5 rounded-full border font-bold flex items-center gap-1 ${
                        output.seedanceStatus === 'success' || output.seedanceStatus === 'completed' || output.previewVideoUrl
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-700/60'
                          : output.seedanceStatus === 'processing' || (output.seedanceTaskId && !output.previewVideoUrl)
                          ? 'bg-amber-950 text-amber-300 border-amber-700/60 animate-pulse'
                          : output.seedanceStatus === 'submit_failed' || output.seedanceStatus === 'error' || output.seedanceStatus === 'timeout'
                          ? 'bg-rose-950 text-rose-300 border-rose-700/60'
                          : 'bg-slate-800 text-slate-300 border-slate-700'
                      }`}
                    >
                      {output.seedanceStatus === 'success' || output.seedanceStatus === 'completed' || output.previewVideoUrl
                        ? '✅ 视频生成成功'
                        : output.seedanceTaskId && !output.previewVideoUrl
                        ? `⚡ 渲染中 · 已等待 ${seedanceWaitSec}s`
                        : output.seedanceStatus || 'prompt_only'}
                    </span>
                  </div>

                  {/* 4-Stage Progress Stepper when Task in Progress */}
                  {output.seedanceTaskId && !output.previewVideoUrl && (
                    <div className="space-y-2.5 pt-1 bg-slate-900/90 p-3 rounded-xl border border-slate-800">
                      {/* Step Indicator Badges */}
                      <div className="grid grid-cols-4 gap-1 text-center text-[10px] font-semibold">
                        <div
                          className={`p-1.5 rounded-lg border transition-all ${
                            seedanceWaitSec >= 0 && seedanceWaitSec < 12
                              ? 'bg-blue-950 text-blue-300 border-blue-600/80 shadow-xs'
                              : 'bg-slate-900 text-slate-500 border-slate-800'
                          }`}
                        >
                          🚀 1. 服务器接收
                        </div>
                        <div
                          className={`p-1.5 rounded-lg border transition-all ${
                            seedanceWaitSec >= 12 && seedanceWaitSec < 120
                              ? 'bg-amber-950 text-amber-300 border-amber-600/80 shadow-xs animate-pulse'
                              : seedanceWaitSec >= 120
                              ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800'
                              : 'bg-slate-900 text-slate-500 border-slate-800'
                          }`}
                        >
                          ⚡ 2. AI扩散渲染
                        </div>
                        <div
                          className={`p-1.5 rounded-lg border transition-all ${
                            seedanceWaitSec >= 120 && seedanceWaitSec < 150
                              ? 'bg-violet-950 text-violet-300 border-violet-600/80 shadow-xs animate-pulse'
                              : seedanceWaitSec >= 150
                              ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800'
                              : 'bg-slate-900 text-slate-500 border-slate-800'
                          }`}
                        >
                          📦 3. 同步落盘
                        </div>
                        <div
                          className={`p-1.5 rounded-lg border transition-all ${
                            output.previewVideoUrl
                              ? 'bg-emerald-950 text-emerald-300 border-emerald-600/80 shadow-xs'
                              : 'bg-slate-900 text-slate-500 border-slate-800'
                          }`}
                        >
                          ✅ 4. 生成完成
                        </div>
                      </div>

                      {/* Animated Progress Bar */}
                      <div className="space-y-1">
                        <div className="h-2 rounded-full bg-slate-800 overflow-hidden relative">
                          <div
                            className="h-full bg-gradient-to-r from-blue-500 via-amber-500 to-emerald-500 transition-all duration-500 rounded-full"
                            style={{
                              width: `${Math.min(96, Math.max(8, (seedanceWaitSec / 180) * 100))}%`,
                            }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-slate-400">
                          <span>
                            {seedanceWaitSec < 12
                              ? '正在分配星河 GPU 算力并入队...'
                              : seedanceWaitSec < 120
                              ? 'AI 正在推演物理运动与光影质感...'
                              : '视频已生成完毕，正同步转存至本地渲染库...'}
                          </span>
                          <span className="font-mono text-amber-300">
                            已耗时 {seedanceWaitSec}s / 预估 180s
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-300 pt-1">
                    <div>
                      <span className="text-slate-500">模型代码：</span>
                      <span className="font-mono text-slate-200">
                        {output.seedanceModel || inputs.videoModel || DEFAULT_VIDEO_MODEL}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">任务 ID：</span>
                      <span className="font-mono text-slate-200">
                        {output.seedanceTaskId || '—'}
                      </span>
                    </div>
                  </div>

                  {output.seedanceHint && (
                    <p className="text-[11px] text-slate-400">{output.seedanceHint}</p>
                  )}
                  {output.seedanceMaterialWarning && (
                    <p className="text-[11px] text-amber-300">{output.seedanceMaterialWarning}</p>
                  )}
                  {output.seedanceError && (
                    <p className="text-[11px] text-rose-300 bg-rose-950/60 p-2 rounded-lg border border-rose-900">
                      ❌ {output.seedanceError}
                    </p>
                  )}

                  {/* Enhanced Interactive Video Preview Player */}
                  {output.previewVideoUrl && (
                    <div className="space-y-3 pt-2 border-t border-slate-800">
                      <div className="flex items-center justify-between text-xs font-bold text-slate-200">
                        <div className="flex items-center gap-1.5">
                          <Film className="w-4 h-4 text-emerald-400" />
                          <span>AI 生成视频效果预览 (Video Preview)</span>
                        </div>
                        <span className="text-[10px] text-emerald-400 font-mono">1080P HD · 60fps</span>
                      </div>

                      <div className="relative rounded-xl overflow-hidden bg-black border border-slate-800 shadow-md group">
                        <video
                          src={output.previewVideoUrl}
                          className="w-full aspect-video object-contain max-h-64"
                          controls
                          autoPlay
                          loop
                          muted
                          playsInline
                        />
                      </div>

                      {/* Video Player Action Toolbar */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <a
                          href={output.previewVideoUrl}
                          download="seedance_generated_video.mp4"
                          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 transition-colors flex items-center gap-1.5"
                          title="下载原始高清 MP4 视频文件"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>下载高清 MP4</span>
                        </a>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={onNext}
                            className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
                          >
                            <span>传送至 Step 3 生成文案</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* JSON Code View */
              <div className="relative group">
                <button
                  onClick={handleCopyJson}
                  className="absolute top-3 right-3 z-10 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 text-white font-medium text-xs shadow-2xs cursor-pointer"
                >
                  {copiedJson ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedJson ? '已复制 JSON' : '复制 JSON'}</span>
                </button>

                <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs text-blue-300 font-mono overflow-x-auto max-h-96 leading-relaxed">
                  {JSON.stringify(output, null, 2)}
                </pre>
              </div>
            )}
          </div>

          {/* Bottom Step Transfer Notice */}
          {isCompleted && (
            <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
              <span className="text-blue-400 font-mono">
                ✓ 视频运镜 Prompt 已就绪，将自动传输至第 3 步爆款文案撰写引擎
              </span>
              <button
                onClick={onNext}
                className="flex items-center gap-1 font-semibold text-blue-400 hover:underline cursor-pointer"
              >
                <span>下一步：撰写爆款文案</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Prompt Editor Modal */}
      {output && (
        <PromptEditorModal
          isOpen={isPromptEditorOpen}
          onClose={() => setIsPromptEditorOpen(false)}
          title="第 2 步：图生视频 Video Prompt 精细化编辑器"
          promptType="video_prompt"
          modelName={inputs.videoModel || DEFAULT_VIDEO_MODEL}
          initialPrompt={output.video_prompt}
          onSavePrompt={handleSavePromptFromEditor}
          onRegenerate={handleRegenerateFromEditor}
          isRegenerating={isRunning}
        />
      )}
      {/* Zoom Image Preview Modal */}
      {zoomImageUrl && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setZoomImageUrl(null)}
        >
          <div
            className="relative max-w-4xl w-full bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden p-2 shadow-2xl flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full flex items-center justify-between p-3 border-b border-slate-800 text-slate-200">
              <span className="text-xs font-bold font-mono">高清首帧素材图全屏预览</span>
              <button
                onClick={() => setZoomImageUrl(null)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 w-full flex items-center justify-center">
              <img
                src={zoomImageUrl}
                alt="Zoomed"
                className="max-h-[75vh] w-auto object-contain rounded-lg border border-slate-800"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

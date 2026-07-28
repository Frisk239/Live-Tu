import React, { useState, useEffect } from 'react';
import { Step2Inputs, Step2Output, Step1Output, StepStatus } from '../types';
import { copyToClipboard, downloadJsonFile } from '../utils/format';
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
} from 'lucide-react';
import { VideoModelName, ModelConfigState } from '../data/models';
import { PromptEditorModal } from './PromptEditorModal';

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
  onReset: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Upstream Step1 re-ran; current step artifacts may be outdated */
  upstreamStale?: boolean;
}

export const Step2Card: React.FC<Step2CardProps> = ({
  inputs,
  output,
  step1Output,
  status,
  modelConfig,
  onUpdateInputs,
  onUpdateOutput,
  onSyncFromStep1,
  onRun,
  onReset,
  onPrev,
  onNext,
  upstreamStale = false,
}) => {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [activeTab, setActiveTab] = useState<'visual' | 'json'>('visual');
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isRunning = status === 'running';
  const isCompleted = status === 'completed' && Boolean(output);

  // Enabled Video Models
  const enabledVideoModels = modelConfig.videoModels.filter((m) => m.enabled);

  // Auto-recommendation：优先星河 Seedance 中转
  useEffect(() => {
    if (modelConfig.autoRecommendationEnabled && !inputs.videoModel) {
      if (inputs.videoTone === 'xiaohongshu_healing') {
        onUpdateInputs({ videoModel: 'Seedance 2.0' });
      } else if (inputs.videoTone === 'douyin_beat') {
        onUpdateInputs({ videoModel: 'Seedance 2.0 Fast' });
      } else {
        onUpdateInputs({ videoModel: 'Seedance 2.0 Fast' });
      }
    }
  }, [inputs.videoTone, modelConfig.autoRecommendationEnabled]);

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

  const currentSelectedModelMeta = enabledVideoModels.find(
    (m) => m.id === (inputs.videoModel || 'Seedance 2.0 Fast')
  );

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
            onClick={onPrev}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-slate-500" />
            <span>上一步</span>
          </button>

          <button
            onClick={onReset}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
            <span>重置</span>
          </button>

          {isCompleted && (
            <button
              onClick={() => downloadJsonFile(output, 'step2_video_prompt.json')}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5 text-slate-500" />
              <span>下载 Prompt</span>
            </button>
          )}

          <button
            onClick={onRun}
            disabled={isRunning}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {isRunning ? (
              <>
                <Sparkles className="w-3.5 h-3.5 animate-spin" />
                <span>AI 动态合成中...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>运行</span>
              </>
            )}
          </button>

          <button
            onClick={onNext}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-50 transition-all cursor-pointer flex items-center gap-1.5"
          >
            <span>下一步</span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
          </button>
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Inputs Column */}
        <div className="lg:col-span-5 space-y-4 border-r border-slate-100 pr-0 lg:pr-6">
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wider flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Video className="w-4 h-4 text-slate-500" />
              <span>1. 继承第 1 步 Prompt & 视频控制参数</span>
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
                <span>{upstreamStale ? '同步上游产物' : '同步 Step 1 结果'}</span>
              </button>
            )}
          </div>

          {/* Inherited Static Image Prompt */}
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

          {/* Video Model Selector with Non-technical Metadata */}
          <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl shadow-2xs space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-800">
              <span className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-blue-600" />
                目标视频生成 AI 模型 (Video Model)
              </span>
              <span className="text-[10px] text-blue-700 bg-blue-50 border border-blue-200/60 px-2 py-0.5 rounded-full font-semibold">
                SOTA 运镜引擎
              </span>
            </div>

            <select
              value={inputs.videoModel || 'Seedance 2.0 Fast'}
              onChange={(e) => onUpdateInputs({ videoModel: e.target.value as any })}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-500 shadow-2xs cursor-pointer"
            >
              {enabledVideoModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.recommendedScenario} ({m.speedRating})
                </option>
              ))}
            </select>

            {currentSelectedModelMeta && (
              <div className="text-[11px] bg-white p-2.5 rounded-lg border border-slate-200/80 text-slate-700 space-y-1 shadow-2xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">推荐场景:</span>
                  <span className="font-semibold text-slate-800">{currentSelectedModelMeta.recommendedScenario}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">预估速度:</span>
                  <span className="font-semibold text-slate-800">
                    {currentSelectedModelMeta.speedRating} ({currentSelectedModelMeta.speedMs})
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">动态质量:</span>
                  <span className="font-semibold text-slate-800">{currentSelectedModelMeta.qualityRating}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Output Column (Immersive Dark Focus Canvas) */}
        <div className="lg:col-span-7 flex flex-col justify-between bg-slate-900 text-slate-100 p-5 rounded-xl border border-slate-800 shadow-2xs">
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
                        {inputs.videoModel || 'Seedance 2.0 Fast'} 适配
                      </span>
                    </span>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setIsPromptEditorOpen(true)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs border border-slate-700 transition-colors cursor-pointer"
                        title="查看与完整编辑 Video Prompt"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>查看 / 编辑</span>
                      </button>

                      <button
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

                {/* 星河 Seedance 中转状态 */}
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-400 font-mono uppercase">星河 Seedance 中转</span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${
                        output.seedanceStatus === 'success' || output.seedanceStatus === 'completed'
                          ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
                          : output.seedanceStatus === 'processing' ||
                              (output.seedanceTaskId && !output.previewVideoUrl)
                          ? 'bg-amber-900/40 text-amber-300 border-amber-700/50'
                          : output.seedanceStatus === 'not_configured' ||
                              output.seedanceStatus === 'unconfigured'
                          ? 'bg-slate-800 text-slate-300 border-slate-700'
                          : output.seedanceStatus === 'submit_failed' ||
                              output.seedanceStatus === 'error' ||
                              output.seedanceStatus === 'timeout'
                          ? 'bg-rose-900/40 text-rose-300 border-rose-700/50'
                          : 'bg-blue-900/40 text-blue-300 border-blue-700/50'
                      }`}
                    >
                      {output.seedanceStatus || 'prompt_only'}
                      {output.seedanceTaskId && !output.previewVideoUrl && seedanceWaitSec > 0
                        ? ` · ${seedanceWaitSec}s`
                        : ''}
                    </span>
                  </div>
                  {output.seedanceTaskId && !output.previewVideoUrl && (
                    <div className="space-y-1">
                      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-amber-500/80 transition-all duration-500"
                          style={{ width: `${Math.min(95, (seedanceWaitSec / 180) * 100)}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-amber-200/80">
                        正在轮询 Seedance 任务（约每 3s），已等待 {seedanceWaitSec}s / 180s
                      </p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-300">
                    <div>
                      <span className="text-slate-500">模型：</span>
                      {output.seedanceModel || inputs.videoModel || 'Seedance 2.0 Fast'}
                    </div>
                    <div>
                      <span className="text-slate-500">任务ID：</span>
                      {output.seedanceTaskId || '—'}
                    </div>
                  </div>
                  {output.seedanceHint && (
                    <p className="text-[11px] text-slate-400">{output.seedanceHint}</p>
                  )}
                  {output.seedanceMaterialWarning && (
                    <p className="text-[11px] text-amber-300">{output.seedanceMaterialWarning}</p>
                  )}
                  {output.seedanceError && (
                    <p className="text-[11px] text-rose-300">{output.seedanceError}</p>
                  )}
                  {output.previewVideoUrl && (
                    <div className="space-y-2">
                      <video
                        src={output.previewVideoUrl}
                        className="w-full max-h-48 rounded-lg bg-black object-contain border border-slate-800"
                        controls
                        playsInline
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={output.previewVideoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex text-[11px] text-blue-400 hover:underline"
                        >
                          打开生成视频
                        </a>
                        {(output.seedanceStatus === 'success' ||
                          output.seedanceStatus === 'completed' ||
                          output.previewVideoUrl) && (
                          <button
                            type="button"
                            onClick={onNext}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold"
                          >
                            视频已就绪 · 继续文案/合成
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      {String(output.previewVideoUrl).includes('/uploads/renders/') && (
                        <p className="text-[10px] text-emerald-400/90">
                          已缓存到本地 renders，可供 Step5 FFmpeg 直接合成
                        </p>
                      )}
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
          modelName={inputs.videoModel || 'Seedance 2.0 Fast'}
          initialPrompt={output.video_prompt}
          onSavePrompt={handleSavePromptFromEditor}
          onRegenerate={handleRegenerateFromEditor}
          isRegenerating={isRunning}
        />
      )}
    </div>
  );
};

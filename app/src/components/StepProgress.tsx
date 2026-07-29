import React from 'react';
import { StepId, PipelineData } from '../types';
import {
  Check,
  Image,
  Video,
  FileText,
  Music,
  Film,
  ArrowRight,
  Zap,
  Sparkles,
  Layers,
  AlertCircle,
  CloudUpload,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';

export interface AutoPipelineProgress {
  step: StepId;
  /** e.g. llm | seedance_wait | render | done | error */
  phase: string;
  message: string;
  /** Seconds waited on Seedance (if phase is seedance_wait) */
  seedanceWaitSec?: number;
  seedanceMaxSec?: number;
}

interface StepProgressProps {
  currentStep: StepId;
  pipelineData: PipelineData;
  onSelectStep: (stepId: StepId) => void;
  onRunFullPipelineAuto?: () => void;
  onAbortFullPipeline?: () => void;
  onClearWorkbench?: () => void;
  isAutoPipelineRunning?: boolean;
  autoProgress?: AutoPipelineProgress | null;
  /** Last auto-draft save time label, e.g. 14:32:01 */
  draftSavedLabel?: string | null;
  /** Optional per-step API source (yunwu / seedance / library / ffmpeg / mock) */
  stepSources?: Partial<Record<StepId, string>>;
  /** Open task center (draft list) */
  onOpenTasks?: () => void;
}

export const STEP_CONFIG: Array<{
  id: StepId;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 1, title: '第 1 步', subtitle: '视频/Live图 → 静态图Prompt', icon: Image },
  { id: 2, title: '第 2 步', subtitle: '静态图 → 视频生成Prompt', icon: Video },
  { id: 3, title: '第 3 步', subtitle: '视频 → 爆款文案', icon: FileText },
  { id: 4, title: '第 4 步', subtitle: '文案+视频 → 匹配 BGM', icon: Music },
  { id: 5, title: '第 5 步', subtitle: '合成输出成品', icon: Film },
];

export const StepProgress: React.FC<StepProgressProps> = React.memo(({
  currentStep,
  pipelineData,
  onSelectStep,
  onRunFullPipelineAuto,
  onAbortFullPipeline,
  onClearWorkbench,
  isAutoPipelineRunning = false,
  autoProgress = null,
  draftSavedLabel = null,
  stepSources = {},
  onOpenTasks,
}) => {
  const getStepStatus = (id: StepId) => {
    const key = `step${id}` as keyof PipelineData;
    return pipelineData[key].status;
  };

  const completedCount = STEP_CONFIG.filter((s) => getStepStatus(s.id) === 'completed').length;
  const failedCount = STEP_CONFIG.filter((s) => getStepStatus(s.id) === 'failed').length;

  const autoPct = isAutoPipelineRunning
    ? Math.min(
        98,
        ((autoProgress?.step || currentStep) - 1) * 18 +
          (autoProgress?.phase === 'seedance_wait'
            ? 8 +
              Math.min(
                10,
                ((autoProgress.seedanceWaitSec || 0) / (autoProgress.seedanceMaxSec || 180)) * 10
              )
            : autoProgress?.phase === 'render'
              ? 14
              : autoProgress?.phase === 'llm'
                ? 6
                : 4)
      )
    : completedCount * 20;

  return (
    <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-2xs mb-8 transition-all text-slate-900">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3.5 border-b border-slate-100">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-600 animate-pulse" />
          <h2 className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-2">
            <span>BUV 5步内容反推工作台</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-50 text-blue-700 border border-blue-200/60 font-medium flex items-center gap-1">
              <Layers className="w-3 h-3" />
              全自动上下文继承
            </span>
          </h2>
          <button
            type="button"
            onClick={onOpenTasks}
            className={`px-2 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-800 border border-amber-200 font-medium flex items-center gap-1 hover:bg-amber-100 cursor-pointer transition-opacity duration-300 ${
              draftSavedLabel ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            title="工作台状态已自动保存；点击打开任务中心"
          >
            <CloudUpload className="w-3 h-3 text-amber-600" />
            草稿已保存 {draftSavedLabel || ''}
            {onOpenTasks && <span className="opacity-70">· 查看</span>}
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-xs text-slate-500 font-medium flex items-center gap-1.5 mr-1">
            <span>完成度</span>
            <span className="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-200/80">
              {completedCount} / 5
            </span>
            {failedCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-bold">
                {failedCount} 失败
              </span>
            )}
          </div>

          {onClearWorkbench && (
            <button
              onClick={onClearWorkbench}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-700 hover:text-rose-700 bg-slate-100 hover:bg-rose-50 border border-slate-200 hover:border-rose-200 transition-all cursor-pointer shadow-xs"
              title="一键清空工作台所有输入、产物与缓存"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>一键清空</span>
            </button>
          )}

          {isAutoPipelineRunning ? (
            <button
              onClick={onAbortFullPipeline}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 shadow-md transition-all cursor-pointer animate-pulse"
              title="一键终止全自动贯通任务"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>一键终止贯通</span>
            </button>
          ) : (
            onRunFullPipelineAuto && (
              <button
                onClick={onRunFullPipelineAuto}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-2xs transition-all cursor-pointer"
              >
                <Zap className="w-4 h-4 fill-white text-white" />
                <span>一键全自动贯通反推 (Step 1→5)</span>
              </button>
            )
          )}
        </div>
      </div>

      {/* Auto pipeline progress strip */}
      {isAutoPipelineRunning && (
        <div className="mb-4 p-3 rounded-xl bg-blue-50/80 border border-blue-200/70 space-y-2">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="font-bold text-blue-900">
              {autoProgress?.message || `正在执行 Step ${currentStep}...`}
            </span>
            <span className="font-mono text-blue-700">{Math.round(autoPct)}%</span>
          </div>
          <div className="h-2 rounded-full bg-blue-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-500 ease-out"
              style={{ width: `${autoPct}%` }}
            />
          </div>
          {autoProgress?.phase === 'seedance_wait' && (
            <p className="text-[10px] text-blue-800/80">
              星河 Seedance 异步出片中（最长约 {autoProgress.seedanceMaxSec || 180}s），请勿关闭页面…
            </p>
          )}
        </div>
      )}

      {/* Progress Step Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {STEP_CONFIG.map((step, idx) => {
          const status = getStepStatus(step.id);
          const isCurrent = currentStep === step.id;
          const isCompleted = status === 'completed';
          const isRunning = status === 'running';
          const isFailed = status === 'failed';
          const Icon = step.icon;
          const source = stepSources[step.id];

          return (
            <button
              key={step.id}
              onClick={() => onSelectStep(step.id)}
              className={`group text-left p-3.5 rounded-xl border transition-all duration-200 cursor-pointer ${
                isCurrent
                  ? isFailed
                    ? 'bg-rose-50/90 border-rose-300 text-rose-900 shadow-2xs'
                    : 'bg-blue-50/90 border-blue-300 text-blue-900 shadow-2xs'
                  : isFailed
                  ? 'bg-rose-50/50 border-rose-200 text-rose-800 hover:border-rose-300'
                  : isCompleted
                  ? 'bg-slate-50 border-slate-200/90 text-slate-800 hover:border-slate-300'
                  : 'bg-white border-slate-200/80 text-slate-600 hover:border-slate-300 hover:bg-slate-50/50'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-6 h-6 rounded-md border flex items-center justify-center font-bold text-xs ${
                      isCompleted
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : isFailed
                        ? 'bg-rose-600 border-rose-600 text-white'
                        : isCurrent
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-slate-100 border-slate-200 text-slate-600'
                    }`}
                  >
                    {isCompleted ? (
                      <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                    ) : isFailed ? (
                      <AlertCircle className="w-3.5 h-3.5" />
                    ) : (
                      step.id
                    )}
                  </div>
                  <span className={`text-xs font-semibold ${isCurrent ? 'text-blue-900' : 'text-slate-900'}`}>
                    {step.title}
                  </span>
                </div>

                <Icon className={`w-4 h-4 ${isCurrent ? 'text-blue-600' : 'text-slate-400'}`} />
              </div>

              <p className="text-xs text-slate-500 line-clamp-1 truncate">
                {step.subtitle}
              </p>

              {/* Status Badge & Arrow */}
              <div className="mt-2.5 flex items-center justify-between gap-1">
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border font-medium truncate ${
                    isRunning
                      ? 'bg-amber-50 border-amber-200 text-amber-700 animate-pulse'
                      : isFailed
                      ? 'bg-rose-50 border-rose-200 text-rose-700'
                      : isCompleted
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      : 'bg-slate-100 border-slate-200/60 text-slate-500'
                  }`}
                >
                  {isRunning
                    ? '生成中...'
                    : isFailed
                    ? '失败'
                    : isCompleted
                    ? source === 'mock'
                      ? '演示数据'
                      : source
                        ? `就绪 · ${source}`
                        : '已就绪'
                    : '待运行'}
                </span>

                {idx < 4 && (
                  <ArrowRight className="w-3.5 h-3.5 text-slate-300 hidden lg:block group-hover:translate-x-0.5 transition-transform" />
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});

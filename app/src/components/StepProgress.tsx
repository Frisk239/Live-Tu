import React from 'react';
import { StepId, PipelineData } from '../types';
import { Check, Image, Video, FileText, Music, Film, ArrowRight, Zap, Sparkles, Layers } from 'lucide-react';

interface StepProgressProps {
  currentStep: StepId;
  pipelineData: PipelineData;
  onSelectStep: (stepId: StepId) => void;
  onRunFullPipelineAuto?: () => void;
  isAutoPipelineRunning?: boolean;
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

export const StepProgress: React.FC<StepProgressProps> = ({
  currentStep,
  pipelineData,
  onSelectStep,
  onRunFullPipelineAuto,
  isAutoPipelineRunning = false,
}) => {
  const getStepStatus = (id: StepId) => {
    const key = `step${id}` as keyof PipelineData;
    return pipelineData[key].status;
  };

  const completedCount = STEP_CONFIG.filter((s) => getStepStatus(s.id) === 'completed').length;

  return (
    <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-2xs mb-8 transition-all text-slate-900">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3.5 border-b border-slate-100">
        <div className="flex items-center gap-2.5">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-600 animate-pulse" />
          <h2 className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-2">
            <span>BUV 5步内容反推工作台</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-50 text-blue-700 border border-blue-200/60 font-medium flex items-center gap-1">
              <Layers className="w-3 h-3" />
              全自动上下文继承
            </span>
          </h2>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-xs text-slate-500 font-medium flex items-center gap-1.5">
            <span>完成度</span>
            <span className="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-200/80">
              {completedCount} / 5
            </span>
          </div>

          {onRunFullPipelineAuto && (
            <button
              onClick={onRunFullPipelineAuto}
              disabled={isAutoPipelineRunning}
              className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-2xs transition-all cursor-pointer disabled:opacity-70 ${
                isAutoPipelineRunning ? 'cursor-wait animate-pulse' : ''
              }`}
            >
              {isAutoPipelineRunning ? (
                <>
                  <Sparkles className="w-4 h-4 animate-spin text-white" />
                  <span>全自动反推中 (Step {currentStep}/5)...</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 fill-white text-white" />
                  <span>一键全自动贯通反推 (Step 1→5)</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Progress Step Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {STEP_CONFIG.map((step, idx) => {
          const status = getStepStatus(step.id);
          const isCurrent = currentStep === step.id;
          const isCompleted = status === 'completed';
          const isRunning = status === 'running';
          const Icon = step.icon;

          return (
            <button
              key={step.id}
              onClick={() => onSelectStep(step.id)}
              className={`group text-left p-3.5 rounded-xl border transition-all duration-200 cursor-pointer ${
                isCurrent
                  ? 'bg-blue-50/90 border-blue-300 text-blue-900 shadow-2xs'
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
                        : isCurrent
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-slate-100 border-slate-200 text-slate-600'
                    }`}
                  >
                    {isCompleted ? <Check className="w-3.5 h-3.5 stroke-[2.5]" /> : step.id}
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
              <div className="mt-2.5 flex items-center justify-between">
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                    isRunning
                      ? 'bg-amber-50 border-amber-200 text-amber-700 animate-pulse'
                      : isCompleted
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      : 'bg-slate-100 border-slate-200/60 text-slate-500'
                  }`}
                >
                  {isRunning ? '生成中...' : isCompleted ? '已就绪' : '待运行'}
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
};

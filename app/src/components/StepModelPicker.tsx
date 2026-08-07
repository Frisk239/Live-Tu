import React from 'react';
import { Cpu } from 'lucide-react';
import { ModelMetadata } from '../data/models';

export type ModelCategory = 'text' | 'image' | 'video';

const CATEGORY_META: Record<
  ModelCategory,
  { title: string; badge: string; emptyHint: string }
> = {
  text: {
    title: '文本 / 多模态 AI 模型',
    badge: 'LLM',
    emptyHint: '暂无启用的文本模型。请到「模型配置」页启用 Gemini 3.6 Flash 等。',
  },
  image: {
    title: '文生图 AI 模型',
    badge: 'Image',
    emptyHint: '暂无启用的文生图模型。请到「模型配置」页启用 GPT Image 2 等。',
  },
  video: {
    title: '图生视频 AI 模型',
    badge: 'Video',
    emptyHint: '暂无启用的视频模型。请到「模型配置」页启用 Seedance。',
  },
};

interface StepModelPickerProps {
  category: ModelCategory;
  models: ModelMetadata[];
  value?: string;
  defaultId?: string;
  onChange: (modelId: string) => void;
  /** 可选副标题，覆盖默认 title */
  title?: string;
  className?: string;
}

/**
 * 工作台各步共用的模型选择器：只展示已启用模型，并显示推荐场景/速度/质量。
 */
export const StepModelPicker: React.FC<StepModelPickerProps> = ({
  category,
  models,
  value,
  defaultId,
  onChange,
  title,
  className = '',
}) => {
  const meta = CATEGORY_META[category];
  const enabled = models.filter((m) => m.enabled);
  const preferred =
    value ||
    defaultId ||
    enabled.find((m) => m.isDefault)?.id ||
    enabled[0]?.id ||
    '';
  const selected = enabled.find((m) => m.id === preferred) || enabled[0];

  return (
    <div
      className={`p-3.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl space-y-2 ${className}`}
    >
      <div className="flex items-center justify-between text-xs font-semibold text-slate-800 dark:text-slate-200">
        <span className="flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-blue-600" />
          {title || meta.title}
        </span>
        <span className="text-[10px] text-blue-700 bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 px-2 py-0.5 rounded-full font-semibold">
          {meta.badge}
        </span>
      </div>

      {enabled.length === 0 ? (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
          {meta.emptyHint}
        </p>
      ) : (
        <select
          value={preferred}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500 shadow-2xs cursor-pointer font-semibold"
        >
          {enabled.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.isDefault ? ' ★默认' : ''} — {m.recommendedScenario || m.modelCode} ({m.speedRating})
            </option>
          ))}
        </select>
      )}

      {selected && (
        <div className="text-[11px] bg-white dark:bg-slate-900 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400 shrink-0">模型代码</span>
            <span className="font-mono text-[10px] text-slate-800 dark:text-slate-200 truncate">
              {selected.modelCode || selected.id}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400 shrink-0">推荐场景</span>
            <span className="font-medium text-slate-800 dark:text-slate-200 text-right">
              {selected.recommendedScenario || '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">预估速度</span>
            <span className="font-semibold text-emerald-600">
              {selected.speedRating} ({selected.speedMs})
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">质量评级</span>
            <span className="font-semibold text-indigo-600">{selected.qualityRating}</span>
          </div>
          {selected.description && (
            <p className="pt-1 border-t border-slate-100 dark:border-slate-800 text-slate-500 leading-relaxed">
              {selected.description}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

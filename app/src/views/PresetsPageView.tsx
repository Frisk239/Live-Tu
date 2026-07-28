import React from 'react';
import { MOCK_PRESET_TEMPLATES } from '../data/presets';
import { PresetTemplate } from '../types';
import { ArrowRight, ArrowLeft, Layers } from 'lucide-react';

interface PresetsPageViewProps {
  onSelectPreset: (preset: PresetTemplate) => void;
  onBackToPipeline: () => void;
}

export const PresetsPageView: React.FC<PresetsPageViewProps> = ({
  onSelectPreset,
  onBackToPipeline,
}) => {
  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBackToPipeline}
            className="p-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 shadow-2xs transition-all flex items-center gap-1.5 text-xs font-semibold shrink-0 cursor-pointer"
            title="返回主流水线"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
            <span>返回流水线</span>
          </button>

          <div className="p-3 rounded-xl bg-blue-50 text-blue-600 border border-blue-200/60 shrink-0">
            <Layers className="w-6 h-6" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">爆款短视频模版与反推预设库</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60 text-[11px] font-semibold">
                PRESETS
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              精选高转化抖音/小红书小绿泥爆款内容链路，一键填充 5 步全套参数并启动渲染。
            </p>
          </div>
        </div>
      </div>

      {/* Presets Grid */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {MOCK_PRESET_TEMPLATES.map((preset) => (
            <div
              key={preset.id}
              onClick={() => {
                onSelectPreset(preset);
                onBackToPipeline();
              }}
              className="group relative flex flex-col sm:flex-row items-stretch gap-4 p-5 rounded-xl bg-slate-50 hover:bg-blue-50/50 border border-slate-200/80 hover:border-blue-300 cursor-pointer transition-all shadow-2xs"
            >
              {/* Image Thumbnail */}
              <div className="relative w-full sm:w-44 h-36 rounded-lg overflow-hidden shrink-0 bg-slate-950 border border-slate-200">
                <img
                  src={preset.coverImage}
                  alt={preset.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200/60 shadow-2xs">
                  {preset.tag}
                </div>
              </div>

              {/* Info */}
              <div className="flex-1 flex flex-col justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                    {preset.title}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                    {preset.description}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-200/80 flex items-center justify-between">
                  <span className="text-[11px] text-slate-400 font-mono">
                    含完整 5 步反推链 Prompt
                  </span>

                  <button className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 group-hover:translate-x-0.5 transition-all cursor-pointer">
                    <span>载入流水线</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

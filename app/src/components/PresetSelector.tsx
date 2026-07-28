import React from 'react';
import { MOCK_PRESET_TEMPLATES } from '../data/presets';
import { PresetTemplate } from '../types';
import { X, Sparkles, ArrowRight } from 'lucide-react';

interface PresetSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectPreset: (preset: PresetTemplate) => void;
}

export const PresetSelector: React.FC<PresetSelectorProps> = ({
  isOpen,
  onClose,
  onSelectPreset,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200/90 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/80">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-50 text-blue-600 border border-blue-200/60">
              <Sparkles className="w-4 h-4" />
            </div>
            <h3 className="text-base font-bold text-slate-900">
              载入爆款视频反推预设模版
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* List of presets */}
        <div className="p-6 overflow-y-auto space-y-4">
          <p className="text-xs text-slate-500">
            选择一套经过验证的抖音/小红书小绿泥爆款内容链路，一键填充 5 步完整数据：
          </p>

          <div className="grid grid-cols-1 gap-4">
            {MOCK_PRESET_TEMPLATES.map((preset) => (
              <div
                key={preset.id}
                onClick={() => {
                  onSelectPreset(preset);
                  onClose();
                }}
                className="group relative flex flex-col sm:flex-row items-stretch gap-4 p-4 rounded-xl bg-slate-50 hover:bg-blue-50/50 border border-slate-200/80 hover:border-blue-300 cursor-pointer transition-all shadow-2xs"
              >
                {/* Image Thumbnail */}
                <div className="relative w-full sm:w-36 h-28 rounded-lg overflow-hidden shrink-0 bg-slate-950 border border-slate-200">
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
                    <h4 className="text-sm font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                      {preset.title}
                    </h4>
                    <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                      {preset.description}
                    </p>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-[11px] text-slate-400 font-mono">
                      含完整的 Prompt / 文案 / BGM / FFmpeg 视轨
                    </span>

                    <button className="flex items-center gap-1 text-xs font-semibold text-blue-600 group-hover:translate-x-1 transition-transform">
                      <span>载入流水线</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

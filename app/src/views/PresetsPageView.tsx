import React from 'react';
import { ArrowRight, ArrowLeft, Layers, Trash2 } from 'lucide-react';
import { PresetTemplate } from '../types';

interface PresetsPageViewProps {
  presets: PresetTemplate[];
  onSelectPreset: (preset: PresetTemplate) => void;
  onBackToPipeline: () => void;
  onDeletePreset?: (presetId: string) => void;
}

export const PresetsPageView: React.FC<PresetsPageViewProps> = ({
  presets,
  onSelectPreset,
  onBackToPipeline,
  onDeletePreset,
}) => {
  const [categoryFilter, setCategoryFilter] = React.useState<string>('all');
  const [searchQuery, setSearchQuery] = React.useState<string>('');

  const filteredPresets = presets.filter((p) => {
    const matchesSearch =
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.tag.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;

    if (categoryFilter === 'all') return true;
    const cat = (p as any).category || (p.tag.includes('抖音') ? 'douyin' : p.tag.includes('小红书') ? 'xiaohongshu' : p.tag.includes('视频号') ? 'shipinhao' : 'universal');
    return cat === categoryFilter;
  });
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
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs space-y-4">
        {/* Category Filters */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pb-4 border-b border-slate-100">
          <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
            <span className="text-xs font-semibold text-slate-500 mr-1 shrink-0">平台赛道:</span>
            {['all', 'douyin', 'xiaohongshu', 'shipinhao', 'kuaishou'].map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 transition-all cursor-pointer ${
                  categoryFilter === cat
                    ? 'bg-blue-600 text-white shadow-2xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {cat === 'all' ? '全部模版' : cat === 'douyin' ? '抖音爆款' : cat === 'xiaohongshu' ? '小红书种草' : cat === 'shipinhao' ? '视频号品质' : '快手素人'}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <input
              type="text"
              placeholder="搜索爆款模版关键词..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 focus:bg-white focus:outline-hidden focus:border-blue-500"
            />
          </div>
        </div>

        {filteredPresets.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <p className="text-sm">未找到匹配的预设模版</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {presets.map((preset) => (
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

                    <div className="flex items-center gap-3">
                      {onDeletePreset && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`确定要删除预设「${preset.title}」吗？`)) {
                              onDeletePreset(preset.id);
                            }
                          }}
                          className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                          title="删除此预设"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                      <button className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 group-hover:translate-x-0.5 transition-all cursor-pointer">
                        <span>载入流水线</span>
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

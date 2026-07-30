import React, { useState } from 'react';
import {
  ArrowRight,
  ArrowLeft,
  Layers,
  Trash2,
  Eye,
  Sparkles,
  Film,
  Music,
  FileText,
  Clock,
  CheckCircle2,
  X,
  Volume2,
  Flame,
  ShieldCheck,
  Zap,
  Activity,
  Heart,
  Award,
  Maximize2,
} from 'lucide-react';
import { PresetTemplate, ShotItem } from '../types';

interface PresetsPageViewProps {
  presets: PresetTemplate[];
  onSelectPreset: (preset: PresetTemplate) => void;
  onBackToPipeline: () => void;
  onDeletePreset?: (presetId: string) => void;
}

export const FORMULA_CATEGORIES = [
  { id: 'all', label: '全部 8 大爆款公式', badge: '全套示范', icon: Sparkles },
  { id: 'preset_3s_hook', label: '🔥 3秒反差惊悚', badge: '李响-005.MOV', icon: Flame },
  { id: 'preset_before_after', label: '🆚 清水 vs 对比', badge: '赖雨华-0701.mp4', icon: Zap },
  { id: 'preset_morning_routine', label: '🌿 治愈晨间Routine', badge: '小红书Vlog', icon: Heart },
  { id: 'preset_sgs_science', label: '📊 SGS 科学背书', badge: '0716-毛孔.mp4', icon: ShieldCheck },
  { id: 'preset_128bpm_beat', label: '🎵 128BPM 卡点道具', badge: '李响-018.mp4', icon: Activity },
  { id: 'preset_emotional_story', label: '💕 前后蜕变共鸣', badge: '郭海艳.mp4', icon: Heart },
  { id: 'preset_brand_trust', label: '🏆 品质信任品牌', badge: '沙利文第一', icon: Award },
  { id: 'preset_asmr_macro', label: '🎤 ASMR 微距 60FPS', badge: '黎晓晓.mp4', icon: Volume2 },
];

export const PLATFORM_FILTERS = [
  { id: 'all', label: '全部平台' },
  { id: 'douyin', label: '抖音爆款' },
  { id: 'xiaohongshu', label: '小红书种草' },
  { id: 'shipinhao', label: '视频号品质' },
];

export const PresetsPageView: React.FC<PresetsPageViewProps> = ({
  presets,
  onSelectPreset,
  onBackToPipeline,
  onDeletePreset,
}) => {
  const [formulaFilter, setFormulaFilter] = useState<string>('all');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Preview Modal state
  const [previewPreset, setPreviewPreset] = useState<PresetTemplate | null>(null);
  const [previewTab, setPreviewTab] = useState<number>(1);

  const filteredPresets = presets.filter((p) => {
    const matchesSearch =
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.tag.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;

    // Formula filter
    if (formulaFilter !== 'all') {
      const matchFormula = (p as any).formula === formulaFilter || p.id === formulaFilter;
      if (!matchFormula) return false;
    }

    // Platform filter
    if (platformFilter !== 'all') {
      const cat = (p as any).category || (p.tag.includes('抖音') ? 'douyin' : p.tag.includes('小红书') ? 'xiaohongshu' : 'shipinhao');
      if (cat !== platformFilter) return false;
    }

    return true;
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
              <h1 className="text-lg font-bold text-slate-900">8 大黄金爆款示范模板库精雕</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60 text-[11px] font-semibold">
                8 GOLDEN PRESETS
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              一对一深度还原《爆款视频/》真实视听拆解（128BPM卡点、SGS标红、60FPS微距、3cm道具）。全模版使用 <code className="bg-slate-100 text-slate-700 px-1 py-0.5 rounded font-mono text-[11px]">${`{product.name}`}</code> 通用变量，无品牌泄漏。
            </p>
          </div>
        </div>
      </div>

      {/* Main Presets Container */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs space-y-5">
        {/* 8 Golden Formulas Style Category Tabs */}
        <div className="space-y-2.5 pb-4 border-b border-slate-100">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              8 大黄金爆款公式风格:
            </span>
            <span className="text-xs text-slate-400">点击标签快速筛选大师级示范</span>
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
            {FORMULA_CATEGORIES.map((cat) => {
              const IconComp = cat.icon;
              const isActive = formulaFilter === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setFormulaFilter(cat.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-xs font-semibold'
                      : 'bg-slate-50 text-slate-600 hover:bg-slate-100 border border-slate-200/60'
                  }`}
                >
                  <IconComp className={`w-3.5 h-3.5 ${isActive ? 'text-white' : 'text-slate-500'}`} />
                  <span>{cat.label}</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${isActive ? 'bg-blue-700 text-blue-100' : 'bg-slate-200/70 text-slate-600'}`}>
                    {cat.badge}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Platform Filters & Search Bar */}
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500 mr-1 shrink-0">赛道平台:</span>
              {PLATFORM_FILTERS.map((pf) => (
                <button
                  key={pf.id}
                  onClick={() => setPlatformFilter(pf.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 transition-all cursor-pointer ${
                    platformFilter === pf.id
                      ? 'bg-slate-900 text-white font-semibold'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {pf.label}
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-64">
              <input
                type="text"
                placeholder="搜索 8 大示范模板关键词..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 focus:bg-white focus:outline-hidden focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Templates Grid */}
        {filteredPresets.length === 0 ? (
          <div className="text-center py-16 text-slate-400 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
            <Layers className="w-10 h-10 mx-auto text-slate-300 mb-2" />
            <p className="text-sm font-medium">未找到匹配的 8 大爆款预设模版</p>
            <p className="text-xs text-slate-400 mt-1">请尝试切换公式风格或清空搜索关键词</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {filteredPresets.map((preset) => {
              const pData = preset.pipelineData || {};
              const s1Output = pData.step1?.output;
              const s2Output = pData.step2?.output;
              const s3Output = pData.step3?.output;
              const shotCount = s1Output?.shotList?.length || 4;
              const bpm = s1Output?.audioAnalysis?.estimatedBpm || '128';

              return (
                <div
                  key={preset.id}
                  className="group relative flex flex-col sm:flex-row items-stretch gap-4 p-5 rounded-2xl bg-white hover:bg-blue-50/30 border border-slate-200/90 hover:border-blue-300 transition-all shadow-2xs hover:shadow-md"
                >
                  {/* Image Thumbnail & Badges */}
                  <div className="relative w-full sm:w-48 h-40 rounded-xl overflow-hidden shrink-0 bg-slate-950 border border-slate-200 shadow-2xs">
                    <img
                      src={preset.coverImage}
                      alt={preset.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 opacity-90 group-hover:opacity-100"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-black/20" />

                    {/* Tag Badge */}
                    <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md text-[11px] font-bold bg-blue-600 text-white shadow-xs">
                      {preset.tag}
                    </div>

                    {/* Tech Badges (BPM / 60FPS / Shot Count) */}
                    <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between text-[10px] text-white/90 font-mono">
                      <span className="bg-black/60 backdrop-blur-xs px-1.5 py-0.5 rounded border border-white/20">
                        {shotCount} 镜头分段
                      </span>
                      <span className="bg-emerald-600/80 backdrop-blur-xs px-1.5 py-0.5 rounded font-bold text-white">
                        {bpm !== '0' ? `${bpm} BPM` : '60FPS ASMR'}
                      </span>
                    </div>
                  </div>

                  {/* Info & Content */}
                  <div className="flex-1 flex flex-col justify-between min-w-0">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-bold text-slate-900 group-hover:text-blue-600 transition-colors truncate">
                          {preset.title}
                        </h3>
                        <span className="text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200/60 px-1.5 py-0.5 rounded shrink-0">
                          通用变量无泄漏
                        </span>
                      </div>

                      <p className="text-xs text-slate-500 mt-1.5 leading-relaxed line-clamp-2">
                        {preset.description}
                      </p>

                      {/* Script Preview Snippet */}
                      {s3Output?.hook && (
                        <div className="mt-2.5 p-2 rounded-lg bg-slate-50 border border-slate-200/60 text-[11px] text-slate-700">
                          <span className="font-semibold text-blue-600 mr-1">3秒 Hook:</span>
                          <span className="italic">“{s3Output.hook}”</span>
                        </div>
                      )}
                    </div>

                    {/* Action Bar */}
                    <div className="mt-4 pt-3 border-t border-slate-200/80 flex items-center justify-between gap-2">
                      <button
                        onClick={() => {
                          setPreviewPreset(preset);
                          setPreviewTab(1);
                        }}
                        className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 hover:text-blue-600 bg-slate-100 hover:bg-blue-50 px-2.5 py-1.5 rounded-lg border border-slate-200/80 transition-all cursor-pointer"
                        title="预览 5 步完整 Prompt 与文案"
                      >
                        <Eye className="w-3.5 h-3.5 text-blue-600" />
                        <span>预览 5 步 Prompt</span>
                      </button>

                      <div className="flex items-center gap-2">
                        {onDeletePreset && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`确定要删除示范预设「${preset.title}」吗？`)) {
                                onDeletePreset(preset.id);
                              }
                            }}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                            title="删除预设"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}

                        <button
                          onClick={() => {
                            onSelectPreset(preset);
                            onBackToPipeline();
                          }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-2xs hover:shadow-xs transition-all cursor-pointer"
                        >
                          <span>载入工作台</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 5-Step Detailed Preview Modal */}
      {previewPreset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            {/* Modal Header */}
            <div className="p-5 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
              <div className="flex items-center gap-3.5">
                <img
                  src={previewPreset.coverImage}
                  alt={previewPreset.title}
                  className="w-12 h-12 rounded-xl object-cover border border-slate-700 shrink-0"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-white">{previewPreset.title}</h2>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-600 text-white">
                      {previewPreset.tag}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{previewPreset.description}</p>
                </div>
              </div>

              <button
                onClick={() => setPreviewPreset(null)}
                className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 5 Step Navigation Tabs */}
            <div className="flex items-center border-b border-slate-200 bg-slate-50 px-5 gap-2 overflow-x-auto">
              {[
                { id: 1, label: 'Step 1: 视听拆解', icon: Film },
                { id: 2, label: 'Step 2: 运镜 & 多镜头', icon: Sparkles },
                { id: 3, label: 'Step 3: 爆款文案', icon: FileText },
                { id: 4, label: 'Step 4: BGM 匹配', icon: Music },
                { id: 5, label: 'Step 5: Subtitle Timeline', icon: Clock },
              ].map((tab) => {
                const Icon = tab.icon;
                const isActive = previewTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setPreviewTab(tab.id)}
                    className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition-all cursor-pointer whitespace-nowrap ${
                      isActive
                        ? 'border-blue-600 text-blue-600 bg-white'
                        : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-100/60'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Modal Body Content (Scrollable) */}
            <div className="p-6 overflow-y-auto flex-1 space-y-6 bg-slate-50/30">
              {/* TAB 1: Step 1 视听拆解 */}
              {previewTab === 1 && (() => {
                const s1 = previewPreset.pipelineData.step1?.output;
                return (
                  <div className="space-y-5">
                    {/* Visual Style & Rationale */}
                    <div className="p-4 rounded-xl bg-white border border-slate-200/80 space-y-3 shadow-2xs">
                      <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-blue-600" />
                        首帧画面 Visual Prompt & 拆解逻辑
                      </h4>
                      <div className="p-3 rounded-lg bg-slate-900 text-slate-100 text-xs font-mono leading-relaxed select-all">
                        {s1?.static_image_prompt || 'N/A'}
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed bg-blue-50/60 p-2.5 rounded-lg border border-blue-100">
                        <strong className="text-blue-800">拆解理由: </strong>
                        {s1?.rationale || '无'}
                      </p>
                    </div>

                    {/* Video Structure & Audio Analysis */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-2">
                        <h5 className="text-xs font-bold text-slate-800">叙事弧线与节奏 (Narrative Arc)</h5>
                        <p className="text-xs text-slate-600">
                          <strong>叙事流程: </strong>{s1?.videoStructure?.narrativeArc || 'N/A'}
                        </p>
                        <div className="flex gap-4 text-xs text-slate-500 pt-1">
                          <span>Hook 时机: <strong className="text-slate-800">{s1?.videoStructure?.hookTiming || '前3秒'}</strong></span>
                          <span>镜头节奏: <strong className="text-slate-800">{s1?.videoStructure?.pacing || 'fast'}</strong></span>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-2">
                        <h5 className="text-xs font-bold text-slate-800">音频与 BPM 节奏 (Audio Analysis)</h5>
                        <p className="text-xs text-slate-600">
                          <strong>音乐风格: </strong>{s1?.audioAnalysis?.musicStyle || 'N/A'}
                        </p>
                        <div className="flex gap-4 text-xs text-slate-500 pt-1">
                          <span>BPM: <strong className="text-emerald-600 font-bold">{s1?.audioAnalysis?.estimatedBpm || '128'}</strong></span>
                          <span>原视频口播: <strong className="text-slate-800">{s1?.originalScript?.hasVoiceover ? '有口播' : '纯音效'}</strong></span>
                        </div>
                      </div>
                    </div>

                    {/* Shot List Table */}
                    <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-3">
                      <h4 className="text-xs font-bold text-slate-800 flex items-center justify-between">
                        <span>真实视频镜头拆解表 (Shot List)</span>
                        <span className="text-[11px] font-normal text-slate-400">共 {s1?.shotList?.length || 0} 个镜头段</span>
                      </h4>

                      {s1?.shotList && s1.shotList.length > 0 ? (
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                              <tr>
                                <th className="p-2.5">镜头 #</th>
                                <th className="p-2.5">时间区间</th>
                                <th className="p-2.5">运镜方式</th>
                                <th className="p-2.5">画面描述 (Visual)</th>
                                <th className="p-2.5">情绪</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 text-slate-700">
                              {s1.shotList.map((shot: ShotItem, idx: number) => (
                                <tr key={idx} className="hover:bg-slate-50">
                                  <td className="p-2.5 font-bold text-blue-600">Shot {shot.shotIndex || idx + 1}</td>
                                  <td className="p-2.5 font-mono text-slate-500">{shot.startTime || '0.0s'} - {shot.endTime || '3.0s'}</td>
                                  <td className="p-2.5 font-medium">{shot.cameraMovement || shot.shotType || '前推'}</td>
                                  <td className="p-2.5 text-slate-800">{shot.description}</td>
                                  <td className="p-2.5 text-slate-500">{shot.mood || '吸睛'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-xs text-slate-400">未包含 Shot List</p>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* TAB 2: Step 2 运镜 & 多镜头 */}
              {previewTab === 2 && (() => {
                const s2 = previewPreset.pipelineData.step2?.output;
                return (
                  <div className="space-y-5">
                    <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-3">
                      <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                        Seedance 60FPS 视频生成 Prompt
                      </h4>
                      <div className="p-3 rounded-lg bg-slate-900 text-emerald-400 text-xs font-mono leading-relaxed select-all">
                        {s2?.video_prompt || 'N/A'}
                      </div>
                      <div className="flex gap-4 text-xs text-slate-600 pt-1">
                        <span>运镜类型: <strong className="text-blue-600 font-semibold">{s2?.motion_type || 'zoom_in'}</strong></span>
                        <span>运镜强度: <strong className="text-slate-800">{s2?.motion_intensity || 'medium'}</strong></span>
                        <span>时长: <strong className="text-slate-800">{s2?.duration_sec || '4'}秒</strong></span>
                      </div>
                    </div>

                    {s2?.shotPrompts && s2.shotPrompts.length > 0 && (
                      <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-3">
                        <h4 className="text-xs font-bold text-slate-800">多镜头分段 Prompts (Multi-Shot Prompts)</h4>
                        <div className="space-y-2">
                          {s2.shotPrompts.map((pText: string, i: number) => (
                            <div key={i} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/60 text-xs flex gap-2">
                              <span className="font-bold text-blue-600 shrink-0">Shot {i + 1}:</span>
                              <span className="font-mono text-slate-700">{pText}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* TAB 3: Step 3 爆款文案 */}
              {previewTab === 3 && (() => {
                const s3 = previewPreset.pipelineData.step3?.output;
                return (
                  <div className="space-y-5">
                    <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-3">
                      <h4 className="text-xs font-bold text-slate-800">爆款文案标题 (Title)</h4>
                      <p className="text-sm font-bold text-slate-900 bg-blue-50/50 p-3 rounded-lg border border-blue-200/60">
                        {s3?.title || 'N/A'}
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-2">
                      <h4 className="text-xs font-bold text-slate-800 text-rose-600">黄金 3 秒 Hook 口播</h4>
                      <p className="text-xs text-slate-800 italic bg-rose-50/50 p-3 rounded-lg border border-rose-200/60">
                        “{s3?.hook || 'N/A'}”
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-2">
                      <h4 className="text-xs font-bold text-slate-800">口播正文与通用产品变量 (${`{product.name}`})</h4>
                      <div className="p-3 rounded-lg bg-slate-50 text-xs text-slate-800 whitespace-pre-wrap leading-relaxed border border-slate-200/80">
                        {s3?.body || 'N/A'}
                      </div>
                    </div>

                    {s3?.platform_fit && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="p-3.5 rounded-xl bg-amber-50/60 border border-amber-200/80 space-y-1.5">
                          <h5 className="text-xs font-bold text-amber-900">抖音强转化口播</h5>
                          <p className="text-xs text-amber-800 leading-relaxed">{s3.platform_fit.douyin}</p>
                        </div>
                        <div className="p-3.5 rounded-xl bg-rose-50/60 border border-rose-200/80 space-y-1.5">
                          <h5 className="text-xs font-bold text-rose-900">小红书治愈感口播</h5>
                          <p className="text-xs text-rose-800 leading-relaxed">{s3.platform_fit.xiaohongshu}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* TAB 4: Step 4 BGM 匹配 */}
              {previewTab === 4 && (() => {
                const s4 = previewPreset.pipelineData.step4?.output;
                const rec = s4?.bgm_recommendation;
                return (
                  <div className="space-y-5">
                    <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                          <Music className="w-4 h-4 text-emerald-600" />
                          推荐确权 BGM 曲目
                        </h4>
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                          {rec?.license_note || '已商业授权'}
                        </span>
                      </div>

                      <div className="p-3.5 rounded-xl bg-emerald-50/50 border border-emerald-200/80 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold text-emerald-950">{rec?.track_name || 'N/A'}</span>
                          <span className="text-xs font-mono font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded">
                            {rec?.bpm || '128'} BPM
                          </span>
                        </div>
                        <p className="text-xs text-emerald-800">艺术家: {rec?.artist || 'Unknown'}</p>
                        <p className="text-xs text-slate-600"><strong>契合理由: </strong>{rec?.mood_match || 'N/A'}</p>
                        <p className="text-xs text-slate-600"><strong>卡点时间 (Sync Points): </strong>{rec?.sync_point || 'N/A'}</p>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* TAB 5: Step 5 Subtitle Timeline */}
              {previewTab === 5 && (() => {
                const s5 = previewPreset.pipelineData.step5?.output;
                return (
                  <div className="space-y-5">
                    <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-2xs space-y-3">
                      <h4 className="text-xs font-bold text-slate-800 flex items-center justify-between">
                        <span>字幕与轨控制 Timeline</span>
                        <span className="text-[11px] font-normal text-slate-400">共 {s5?.timeline?.length || 0} 个 Timeline 节点</span>
                      </h4>

                      {s5?.timeline && s5.timeline.length > 0 ? (
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                              <tr>
                                <th className="p-2.5">时间点 (at)</th>
                                <th className="p-2.5">区间 (start-end)</th>
                                <th className="p-2.5">动作类型</th>
                                <th className="p-2.5">字幕/源文本 (Text/Source)</th>
                                <th className="p-2.5">位置</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 text-slate-700">
                              {s5.timeline.map((item: any, idx: number) => (
                                <tr key={idx} className="hover:bg-slate-50">
                                  <td className="p-2.5 font-mono font-bold text-blue-600">{item.at}</td>
                                  <td className="p-2.5 font-mono text-slate-500">
                                    {item.startSec !== undefined ? `${item.startSec}s - ${item.endSec}s` : '自动对齐'}
                                  </td>
                                  <td className="p-2.5">
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                      item.action === 'subtitle_in' ? 'bg-blue-100 text-blue-800' : item.action === 'brand_stamp' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'
                                    }`}>
                                      {item.action}
                                    </span>
                                  </td>
                                  <td className="p-2.5 text-slate-900 font-medium">{item.text || item.source || '-'}</td>
                                  <td className="p-2.5 text-slate-400 font-mono text-[10px]">{item.position || 'bottom'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-xs text-slate-400">未提供 Timeline</p>
                      )}
                    </div>

                    {s5?.qa_checklist && (
                      <div className="p-4 rounded-xl bg-emerald-50/50 border border-emerald-200/80 space-y-2">
                        <h5 className="text-xs font-bold text-emerald-900">QA Checklist 质量校验</h5>
                        <ul className="space-y-1">
                          {s5.qa_checklist.map((qa: string, i: number) => (
                            <li key={i} className="text-xs text-emerald-800 flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                              <span>{qa}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-100 border-t border-slate-200 flex items-center justify-between">
              <button
                onClick={() => setPreviewPreset(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-200 transition-colors cursor-pointer"
              >
                关闭预览
              </button>

              <button
                onClick={() => {
                  onSelectPreset(previewPreset);
                  setPreviewPreset(null);
                  onBackToPipeline();
                }}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md hover:shadow-lg transition-all cursor-pointer"
              >
                <span>一键载入此模板至工作台</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

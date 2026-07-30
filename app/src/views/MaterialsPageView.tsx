import React, { useState } from 'react';
import {
  Upload,
  Video,
  Image as ImageIcon,
  Trash2,
  Check,
  Film,
  Eye,
  X,
  ArrowLeft,
  Tag,
  Plus,
  Maximize2,
  Sparkles,
} from 'lucide-react';
import { MaterialItem } from '../types';
import { apiService } from '../services/api';
import { notify } from '../services/notifications';

interface MaterialsPageViewProps {
  materials: MaterialItem[];
  onAddMaterials: (items: MaterialItem[]) => void;
  onDeleteMaterial: (id: string) => void;
  onSelectMaterial: (material: MaterialItem) => void;
  onBackToPipeline: () => void;
}

const PRESET_TAGS = [
  '产品特写',
  '使用过程',
  '效果对比',
  '包装开箱',
  'SGS报告',
  '质感展示',
  '成分拆解',
];

export const MaterialsPageView: React.FC<MaterialsPageViewProps> = ({
  materials,
  onAddMaterials,
  onDeleteMaterial,
  onSelectMaterial,
  onBackToPipeline,
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'video' | 'image'>('all');
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>('all');
  const [selectedPreview, setSelectedPreview] = useState<MaterialItem | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [tagPickerMaterialId, setTagPickerMaterialId] = useState<string | null>(null);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);

    try {
      const newItems: MaterialItem[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const item = await apiService.materials.uploadMaterial(file);
        newItems.push(item);
      }
      onAddMaterials(newItems);
    } catch (err: any) {
      notify(`上传失败: ${err?.message || '网络问题'}`, 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const handleImportViralDirectory = async () => {
    setIsUploading(true);
    try {
      const res = await apiService.materials.importDirectory();
      if (res.success) {
        notify(`✅ ${res.message}`, 'success');
        const updated = await apiService.materials.fetchMaterials();
        onAddMaterials(updated);
      } else {
        notify(`导入失败: ${res.message || '目录未找到'}`, 'error');
      }
    } catch (err: any) {
      notify(`导入失败: ${err.message}`, 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const handleToggleTag = async (materialId: string, tagToToggle: string) => {
    const target = materials.find((m) => m.id === materialId);
    if (!target) return;

    const currentTags = Array.isArray(target.tags) ? target.tags : [];
    const newTags = currentTags.includes(tagToToggle)
      ? currentTags.filter((t) => t !== tagToToggle)
      : [...currentTags, tagToToggle];

    // Optimistic UI update
    const updatedMaterials = materials.map((m) =>
      m.id === materialId ? { ...m, tags: newTags } : m
    );
    onAddMaterials(updatedMaterials);

    try {
      await apiService.materials.updateMaterialTags(materialId, newTags);
    } catch (err) {
      console.warn('Failed to update material tags:', err);
    }
  };

  const filteredMaterials = materials.filter((item) => {
    const matchesTab = activeTab === 'all' || item.type === activeTab;

    const itemTags = Array.isArray(item.tags) ? item.tags : [];
    const matchesTag =
      selectedTagFilter === 'all' || itemTags.includes(selectedTagFilter);

    const matchesSearch =
      !searchQuery ||
      item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      itemTags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));

    return matchesTab && matchesTag && matchesSearch;
  });

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
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
            <Film className="w-6 h-6" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">爆款短视频与素材库深度优化</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60 text-[11px] font-semibold flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-blue-600" />
                FFPROBE META & TAG SYSTEM
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              展示 FFprobe 提取的精确分辨率/时长，支持打上产品特写、使用过程、SGS报告等标准化标签。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleImportViralDirectory}
            disabled={isUploading}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-2xs transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50"
            title="一键扫描并导入根目录 [爆款视频] 下的所有 .mp4 文件"
          >
            <Film className="w-4 h-4" />
            <span>一键导入爆款视频目录</span>
          </button>
          <div className="text-right text-xs font-medium text-slate-500 hidden md:block bg-slate-50 border border-slate-200/80 px-3.5 py-2 rounded-xl shadow-2xs">
            已纳管 <span className="text-blue-600 font-bold text-sm">{materials.length}</span> 个物料
          </div>
        </div>
      </div>

      {/* Upload Dropzone Section */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        <label className="relative group border border-dashed border-slate-300 hover:border-blue-500 rounded-xl p-6 bg-slate-50/50 hover:bg-blue-50/30 text-center transition-all cursor-pointer flex flex-col items-center justify-center gap-3">
          <input
            type="file"
            multiple
            accept="video/*,image/*"
            className="hidden"
            onChange={(e) => handleFileUpload(e.target.files)}
          />
          <div className="p-3 rounded-xl bg-blue-50 text-blue-600 border border-blue-200/60 group-hover:scale-105 transition-transform">
            <Upload className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-900">
              {isUploading ? '素材正在解析并调用 FFprobe 提取元数据中...' : '点击上传或将爆款视频/原图拖拽至此处'}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              支持 MP4, MOV, JPG, PNG 批量导入，系统将自动使用 FFprobe 提取 exact duration & dimensions
            </p>
          </div>
        </label>
      </div>

      {/* Multi-Dimensional Filter Bar */}
      <div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-2xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          {/* Media Type Tabs */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'all'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              全部 ({materials.length})
            </button>
            <button
              onClick={() => setActiveTab('video')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'video'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              🎬 视频 ({materials.filter((m) => m.type === 'video').length})
            </button>
            <button
              onClick={() => setActiveTab('image')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'image'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              🖼️ 图片 ({materials.filter((m) => m.type === 'image').length})
            </button>
          </div>

          {/* Search Bar */}
          <div className="relative">
            <input
              type="text"
              placeholder="搜索素材名称或标签..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs bg-slate-50 focus:bg-white focus:border-blue-500 focus:outline-none w-52 transition-all"
            />
          </div>
        </div>

        {/* Tag Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
          <Tag className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-500 shrink-0">素材分类标签:</span>
          <button
            onClick={() => setSelectedTagFilter('all')}
            className={`px-2.5 py-1 rounded-md text-[11px] shrink-0 transition-all cursor-pointer ${
              selectedTagFilter === 'all'
                ? 'bg-blue-600 text-white font-bold'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            全部标签
          </button>
          {PRESET_TAGS.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTagFilter(tag)}
              className={`px-2.5 py-1 rounded-md text-[11px] shrink-0 transition-all cursor-pointer ${
                selectedTagFilter === tag
                  ? 'bg-blue-600 text-white font-bold'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      {/* Materials Grid Display */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        {filteredMaterials.length === 0 ? (
          <div className="py-20 text-center text-slate-400 space-y-2">
            <Film className="w-10 h-10 mx-auto text-slate-300" />
            <p className="text-xs font-semibold text-slate-600">未检索到符合条件的素材物料</p>
            <p className="text-[11px] text-slate-400">请点上方「一键导入爆款视频目录」或上传文件</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
            {filteredMaterials.map((item) => {
              const itemTags = Array.isArray(item.tags) ? item.tags : [];
              const isPickerOpen = tagPickerMaterialId === item.id;

              return (
                <div
                  key={item.id}
                  className="group relative bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-2xs hover:border-blue-300 transition-all flex flex-col justify-between"
                >
                  {/* Media View Frame */}
                  <div className="relative aspect-video bg-slate-950 overflow-hidden border-b border-slate-100">
                    {item.type === 'video' ? (
                      <div className="relative w-full h-full">
                        <video
                          src={item.url}
                          className="w-full h-full object-cover"
                          muted
                          loop
                          onMouseOver={(e) => (e.target as HTMLVideoElement).play()}
                          onMouseOut={(e) => (e.target as HTMLVideoElement).pause()}
                        />
                        {/* FFprobe Duration Badge */}
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-slate-900/80 text-white text-[10px] font-semibold flex items-center gap-1 backdrop-blur-xs">
                          <Video className="w-3 h-3 text-blue-400" />
                          <span>{item.duration || '00:15'}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="relative w-full h-full">
                        <img src={item.url} alt={item.name} className="w-full h-full object-cover" />
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-slate-900/80 text-white text-[10px] font-semibold flex items-center gap-1 backdrop-blur-xs">
                          <ImageIcon className="w-3 h-3 text-emerald-400" />
                          <span>图片素材</span>
                        </div>
                      </div>
                    )}

                    {/* FFprobe Resolution Badge */}
                    {item.dimensions && (
                      <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-black/70 text-slate-200 text-[10px] font-mono backdrop-blur-xs">
                        {item.dimensions}
                      </div>
                    )}

                    {/* Hover Overlay Controls */}
                    <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-2 transition-opacity">
                      <button
                        onClick={() => setSelectedPreview(item)}
                        className="p-2 rounded-xl bg-white/90 text-slate-700 hover:bg-white shadow-2xs transition-colors cursor-pointer"
                        title="预览全屏与详细元信息"
                      >
                        <Maximize2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          onSelectMaterial(item);
                          onBackToPipeline();
                        }}
                        className="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-2xs transition-all flex items-center gap-1 cursor-pointer"
                      >
                        <Check className="w-4 h-4" />
                        <span>载入 Step 1 拆解</span>
                      </button>
                    </div>
                  </div>

                  {/* Material Info & Tag Management */}
                  <div className="p-3.5 space-y-2 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-bold text-xs text-slate-900 truncate" title={item.name}>
                          {item.name}
                        </p>
                        <p className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-2 font-mono">
                          <span>{item.size}</span>
                          {item.dimensions && (
                            <>
                              <span>·</span>
                              <span>{item.dimensions}</span>
                            </>
                          )}
                          {item.duration && (
                            <>
                              <span>·</span>
                              <span>{item.duration}</span>
                            </>
                          )}
                        </p>
                      </div>

                      <button
                        onClick={() => onDeleteMaterial(item.id)}
                        className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer shrink-0"
                        title="删除素材"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Tag list & quick edit button */}
                    <div className="relative pt-1 border-t border-slate-100 flex flex-wrap items-center gap-1">
                      {itemTags.map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 border border-blue-200/60 font-medium flex items-center gap-1"
                        >
                          <span>#{tag}</span>
                          <button
                            onClick={() => void handleToggleTag(item.id, tag)}
                            className="hover:text-rose-600 text-slate-400 cursor-pointer ml-0.5"
                            title="移除此标签"
                          >
                            ×
                          </button>
                        </span>
                      ))}

                      <button
                        onClick={() =>
                          setTagPickerMaterialId(isPickerOpen ? null : item.id)
                        }
                        className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 font-medium flex items-center gap-0.5 cursor-pointer"
                        title="打标签"
                      >
                        <Plus className="w-3 h-3" />
                        <span>标签</span>
                      </button>

                      {/* Tag Picker Popover */}
                      {isPickerOpen && (
                        <div className="absolute left-0 top-full mt-1 z-30 p-2 rounded-xl bg-white border border-slate-200 shadow-lg grid grid-cols-2 gap-1 w-48 text-[10px]">
                          {PRESET_TAGS.map((pt) => {
                            const active = itemTags.includes(pt);
                            return (
                              <button
                                key={pt}
                                onClick={() => void handleToggleTag(item.id, pt)}
                                className={`px-2 py-1 rounded-md text-[10px] font-medium text-left transition-colors cursor-pointer ${
                                  active
                                    ? 'bg-blue-600 text-white font-bold'
                                    : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                                }`}
                              >
                                {active ? `✓ ${pt}` : `+ ${pt}`}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Full Preview Player Modal with FFprobe Details */}
      {selectedPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white text-slate-900 border border-slate-200 shadow-2xl rounded-2xl max-w-4xl w-full p-5 overflow-hidden space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-bold text-sm truncate text-slate-900">{selectedPreview.name}</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  FFprobe 元数据解析: 分辨率 {selectedPreview.dimensions || '1080x1920'} · 时长 {selectedPreview.duration || '00:15'} · 大小 {selectedPreview.size}
                </p>
              </div>
              <button
                onClick={() => setSelectedPreview(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-xl overflow-hidden bg-black border border-slate-200 flex items-center justify-center max-h-[65vh]">
              {selectedPreview.type === 'video' ? (
                <video src={selectedPreview.url} controls autoPlay className="max-h-[65vh] w-full" />
              ) : (
                <img src={selectedPreview.url} alt="" className="max-h-[65vh] object-contain" />
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-slate-500">标签:</span>
                {(selectedPreview.tags || []).length > 0 ? (
                  (selectedPreview.tags || []).map((t) => (
                    <span key={t} className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px] font-medium border border-blue-200">
                      #{t}
                    </span>
                  ))
                ) : (
                  <span className="text-slate-400">暂无标签</span>
                )}
              </div>

              <button
                onClick={() => {
                  onSelectMaterial(selectedPreview);
                  setSelectedPreview(null);
                  onBackToPipeline();
                }}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-2xs cursor-pointer flex items-center gap-1"
              >
                <Check className="w-4 h-4" />
                <span>载入 Step 1 进行 AI 多模态反推</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

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
} from 'lucide-react';
import { MaterialItem } from '../types';
import { apiService } from '../services/api';

interface MaterialsPageViewProps {
  materials: MaterialItem[];
  onAddMaterials: (items: MaterialItem[]) => void;
  onDeleteMaterial: (id: string) => void;
  onSelectMaterial: (material: MaterialItem) => void;
  onBackToPipeline: () => void;
}

export const MaterialsPageView: React.FC<MaterialsPageViewProps> = ({
  materials,
  onAddMaterials,
  onDeleteMaterial,
  onSelectMaterial,
  onBackToPipeline,
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'video' | 'image'>('all');
  const [selectedPreview, setSelectedPreview] = useState<MaterialItem | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);

    const newItems: MaterialItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const item = await apiService.materials.uploadMaterial(file);
      newItems.push(item);
    }

    onAddMaterials(newItems);
    setIsUploading(false);
  };

  const filteredMaterials = materials.filter((item) => {
    if (activeTab === 'video') return item.type === 'video';
    if (activeTab === 'image') return item.type === 'image';
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Top Banner & Header */}
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
            <Film className="w-6 h-6" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">爆款短视频与图片素材库</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60 text-[11px] font-semibold">
                MEDIA ASSETS
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              可批量上传并在线预览短视频真素材，一键选定导入 5 步反推流水线。
            </p>
          </div>
        </div>

        <div className="text-right text-xs font-medium text-slate-500 hidden sm:block bg-slate-50 border border-slate-200/80 px-3 py-1.5 rounded-xl shadow-2xs">
          已纳管 <span className="text-slate-900 font-bold text-sm">{materials.length}</span> 个灵感素材
        </div>
      </div>

      {/* Upload Dropzone Section */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        <label className="relative group border border-dashed border-slate-300 hover:border-blue-500 rounded-xl p-8 bg-slate-50/50 hover:bg-blue-50/30 text-center transition-all cursor-pointer flex flex-col items-center justify-center gap-3">
          <input
            type="file"
            multiple
            accept="video/*,image/*"
            className="hidden"
            onChange={(e) => handleFileUpload(e.target.files)}
          />
          <div className="p-3.5 rounded-xl bg-blue-50 text-blue-600 border border-blue-200/60 group-hover:scale-105 transition-transform">
            <Upload className="w-7 h-7" />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-900">
              {isUploading ? '素材正在解析上传中...' : '点击上传或将爆款视频/原图拖拽至此处'}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              支持 MP4, MOV, JPG, PNG, Live Photo 等格式多选批量导入
            </p>
          </div>
        </label>
      </div>

      {/* Filter Tabs */}
      <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-2xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'all'
                ? 'bg-blue-600 text-white shadow-2xs'
                : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            全部素材 ({materials.length})
          </button>
          <button
            onClick={() => setActiveTab('video')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'video'
                ? 'bg-blue-600 text-white shadow-2xs'
                : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            🎬 视频素材 ({materials.filter((m) => m.type === 'video').length})
          </button>
          <button
            onClick={() => setActiveTab('image')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'image'
                ? 'bg-blue-600 text-white shadow-2xs'
                : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            📷 图片素材 ({materials.filter((m) => m.type === 'image').length})
          </button>
        </div>

        <span className="text-xs text-slate-500">
          选中素材后点击【导入流水线】即可将素材填充至Step 1
        </span>
      </div>

      {/* Materials Grid */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs">
        {filteredMaterials.length === 0 ? (
          <div className="py-20 text-center text-slate-400 space-y-2">
            <Film className="w-10 h-10 mx-auto text-slate-300" />
            <p className="text-xs font-semibold text-slate-600">暂无素材，请上传你的短视频或图文素材</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
            {filteredMaterials.map((item) => (
              <div
                key={item.id}
                className="group relative bg-white border border-slate-200/80 rounded-xl overflow-hidden shadow-2xs hover:border-slate-300 transition-all flex flex-col justify-between"
              >
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
                      <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-slate-900/80 text-white text-[10px] font-semibold flex items-center gap-1 backdrop-blur-xs">
                        <Video className="w-3 h-3 text-blue-400" />
                        <span>{item.duration || '00:15'}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="relative w-full h-full">
                      <img src={item.url} alt={item.name} className="w-full h-full object-cover" />
                      <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-slate-900/80 text-white text-[10px] font-semibold flex items-center gap-1 backdrop-blur-xs">
                        <ImageIcon className="w-3 h-3 text-blue-400" />
                        <span>IMAGE</span>
                      </div>
                    </div>
                  )}

                  {/* Hover Controls */}
                  <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-2 transition-opacity">
                    <button
                      onClick={() => setSelectedPreview(item)}
                      className="p-2 rounded-lg bg-white/90 text-slate-700 hover:bg-white shadow-2xs transition-colors cursor-pointer"
                      title="预览全屏"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        onSelectMaterial(item);
                        onBackToPipeline();
                      }}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-2xs transition-all flex items-center gap-1 cursor-pointer"
                    >
                      <Check className="w-4 h-4" />
                      <span>导入流水线</span>
                    </button>
                  </div>
                </div>

                <div className="p-3 flex items-center justify-between text-xs bg-white">
                  <div>
                    <p className="font-bold text-slate-900 truncate max-w-[140px]">{item.name}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{item.size}</p>
                  </div>

                  <button
                    onClick={() => onDeleteMaterial(item.id)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Preview Player Modal */}
      {selectedPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="bg-white text-slate-900 border border-slate-200/90 shadow-xl rounded-2xl max-w-3xl w-full p-4 overflow-hidden space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="font-bold text-sm truncate text-slate-900">{selectedPreview.name}</h3>
              <button
                onClick={() => setSelectedPreview(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="rounded-xl overflow-hidden bg-black border border-slate-200 flex items-center justify-center max-h-[70vh]">
              {selectedPreview.type === 'video' ? (
                <video src={selectedPreview.url} controls autoPlay className="max-h-[70vh] w-full" />
              ) : (
                <img src={selectedPreview.url} alt="" className="max-h-[70vh] object-contain" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

import React, { useState } from 'react';
import {
  X,
  Upload,
  Video,
  Image as ImageIcon,
  Trash2,
  Check,
  Eye,
  Film,
} from 'lucide-react';
import { MaterialItem } from '../types';
import { apiService } from '../services/api';

interface MaterialManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  materials: MaterialItem[];
  onAddMaterials: (items: MaterialItem[]) => void;
  onDeleteMaterial: (id: string) => void;
  onSelectMaterial: (material: MaterialItem) => void;
}

export const MaterialManagerModal: React.FC<MaterialManagerModalProps> = ({
  isOpen,
  onClose,
  materials,
  onAddMaterials,
  onDeleteMaterial,
  onSelectMaterial,
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'video' | 'image'>('all');
  const [selectedPreview, setSelectedPreview] = useState<MaterialItem | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  if (!isOpen) return null;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white text-slate-900 border border-slate-200/90 rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden transition-all">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/80">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600 border border-blue-200/60">
              <Film className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                爆款素材库与批量文件管理 (Media Asset Center)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                支持拖拽上传、点击上传、批量导出与视频真素材实时预览
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Upload Dropzone */}
        <div className="p-6 bg-slate-50/50 border-b border-slate-100">
          <label className="relative group border-2 border-dashed border-slate-200 hover:border-blue-500 rounded-2xl p-6 bg-white text-center transition-all cursor-pointer flex flex-col items-center justify-center gap-2 shadow-2xs">
            <input
              type="file"
              multiple
              accept="video/*,image/*"
              className="hidden"
              onChange={(e) => handleFileUpload(e.target.files)}
            />
            <div className="p-3 rounded-xl bg-blue-50 text-blue-600 border border-blue-200/60">
              <Upload className="w-6 h-6" />
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-900">
                {isUploading ? '素材正在批量解析并准备导入...' : '点击选择或直接将视频/图片素材拖拽至此处'}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                支持 MP4 / MOV / JPG / PNG / Live Photo 格式，支持多选批量上传
              </p>
            </div>
          </label>
        </div>

        {/* Filter Bar */}
        <div className="px-6 py-3 border-b border-slate-100 flex items-center justify-between bg-white">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'all'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              全部素材 ({materials.length})
            </button>
            <button
              onClick={() => setActiveTab('video')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'video'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              🎬 视频 ({materials.filter((m) => m.type === 'video').length})
            </button>
            <button
              onClick={() => setActiveTab('image')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'image'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              📷 图片 ({materials.filter((m) => m.type === 'image').length})
            </button>
          </div>

          <span className="text-xs text-slate-400 hidden sm:inline">
            选择素材后点击【使用】自动填充至反推输入框
          </span>
        </div>

        {/* Materials Grid */}
        <div className="p-6 overflow-y-auto flex-1 bg-white">
          {filteredMaterials.length === 0 ? (
            <div className="py-16 text-center text-slate-400">
              <Film className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p className="text-xs font-semibold">暂无素材，请上传你的短视频或爆款图片</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
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
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-slate-900/80 text-white text-[10px] font-mono font-medium flex items-center gap-1 backdrop-blur-xs">
                          <Video className="w-3 h-3 text-blue-400" />
                          <span>{item.duration || '00:15'}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="relative w-full h-full">
                        <img src={item.url} alt={item.name} className="w-full h-full object-cover" />
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-slate-900/80 text-white text-[10px] font-mono font-medium flex items-center gap-1 backdrop-blur-xs">
                          <ImageIcon className="w-3 h-3 text-emerald-400" />
                          <span>IMAGE</span>
                        </div>
                      </div>
                    )}

                    {/* Hover Controls */}
                    <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-2 transition-opacity">
                      <button
                        onClick={() => setSelectedPreview(item)}
                        className="p-2 rounded-lg bg-white text-slate-900 shadow-2xs cursor-pointer hover:bg-slate-100"
                        title="全屏预览"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          onSelectMaterial(item);
                          onClose();
                        }}
                        className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-2xs transition-all flex items-center gap-1 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>使用</span>
                      </button>
                    </div>
                  </div>

                  <div className="p-2.5 flex items-center justify-between text-xs">
                    <div>
                      <p className="font-semibold text-slate-900 truncate max-w-[120px]">
                        {item.name}
                      </p>
                      <p className="text-[10px] font-mono text-slate-400">{item.size}</p>
                    </div>

                    <button
                      onClick={() => onDeleteMaterial(item.id)}
                      className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                      title="删除此素材"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between text-xs text-slate-500">
          <span>当前库中共有 {materials.length} 个素材</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-2xs cursor-pointer"
          >
            完成
          </button>
        </div>
      </div>

      {/* Preview Player Modal */}
      {selectedPreview && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white text-slate-900 border border-slate-200/90 rounded-2xl shadow-xl max-w-2xl w-full p-4 overflow-hidden space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="font-semibold text-sm truncate">{selectedPreview.name}</h3>
              <button
                onClick={() => setSelectedPreview(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="rounded-xl overflow-hidden border border-slate-200 bg-slate-950 flex items-center justify-center max-h-[70vh]">
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

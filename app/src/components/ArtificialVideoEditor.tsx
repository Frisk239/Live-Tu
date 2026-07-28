import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Scissors,
  Trash2,
  Copy,
  Bookmark,
  Magnet,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Download,
  Upload,
  Type,
  Music,
  Smile,
  Wand2,
  Subtitles,
  Sliders,
  FolderOpen,
  Volume2,
  VolumeX,
  Sparkles,
  Check,
  X,
  ChevronDown,
  RotateCcw,
  Layers,
  Settings,
  Plus,
  Radio,
  FileText,
  Film,
  Disc,
} from 'lucide-react';

export interface TimelineClip {
  id: string;
  trackId: 'text' | 'video' | 'bgm' | 'sfx';
  name: string;
  startTime: number; // in seconds
  duration: number; // in seconds
  color: string;
  type: 'text' | 'video' | 'audio' | 'sfx';
  // Additional properties
  textValue?: string;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  textBgColor?: string;
  textStrokeColor?: string;
  volume?: number;
  speed?: number;
  filterName?: string;
}

interface ArtificialVideoEditorProps {
  initialVideoUrl?: string;
  initialTitle?: string;
  initialBgmTrack?: string;
  onClose?: () => void;
  onExport?: (clips: TimelineClip[]) => void;
}

export const ArtificialVideoEditor: React.FC<ArtificialVideoEditorProps> = ({
  initialVideoUrl = 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
  initialTitle = '高奢小绿泥晨间洗漱与泡泡揉搓',
  initialBgmTrack = '高奢晨间治愈轻音乐 (Lofi 85 BPM)',
  onClose,
  onExport,
}) => {
  // Navigation Active Tab
  const [activeTab, setActiveTab] = useState<
    'assets' | 'text' | 'audio' | 'effects' | 'captions' | 'ratio'
  >('text');

  // Player state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(1.2); // seconds
  const [totalDuration, setTotalDuration] = useState<number>(5.0); // seconds
  const [zoomLevel, setZoomLevel] = useState<number>(50); // percentage
  const [fitMode, setFitMode] = useState<'Fit' | '100%' | '75%' | '50%'>('Fit');
  const [aspectRatio, setAspectRatio] = useState<'9:16' | '16:9' | '1:1'>('9:16');
  const [selectedClipId, setSelectedClipId] = useState<string | null>('clip_text_1');
  const [magnetEnabled, setMagnetEnabled] = useState<boolean>(true);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);

  // Initial Clips state
  const [clips, setClips] = useState<TimelineClip[]>([
    {
      id: 'clip_text_1',
      trackId: 'text',
      name: initialTitle || 'Default text',
      startTime: 0,
      duration: 5.0,
      color: 'bg-emerald-500/80 border-emerald-400',
      type: 'text',
      textValue: initialTitle || ' Default text',
      fontFamily: '思源黑体',
      fontSize: 28,
      textColor: '#ffffff',
      textBgColor: 'rgba(0,0,0,0.5)',
      textStrokeColor: '#000000',
    },
    {
      id: 'clip_video_1',
      trackId: 'video',
      name: '纯净膏体拉丝特写.mp4',
      startTime: 0,
      duration: 5.0,
      color: 'bg-teal-600/80 border-teal-400',
      type: 'video',
      volume: 100,
      speed: 1.0,
      filterName: '小红书奶油风',
    },
    {
      id: 'clip_bgm_1',
      trackId: 'bgm',
      name: initialBgmTrack,
      startTime: 0,
      duration: 5.0,
      color: 'bg-indigo-600/80 border-indigo-400',
      type: 'audio',
      volume: 80,
    },
    {
      id: 'clip_sfx_1',
      trackId: 'sfx',
      name: '咔嚓快门+清水揉搓音效.mp3',
      startTime: 1.0,
      duration: 1.5,
      color: 'bg-amber-600/80 border-amber-400',
      type: 'sfx',
      volume: 90,
    },
  ]);

  // Selected Clip object helper
  const selectedClip = clips.find((c) => c.id === selectedClipId);

  // Playhead timer animation
  useEffect(() => {
    let interval: any;
    if (isPlaying) {
      interval = setInterval(() => {
        setCurrentTime((prev) => {
          if (prev >= totalDuration) {
            setIsPlaying(false);
            return 0;
          }
          return prev + 0.05;
        });
      }, 50);
    }
    return () => clearInterval(interval);
  }, [isPlaying, totalDuration]);

  // Update helper for selected clip properties
  const updateSelectedClip = (updates: Partial<TimelineClip>) => {
    if (!selectedClipId) return;
    setClips((prev) =>
      prev.map((clip) => {
        if (clip.id === selectedClipId) {
          return { ...clip, ...updates };
        }
        return clip;
      })
    );
  };

  // Add new clip helper
  const handleAddTextClip = (
    text: string,
    fontFamily: string,
    color: string,
    bg: string
  ) => {
    const newClip: TimelineClip = {
      id: `clip_text_${Date.now()}`,
      trackId: 'text',
      name: text,
      startTime: currentTime,
      duration: 3.0,
      color: 'bg-emerald-500/80 border-emerald-400',
      type: 'text',
      textValue: text,
      fontFamily: fontFamily,
      fontSize: 26,
      textColor: color,
      textBgColor: bg,
    };
    setClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClip.id);
  };

  const handleAddBgmClip = (trackName: string) => {
    const newClip: TimelineClip = {
      id: `clip_bgm_${Date.now()}`,
      trackId: 'bgm',
      name: trackName,
      startTime: 0,
      duration: 5.0,
      color: 'bg-indigo-600/80 border-indigo-400',
      type: 'audio',
      volume: 80,
    };
    setClips((prev) => [...prev.filter((c) => c.trackId !== 'bgm'), newClip]);
    setSelectedClipId(newClip.id);
  };

  const handleAddSfxClip = (sfxName: string) => {
    const newClip: TimelineClip = {
      id: `clip_sfx_${Date.now()}`,
      trackId: 'sfx',
      name: sfxName,
      startTime: currentTime,
      duration: 1.2,
      color: 'bg-amber-600/80 border-amber-400',
      type: 'sfx',
      volume: 90,
    };
    setClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClip.id);
  };

  const handleDeleteClip = () => {
    if (!selectedClipId) return;
    setClips((prev) => prev.filter((c) => c.id !== selectedClipId));
    setSelectedClipId(null);
  };

  const handleSplitClip = () => {
    if (!selectedClip) return;
    if (
      currentTime > selectedClip.startTime &&
      currentTime < selectedClip.startTime + selectedClip.duration
    ) {
      const originalDuration = selectedClip.duration;
      const firstPartDuration = currentTime - selectedClip.startTime;
      const secondPartDuration = originalDuration - firstPartDuration;

      const updatedOriginal = {
        ...selectedClip,
        duration: firstPartDuration,
      };

      const newSplitClip: TimelineClip = {
        ...selectedClip,
        id: `clip_${Date.now()}`,
        startTime: currentTime,
        duration: secondPartDuration,
        name: `${selectedClip.name} (拆分)`,
      };

      setClips((prev) =>
        prev
          .map((c) => (c.id === selectedClip.id ? updatedOriginal : c))
          .concat(newSplitClip)
      );
      setSelectedClipId(newSplitClip.id);
    }
  };

  // Export Trigger
  const handleTriggerExport = () => {
    setIsExporting(true);
    setExportProgress(10);
    const interval = setInterval(() => {
      setExportProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            setIsExporting(false);
            if (onExport) onExport(clips);
            alert('🎉 视频人工程排版与渲染合成完毕！已成功保存至素材库。');
          }, 500);
          return 100;
        }
        return prev + 18;
      });
    }, 300);
  };

  // Time Formatter 00:00:02:15
  const formatTimecode = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const frames = Math.floor((sec % 1) * 30);
    const pad = (num: number) => String(num).padStart(2, '0');
    return `00:${pad(m)}:${pad(s)}:${pad(frames)}`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 text-slate-100 flex flex-col overflow-hidden font-sans select-none">
      {/* Top Header Bar */}
      <header className="h-13 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded-lg bg-emerald-500 text-slate-950 flex items-center justify-center font-bold text-xs">
            🎬
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm text-slate-100">
              New project
            </span>
            <span className="text-xs text-slate-500 font-mono bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
              Web Video Editor v2.5
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleTriggerExport}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 transition-all shadow-md shadow-emerald-600/30"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export 导出视频</span>
          </button>

          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title="关闭全屏剪辑"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      {/* Middle Work Area (3 Columns: Left Navigation & Assets, Center Video Canvas, Right Properties) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Leftmost Vertical Icon Tabs Sidebar */}
        <nav className="w-16 bg-slate-900/90 border-r border-slate-800 flex flex-col items-center py-3 space-y-4 shrink-0">
          <button
            onClick={() => setActiveTab('assets')}
            className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center transition-colors ${
              activeTab === 'assets'
                ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Assets 素材库"
          >
            <FolderOpen className="w-4 h-4" />
            <span className="text-[9px] mt-0.5 font-medium">Assets</span>
          </button>

          <button
            onClick={() => setActiveTab('audio')}
            className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center transition-colors ${
              activeTab === 'audio'
                ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Audio BGM & 音效"
          >
            <Music className="w-4 h-4" />
            <span className="text-[9px] mt-0.5 font-medium">Audio</span>
          </button>

          <button
            onClick={() => setActiveTab('text')}
            className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center transition-colors ${
              activeTab === 'text'
                ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Text 字体 & 花字"
          >
            <Type className="w-4 h-4" />
            <span className="text-[9px] mt-0.5 font-medium">Text</span>
          </button>

          <button
            onClick={() => setActiveTab('effects')}
            className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center transition-colors ${
              activeTab === 'effects'
                ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Stickers 贴纸 & 特效"
          >
            <Smile className="w-4 h-4" />
            <span className="text-[9px] mt-0.5 font-medium">Stickers</span>
          </button>

          <button
            onClick={() => setActiveTab('captions')}
            className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center transition-colors ${
              activeTab === 'captions'
                ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Captions AI字幕"
          >
            <Subtitles className="w-4 h-4" />
            <span className="text-[9px] mt-0.5 font-medium">Captions</span>
          </button>

          <button
            onClick={() => setActiveTab('ratio')}
            className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center transition-colors ${
              activeTab === 'ratio'
                ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Canvas 比例"
          >
            <Sliders className="w-4 h-4" />
            <span className="text-[9px] mt-0.5 font-medium">Canvas</span>
          </button>
        </nav>

        {/* Left Secondary Panel Content (Assets / Text / Audio / Effects Details) */}
        <div className="w-72 bg-slate-900 border-r border-slate-800 p-4 flex flex-col shrink-0 overflow-y-auto">
          {activeTab === 'assets' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-100">Assets</h3>
                <button className="px-2.5 py-1 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-500 transition-colors flex items-center gap-1">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Import</span>
                </button>
              </div>

              {/* Drag and drop zone matching user's image */}
              <div className="border-2 border-dashed border-slate-700 hover:border-emerald-500 rounded-xl p-6 flex flex-col items-center justify-center text-center transition-colors cursor-pointer bg-slate-950/40">
                <Upload className="w-8 h-8 text-slate-500 mb-2" />
                <p className="text-xs text-slate-400 leading-relaxed font-medium">
                  Drag and drop videos, photos, and audio files here
                </p>
              </div>

              <div className="space-y-2 pt-2">
                <span className="text-xs font-bold text-slate-400">项目可用素材列表</span>
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 hover:border-emerald-500 cursor-pointer group">
                    <img
                      src={initialVideoUrl}
                      alt="mat"
                      className="w-full h-16 object-cover rounded mb-1"
                    />
                    <span className="text-[10px] text-slate-300 block truncate font-medium">
                      膏体拉丝.mp4
                    </span>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 hover:border-emerald-500 cursor-pointer group">
                    <img
                      src="https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80"
                      alt="mat"
                      className="w-full h-16 object-cover rounded mb-1"
                    />
                    <span className="text-[10px] text-slate-300 block truncate font-medium">
                      洗漱揉搓.mp4
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'text' && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-100">Text & 爆款花字</h3>

              {/* Text Presets */}
              <div className="space-y-2">
                <span className="text-xs font-bold text-slate-400 block">花字 & 标题预设 (点击添加到轨道)</span>

                <button
                  onClick={() =>
                    handleAddTextClip(
                      ' Default text',
                      '思源黑体',
                      '#ffffff',
                      'rgba(0,0,0,0.5)'
                    )
                  }
                  className="w-full p-3 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-xl text-center font-bold text-sm text-slate-200 transition-colors block"
                >
                  Default text
                </button>

                <button
                  onClick={() =>
                    handleAddTextClip(
                      '🔥 30天油皮亲妈黑头拜拜！',
                      '站酷快乐体',
                      '#facc15',
                      '#000000'
                    )
                  }
                  className="w-full p-3 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-xl text-center font-extrabold text-sm text-amber-300 transition-colors block"
                >
                  🔥 爆款黄字黑边描边
                </button>

                <button
                  onClick={() =>
                    handleAddTextClip(
                      '高奢晨间治愈·沉浸式护肤',
                      '阿里妈妈东方大楷',
                      '#ffffff',
                      'transparent'
                    )
                  }
                  className="w-full p-3 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-xl text-center font-serif text-sm text-slate-100 tracking-widest transition-colors block"
                >
                  大牌高级冷感衬线体
                </button>

                <button
                  onClick={() =>
                    handleAddTextClip(
                      '【划重点】膏体超丝滑揉搓拉丝',
                      '抖音创客体',
                      '#06b6d4',
                      '#000000'
                    )
                  }
                  className="w-full p-3 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-xl text-center font-bold text-xs text-cyan-300 transition-colors block"
                >
                  【划重点】小红书吸睛花字
                </button>
              </div>
            </div>
          )}

          {activeTab === 'audio' && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-100">Audio (BGM & 音效)</h3>

              <div className="space-y-2">
                <span className="text-xs font-bold text-emerald-400 block">🎵 免版权爆款 BGM 推荐</span>

                <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-bold text-slate-200 block">
                        高奢晨间治愈轻音乐
                      </span>
                      <span className="text-[10px] text-slate-400">85 BPM · Lofi 舒缓</span>
                    </div>
                    <button
                      onClick={() => handleAddBgmClip('高奢晨间治愈轻音乐 (Lofi 85 BPM)')}
                      className="p-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-bold text-slate-200 block">
                        抖音爆款卡点鼓点 Trap
                      </span>
                      <span className="text-[10px] text-slate-400">120 BPM · 强节奏重低音</span>
                    </div>
                    <button
                      onClick={() => handleAddBgmClip('抖音爆款卡点鼓点 (120 BPM)')}
                      className="p-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <span className="text-xs font-bold text-amber-400 block">🔊 气氛 & 动作音效 (SFX)</span>

                <button
                  onClick={() => handleAddSfxClip('咔嚓相机快门声.mp3')}
                  className="w-full p-2.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg flex items-center justify-between text-xs font-medium text-slate-300"
                >
                  <span>📷 咔嚓相机快门声</span>
                  <Plus className="w-3.5 h-3.5 text-amber-500" />
                </button>

                <button
                  onClick={() => handleAddSfxClip('水滴清脆揉搓音效.mp3')}
                  className="w-full p-2.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg flex items-center justify-between text-xs font-medium text-slate-300"
                >
                  <span>💧 水滴清脆揉搓声</span>
                  <Plus className="w-3.5 h-3.5 text-amber-500" />
                </button>

                <button
                  onClick={() => handleAddSfxClip('悬疑神转折音效.mp3')}
                  className="w-full p-2.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg flex items-center justify-between text-xs font-medium text-slate-300"
                >
                  <span>⚡ 悬疑神转折音效</span>
                  <Plus className="w-3.5 h-3.5 text-amber-500" />
                </button>
              </div>
            </div>
          )}

          {activeTab === 'effects' && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-100">Stickers & Filter 滤镜</h3>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => updateSelectedClip({ filterName: '小红书奶油风' })}
                  className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 font-bold hover:border-emerald-500"
                >
                  奶油高级风
                </button>
                <button
                  onClick={() => updateSelectedClip({ filterName: '大牌冷感胶片' })}
                  className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 font-bold hover:border-emerald-500"
                >
                  大牌冷感
                </button>
                <button
                  onClick={() => updateSelectedClip({ filterName: '通透复古DV' })}
                  className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 font-bold hover:border-emerald-500"
                >
                  通透 DV
                </button>
                <button
                  onClick={() => updateSelectedClip({ filterName: '极致通透水光' })}
                  className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 font-bold hover:border-emerald-500"
                >
                  水光特写
                </button>
              </div>
            </div>
          )}

          {activeTab === 'captions' && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-100">AI 字幕生成</h3>
              <button
                onClick={() =>
                  handleAddTextClip(
                    '【口播】30秒带你体验沉浸式晨间洗漱！',
                    '思源黑体',
                    '#ffffff',
                    '#000000'
                  )
                }
                className="w-full py-2.5 bg-emerald-600 text-white font-bold text-xs rounded-xl hover:bg-emerald-500 shadow-md shadow-emerald-600/30"
              >
                ✨ 一键自动生成与对齐字幕
              </button>
            </div>
          )}

          {activeTab === 'ratio' && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-100">Canvas 画布比例</h3>
              <div className="space-y-2">
                <button
                  onClick={() => setAspectRatio('9:16')}
                  className={`w-full p-3 rounded-xl border flex items-center justify-between text-xs font-bold ${
                    aspectRatio === '9:16'
                      ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-300'
                  }`}
                >
                  <span>9:16 (抖音 / 小红书 / Reels)</span>
                  <Check
                    className={`w-4 h-4 ${
                      aspectRatio === '9:16' ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                </button>

                <button
                  onClick={() => setAspectRatio('16:9')}
                  className={`w-full p-3 rounded-xl border flex items-center justify-between text-xs font-bold ${
                    aspectRatio === '16:9'
                      ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-300'
                  }`}
                >
                  <span>16:9 (B站 / YouTube)</span>
                  <Check
                    className={`w-4 h-4 ${
                      aspectRatio === '16:9' ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                </button>

                <button
                  onClick={() => setAspectRatio('1:1')}
                  className={`w-full p-3 rounded-xl border flex items-center justify-between text-xs font-bold ${
                    aspectRatio === '1:1'
                      ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-300'
                  }`}
                >
                  <span>1:1 (朋友圈 / Instagram)</span>
                  <Check
                    className={`w-4 h-4 ${
                      aspectRatio === '1:1' ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Center Main Video Preview Canvas */}
        <div className="flex-1 bg-slate-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
          {/* Main Video Box Frame matching screenshot */}
          <div
            className={`relative bg-black rounded-lg overflow-hidden border border-slate-800 shadow-2xl flex items-center justify-center ${
              aspectRatio === '9:16'
                ? 'h-[440px] w-[247px]'
                : aspectRatio === '16:9'
                ? 'w-[520px] h-[292px]'
                : 'w-[360px] h-[360px]'
            }`}
          >
            {/* Background Video Media Simulation */}
            <img
              src={initialVideoUrl}
              alt="Video frame"
              className="w-full h-full object-cover opacity-90"
            />

            {/* Active Text Overlay matching exact 'Default text' from uploaded image */}
            {clips
              .filter(
                (c) =>
                  c.trackId === 'text' &&
                  currentTime >= c.startTime &&
                  currentTime <= c.startTime + c.duration
              )
              .map((textClip) => (
                <div
                  key={textClip.id}
                  onClick={() => setSelectedClipId(textClip.id)}
                  style={{
                    fontFamily: textClip.fontFamily || 'sans-serif',
                    fontSize: `${textClip.fontSize || 28}px`,
                    color: textClip.textColor || '#ffffff',
                    backgroundColor: textClip.textBgColor || 'transparent',
                  }}
                  className={`absolute z-10 px-4 py-2 rounded-lg cursor-pointer transition-all ${
                    selectedClipId === textClip.id
                      ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-black'
                      : ''
                  }`}
                >
                  {textClip.textValue || textClip.name}
                </div>
              ))}
          </div>

          {/* Video Control Bar below video box matching exact layout in screenshot */}
          <div className="mt-4 flex items-center gap-6 bg-slate-900 px-4 py-2 rounded-xl border border-slate-800 text-xs font-mono">
            {/* Timecode */}
            <span className="text-slate-300 font-bold">
              {formatTimecode(currentTime)} / {formatTimecode(totalDuration)}
            </span>

            {/* Play/Pause Button */}
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="w-8 h-8 rounded-full bg-slate-800 hover:bg-emerald-600 text-slate-200 hover:text-white flex items-center justify-center transition-colors shadow-inner"
            >
              {isPlaying ? (
                <Pause className="w-4 h-4 fill-current" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </button>

            {/* Fit Dropdown */}
            <div className="relative flex items-center gap-1 bg-slate-950 px-2.5 py-1 rounded border border-slate-800 text-slate-300 cursor-pointer">
              <span>{fitMode}</span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
            </div>

            {/* Preview Fullscreen */}
            <button
              onClick={() => alert('已全屏放大画布预览')}
              className="p-1 text-slate-400 hover:text-slate-100"
              title="Fullscreen Preview"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Right Inspector / Properties Panel matching exact "It's empty here" state from screenshot */}
        <div className="w-80 bg-slate-900 border-l border-slate-800 p-5 flex flex-col justify-between shrink-0 overflow-y-auto">
          {!selectedClip ? (
            /* Exact Empty State matching screenshot */
            <div className="h-full flex flex-col items-center justify-center text-center p-6">
              <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center text-slate-500 mb-3 border border-slate-700">
                <Sliders className="w-6 h-6" />
              </div>
              <h4 className="text-sm font-bold text-slate-200 mb-1">
                It's empty here
              </h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                Click an element on the timeline to edit its properties
              </p>
            </div>
          ) : (
            /* Clip Properties Editor */
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  {selectedClip.type.toUpperCase()} 属性面板
                </span>
                <button
                  onClick={handleDeleteClip}
                  className="text-slate-500 hover:text-rose-400 p-1"
                  title="删除此片段"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {selectedClip.type === 'text' && (
                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-slate-400 block mb-1 font-medium">
                      文本内容 (Text Content)
                    </label>
                    <input
                      type="text"
                      value={selectedClip.textValue || ''}
                      onChange={(e) =>
                        updateSelectedClip({
                          textValue: e.target.value,
                          name: e.target.value,
                        })
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-slate-400 block mb-1 font-medium">
                      字体 (Font Family)
                    </label>
                    <select
                      value={selectedClip.fontFamily || '思源黑体'}
                      onChange={(e) =>
                        updateSelectedClip({ fontFamily: e.target.value })
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-100 focus:outline-none focus:border-emerald-500"
                    >
                      <option value="思源黑体">思源黑体 (Source Han Sans)</option>
                      <option value="站酷快乐体">站酷快乐体 (ZCOOL KuaiLe)</option>
                      <option value="阿里妈妈东方大楷">阿里妈妈东方大楷</option>
                      <option value="抖音创客体">抖音创客体</option>
                      <option value="Playfair Display">Playfair Display (Serif)</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-slate-400 block mb-1 font-medium">
                        字号 (Font Size)
                      </label>
                      <input
                        type="number"
                        value={selectedClip.fontSize || 28}
                        onChange={(e) =>
                          updateSelectedClip({
                            fontSize: Number(e.target.value),
                          })
                        }
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="text-slate-400 block mb-1 font-medium">
                        字体颜色
                      </label>
                      <input
                        type="color"
                        value={selectedClip.textColor || '#ffffff'}
                        onChange={(e) =>
                          updateSelectedClip({ textColor: e.target.value })
                        }
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg h-9 p-1 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              )}

              {(selectedClip.type === 'audio' ||
                selectedClip.type === 'sfx') && (
                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-slate-400 block mb-1 font-medium">
                      音量调节 (Volume: {selectedClip.volume || 100}%)
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="150"
                      value={selectedClip.volume || 100}
                      onChange={(e) =>
                        updateSelectedClip({ volume: Number(e.target.value) })
                      }
                      className="w-full accent-emerald-500"
                    />
                  </div>
                </div>
              )}

              {selectedClip.type === 'video' && (
                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-slate-400 block mb-1 font-medium">
                      滤镜风格 (Filter)
                    </label>
                    <span className="text-slate-200 font-bold block bg-slate-950 p-2 rounded border border-slate-800">
                      {selectedClip.filterName || '默认原色'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Multi-Track Timeline Editor matching exact bottom region from screenshot */}
      <div className="h-64 bg-slate-900 border-t border-slate-800 flex flex-col shrink-0">
        {/* Timeline Control Toolbar matching screenshot tools */}
        <div className="h-10 border-b border-slate-800 px-4 flex items-center justify-between text-slate-400 text-xs">
          <div className="flex items-center gap-3">
            {/* Split */}
            <button
              onClick={handleSplitClip}
              className="p-1.5 hover:bg-slate-800 hover:text-slate-100 rounded transition-colors"
              title="Split 拆分 (✂️)"
            >
              <Scissors className="w-4 h-4" />
            </button>

            {/* Delete */}
            <button
              onClick={handleDeleteClip}
              className="p-1.5 hover:bg-slate-800 hover:text-rose-400 rounded transition-colors"
              title="Delete 删除 (🗑️)"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            {/* Duplicate */}
            <button
              onClick={() => {
                if (selectedClip) {
                  const copy = {
                    ...selectedClip,
                    id: `clip_${Date.now()}`,
                    startTime: selectedClip.startTime + selectedClip.duration,
                  };
                  setClips((prev) => [...prev, copy]);
                }
              }}
              className="p-1.5 hover:bg-slate-800 hover:text-slate-100 rounded transition-colors"
              title="Duplicate 复制"
            >
              <Copy className="w-4 h-4" />
            </button>

            {/* Bookmark */}
            <button
              onClick={() => alert('已在当前时刻插入卡点标记')}
              className="p-1.5 hover:bg-slate-800 hover:text-slate-100 rounded transition-colors"
              title="Add Marker 插入标记"
            >
              <Bookmark className="w-4 h-4" />
            </button>

            <div className="h-4 w-[1px] bg-slate-800 my-auto" />

            {/* Main Scene Selector */}
            <button className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-950 border border-slate-800 rounded-lg text-[11px] font-bold text-slate-300">
              <span>Main scene</span>
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
            </button>
          </div>

          <div className="flex items-center gap-4">
            {/* Magnet */}
            <button
              onClick={() => setMagnetEnabled(!magnetEnabled)}
              className={`p-1.5 rounded transition-colors ${
                magnetEnabled ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-500'
              }`}
              title="Magnet Snapping 磁吸对齐"
            >
              <Magnet className="w-4 h-4" />
            </button>

            {/* Zoom Slider matching screenshot */}
            <div className="flex items-center gap-2">
              <ZoomOut className="w-3.5 h-3.5 text-slate-500" />
              <input
                type="range"
                min="10"
                max="100"
                value={zoomLevel}
                onChange={(e) => setZoomLevel(Number(e.target.value))}
                className="w-24 accent-emerald-500 h-1"
              />
              <ZoomIn className="w-3.5 h-3.5 text-slate-500" />
            </div>
          </div>
        </div>

        {/* Tracks Container */}
        <div className="flex-1 overflow-x-auto relative p-2 bg-slate-950/60">
          {/* Time Ruler */}
          <div className="h-6 border-b border-slate-800/80 flex items-center text-[10px] text-slate-500 font-mono pl-16 space-x-24 relative select-none">
            <span>00:00</span>
            <span>15f</span>
            <span>00:01</span>
            <span>15f</span>
            <span>00:02</span>
            <span>15f</span>
            <span>00:03</span>
            <span>15f</span>
            <span>00:04</span>
            <span>15f</span>
            <span>00:05</span>
          </div>

          {/* Draggable Playhead Cursor Bar */}
          <div
            className="absolute top-0 bottom-0 z-30 w-0.5 bg-emerald-400 pointer-events-none"
            style={{ left: `${64 + (currentTime / totalDuration) * 600}px` }}
          >
            <div className="w-3 h-3 bg-emerald-400 rounded-full -ml-1.25 -mt-1 shadow-md shadow-emerald-500/50" />
          </div>

          {/* Track 1: Text Track matching screenshot */}
          <div className="flex items-center h-10 my-1 border-b border-slate-800/40">
            <div className="w-16 flex items-center justify-center text-slate-400 border-r border-slate-800 pr-2 shrink-0">
              <Type className="w-4 h-4" />
            </div>

            <div className="flex-1 relative h-8 bg-slate-900/40 rounded overflow-hidden">
              {clips
                .filter((c) => c.trackId === 'text')
                .map((clip) => (
                  <div
                    key={clip.id}
                    onClick={() => setSelectedClipId(clip.id)}
                    style={{
                      left: `${(clip.startTime / totalDuration) * 100}%`,
                      width: `${(clip.duration / totalDuration) * 100}%`,
                    }}
                    className={`absolute top-0.5 bottom-0.5 rounded px-2 flex items-center text-xs font-bold text-white cursor-pointer border transition-all ${
                      clip.color
                    } ${
                      selectedClipId === clip.id
                        ? 'ring-2 ring-emerald-300 shadow-md'
                        : ''
                    }`}
                  >
                    <span className="truncate">{clip.name}</span>
                  </div>
                ))}
            </div>
          </div>

          {/* Track 2: Video Track matching screenshot */}
          <div className="flex items-center h-10 my-1 border-b border-slate-800/40">
            <div className="w-16 flex items-center justify-center text-slate-400 border-r border-slate-800 pr-2 shrink-0">
              <Film className="w-4 h-4" />
            </div>

            <div className="flex-1 relative h-8 bg-slate-900/40 rounded overflow-hidden">
              {clips
                .filter((c) => c.trackId === 'video')
                .map((clip) => (
                  <div
                    key={clip.id}
                    onClick={() => setSelectedClipId(clip.id)}
                    style={{
                      left: `${(clip.startTime / totalDuration) * 100}%`,
                      width: `${(clip.duration / totalDuration) * 100}%`,
                    }}
                    className={`absolute top-0.5 bottom-0.5 rounded px-2 flex items-center text-xs font-bold text-white cursor-pointer border transition-all ${
                      clip.color
                    } ${
                      selectedClipId === clip.id
                        ? 'ring-2 ring-emerald-300 shadow-md'
                        : ''
                    }`}
                  >
                    <span className="truncate">{clip.name}</span>
                  </div>
                ))}
            </div>
          </div>

          {/* Track 3: BGM Track matching screenshot */}
          <div className="flex items-center h-10 my-1 border-b border-slate-800/40">
            <div className="w-16 flex items-center justify-center text-slate-400 border-r border-slate-800 pr-2 shrink-0">
              <Music className="w-4 h-4 text-indigo-400" />
            </div>

            <div className="flex-1 relative h-8 bg-slate-900/40 rounded overflow-hidden">
              {clips
                .filter((c) => c.trackId === 'bgm')
                .map((clip) => (
                  <div
                    key={clip.id}
                    onClick={() => setSelectedClipId(clip.id)}
                    style={{
                      left: `${(clip.startTime / totalDuration) * 100}%`,
                      width: `${(clip.duration / totalDuration) * 100}%`,
                    }}
                    className={`absolute top-0.5 bottom-0.5 rounded px-2 flex items-center text-xs font-bold text-white cursor-pointer border transition-all ${
                      clip.color
                    } ${
                      selectedClipId === clip.id
                        ? 'ring-2 ring-emerald-300 shadow-md'
                        : ''
                    }`}
                  >
                    <span className="truncate">{clip.name}</span>
                  </div>
                ))}
            </div>
          </div>

          {/* Track 4: SFX Track */}
          <div className="flex items-center h-10 my-1">
            <div className="w-16 flex items-center justify-center text-slate-400 border-r border-slate-800 pr-2 shrink-0">
              <Volume2 className="w-4 h-4 text-amber-400" />
            </div>

            <div className="flex-1 relative h-8 bg-slate-900/40 rounded overflow-hidden">
              {clips
                .filter((c) => c.trackId === 'sfx')
                .map((clip) => (
                  <div
                    key={clip.id}
                    onClick={() => setSelectedClipId(clip.id)}
                    style={{
                      left: `${(clip.startTime / totalDuration) * 100}%`,
                      width: `${(clip.duration / totalDuration) * 100}%`,
                    }}
                    className={`absolute top-0.5 bottom-0.5 rounded px-2 flex items-center text-xs font-bold text-white cursor-pointer border transition-all ${
                      clip.color
                    } ${
                      selectedClipId === clip.id
                        ? 'ring-2 ring-emerald-300 shadow-md'
                        : ''
                    }`}
                  >
                    <span className="truncate">{clip.name}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>

      {/* Exporting Progress Overlay */}
      {isExporting && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 mb-4 animate-bounce">
            <Sparkles className="w-8 h-8 animate-spin" />
          </div>

          <h3 className="text-lg font-bold text-slate-100 mb-1">
            正在多轨高质感人工程排版与渲染...
          </h3>
          <p className="text-xs text-slate-400 mb-4">
            正在应用字体/BGM/音效卡点/特效滤镜...
          </p>

          <div className="w-64 bg-slate-800 h-2.5 rounded-full overflow-hidden mb-2">
            <div
              className="bg-emerald-500 h-full transition-all duration-300"
              style={{ width: `${exportProgress}%` }}
            />
          </div>

          <span className="text-xs font-mono font-bold text-emerald-400">
            {exportProgress}%
          </span>
        </div>
      )}
    </div>
  );
};

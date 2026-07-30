import React, { useState } from 'react';
import {
  ShotItem,
  VideoStructure,
  OriginalScriptAnalysis,
  AudioAnalysis,
  Step1Output,
} from '../types';
import {
  Film,
  Play,
  Volume2,
  Zap,
  Sparkles,
  Award,
  Clock,
  Music,
  CheckCircle2,
  FileText,
  ChevronRight,
  Maximize2,
  Tag,
  Flame,
  Radio,
} from 'lucide-react';

interface VideoDeconstructionViewProps {
  output: Step1Output;
  sourceVideoUrl?: string;
}

export const VideoDeconstructionView: React.FC<VideoDeconstructionViewProps> = React.memo(
  ({ output, sourceVideoUrl }) => {
    const shotList: ShotItem[] = output.shotList || [];
    const videoStructure: VideoStructure | undefined = output.videoStructure;
    const originalScript: OriginalScriptAnalysis | undefined = output.originalScript;
    const audioAnalysis: AudioAnalysis | undefined = output.audioAnalysis;

    const [selectedShotIndex, setSelectedShotIndex] = useState<number>(0);

    const activeShot = shotList.find((s) => s.shotIndex === selectedShotIndex) || shotList[0];

    // Pacing badge mapping
    const getPacingBadge = (pacing?: 'fast' | 'medium' | 'slow') => {
      switch (pacing) {
        case 'fast':
          return { label: '高频快节奏剪辑 (Fast)', color: 'bg-rose-500/20 text-rose-300 border-rose-500/40' };
        case 'slow':
          return { label: '沉浸慢速叙事 (Slow)', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' };
        default:
          return { label: '标准中速叙事 (Medium)', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
      }
    };

    const pacingBadge = getPacingBadge(videoStructure?.pacing);

    return (
      <div className="space-y-5 bg-slate-950 p-5 rounded-2xl border border-indigo-500/30 text-slate-100 shadow-2xl animate-fade-in">
        {/* Header Section with Golden Hook Badge & Key Metrics */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-slate-950 flex items-center justify-center font-black shadow-lg shadow-amber-500/20 shrink-0">
              <Award className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-base font-extrabold text-white tracking-wide">
                  视频拆解复刻分析面板
                </h4>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center gap-1">
                  <Radio className="w-3 h-3 text-indigo-400 animate-pulse" />
                  AI 智能多帧感知
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                深度拆解原视频镜头结构、黄金 Hook 节奏、口播及音轨特征
              </p>
            </div>
          </div>

          {/* Golden Hook & Pacing Badges */}
          <div className="flex items-center gap-2 flex-wrap">
            {videoStructure?.hookTiming && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-400/40 text-amber-300 text-xs font-bold shadow-xs">
                <Flame className="w-4 h-4 text-amber-400 fill-current animate-bounce" />
                <span>黄金 Hook: {videoStructure.hookTiming}</span>
              </div>
            )}

            <div className={`px-3 py-1.5 rounded-xl border text-xs font-bold ${pacingBadge.color}`}>
              <span>{pacingBadge.label}</span>
            </div>
          </div>
        </div>

        {/* 1. Overall Structure & Audio Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col">
            <span className="text-[11px] text-slate-400 font-medium flex items-center gap-1">
              <Film className="w-3.5 h-3.5 text-indigo-400" /> 镜头总数
            </span>
            <span className="text-lg font-black text-white mt-1">
              {videoStructure?.totalShots || shotList.length || 1}{' '}
              <span className="text-xs font-normal text-slate-400">个 Segment</span>
            </span>
          </div>

          <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col">
            <span className="text-[11px] text-slate-400 font-medium flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-cyan-400" /> 平均镜头时长
            </span>
            <span className="text-lg font-black text-white mt-1">
              {videoStructure?.avgShotDuration || '1.8s'}
            </span>
          </div>

          <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col">
            <span className="text-[11px] text-slate-400 font-medium flex items-center gap-1">
              <Music className="w-3.5 h-3.5 text-emerald-400" /> BGM 节奏
            </span>
            <span className="text-lg font-black text-emerald-300 mt-1 truncate">
              {audioAnalysis?.estimatedBpm ? `${audioAnalysis.estimatedBpm} BPM` : '120 BPM'}
              <span className="text-xs font-normal text-slate-400 ml-1">
                ({audioAnalysis?.musicStyle || '快节奏'})
              </span>
            </span>
          </div>

          <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col">
            <span className="text-[11px] text-slate-400 font-medium flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" /> 叙事弧线
            </span>
            <span className="text-xs font-bold text-slate-200 mt-1.5 truncate" title={videoStructure?.narrativeArc || '问题引入 → 产品展示 → 效果证明'}>
              {videoStructure?.narrativeArc || '痛点勾连 → 高光示范 → 转化促成'}
            </span>
          </div>
        </div>

        {/* 2. Horizontal Timeline Strip (Shot List) */}
        {shotList.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
                <Film className="w-4 h-4 text-indigo-400" />
                <span>镜头横向时间轴 (Timeline Strip)</span>
              </span>
              <span className="text-[11px] text-slate-400">
                点击镜头高亮预览关键帧及对应卡点
              </span>
            </div>

            {/* Horizontal Scrollable Strip */}
            <div className="flex items-center gap-3 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-slate-700">
              {shotList.map((shot, idx) => {
                const isSelected = activeShot?.shotIndex === shot.shotIndex;
                return (
                  <div
                    key={idx}
                    onClick={() => setSelectedShotIndex(shot.shotIndex)}
                    className={`shrink-0 w-44 p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between space-y-2 ${
                      isSelected
                        ? 'bg-indigo-950/80 border-indigo-400 shadow-lg shadow-indigo-500/20 ring-2 ring-indigo-500/50 scale-105'
                        : 'bg-slate-900/80 border-slate-800 hover:border-slate-700 hover:bg-slate-900'
                    }`}
                  >
                    {/* Keyframe Thumbnail / Badge */}
                    <div className="relative aspect-video rounded-lg overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center group">
                      {shot.keyframeUrl ? (
                        <img
                          src={shot.keyframeUrl}
                          alt={`Shot ${shot.shotIndex}`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center text-slate-600">
                          <Film className="w-5 h-5 mb-1" />
                          <span className="text-[10px]">Shot #{shot.shotIndex}</span>
                        </div>
                      )}
                      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-slate-950/80 text-[10px] font-mono font-bold text-amber-300">
                        {shot.startTime} - {shot.endTime}
                      </div>
                      {isSelected && (
                        <div className="absolute inset-0 bg-indigo-500/20 flex items-center justify-center">
                          <Play className="w-6 h-6 text-white fill-current drop-shadow-md" />
                        </div>
                      )}
                    </div>

                    {/* Shot Metadata */}
                    <div>
                      <div className="flex items-center justify-between text-[11px] font-bold">
                        <span className="text-slate-200 truncate">
                          #{shot.shotIndex} {shot.shotType || '景别'}
                        </span>
                        <span className="text-indigo-400 font-mono text-[10px]">
                          {shot.cameraMovement || '固定镜头'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 truncate mt-0.5">
                        {shot.description || shot.mood}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 3. Selected Shot Detail Focal Panel */}
        {activeShot && (
          <div className="p-4 rounded-xl bg-slate-900 border border-indigo-500/20 grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-4 aspect-video rounded-lg overflow-hidden bg-slate-950 border border-slate-800 relative flex items-center justify-center">
              {activeShot.keyframeUrl ? (
                <img
                  src={activeShot.keyframeUrl}
                  alt={`Selected Shot ${activeShot.shotIndex}`}
                  className="w-full h-full object-cover"
                />
              ) : sourceVideoUrl ? (
                <video
                  src={sourceVideoUrl}
                  className="w-full h-full object-cover opacity-80"
                  muted
                  controls
                />
              ) : (
                <div className="text-slate-500 text-xs flex flex-col items-center">
                  <Film className="w-6 h-6 mb-1" />
                  <span>镜头 #{activeShot.shotIndex} 画面</span>
                </div>
              )}
              <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-slate-900/90 text-amber-300 text-xs font-mono font-bold">
                时间点: {activeShot.startTime} ~ {activeShot.endTime}
              </span>
            </div>

            <div className="md:col-span-8 space-y-2 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-2 py-0.5 rounded bg-indigo-500 text-white font-bold text-xs">
                    镜头 #{activeShot.shotIndex}
                  </span>
                  <span className="text-xs font-bold text-slate-300">
                    {activeShot.shotType || '中景/特写'}
                  </span>
                  <span className="text-xs text-indigo-400 font-mono">
                    [{activeShot.cameraMovement || '运镜描述'}]
                  </span>
                  {activeShot.mood && (
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px]">
                      氛围: {activeShot.mood}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/50 p-2.5 rounded-lg border border-slate-800">
                  {activeShot.description || '当前镜头在整段复刻视频中承载核心视觉冲击。'}
                </p>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>提炼提示词卡点: {output.static_image_prompt?.slice(0, 60)}...</span>
              </div>
            </div>
          </div>
        )}

        {/* 4. Original Script & Selling Points Extraction Section */}
        {originalScript && (
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            {/* Original Spoken Audio Script */}
            <div className="md:col-span-6 p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-cyan-300 flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-cyan-400" />
                  原视频口播文案识别 (Original Script)
                </span>
                <span className="text-[10px] text-slate-400 px-2 py-0.5 rounded bg-slate-800">
                  {originalScript.hasVoiceover ? '含口播旁白' : '纯音轨/卡点'}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 max-h-32 overflow-y-auto">
                <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {originalScript.estimatedScript || '原视频口播文本已智能提取。'}
                </p>
              </div>
            </div>

            {/* Extracted Viral SellPoints */}
            <div className="md:col-span-6 p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2">
              <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                <Tag className="w-4 h-4 text-amber-400" />
                爆款 SellPoints 提炼卡点 (Key Selling Points)
              </span>

              <div className="flex flex-wrap gap-2 pt-1">
                {originalScript.sellingPoints && originalScript.sellingPoints.length > 0 ? (
                  originalScript.sellingPoints.map((pt, idx) => (
                    <div
                      key={idx}
                      className="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-400/30 text-amber-300 text-xs font-semibold flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>{pt}</span>
                    </div>
                  ))
                ) : (
                  <span className="text-xs text-slate-500">暂无提取出的核心卖点</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);

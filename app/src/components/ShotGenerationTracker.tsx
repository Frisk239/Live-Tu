import React, { useState, useEffect } from 'react';
import { MultiShotGenerationResult, MultiShotItemTask } from '../types';
import {
  Film,
  Sparkles,
  CheckCircle2,
  Clock,
  Loader2,
  AlertCircle,
  Play,
  Scissors,
  Download,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import { copyToClipboard } from '../utils/format';
import { notify } from '../services/notifications';

interface ShotGenerationTrackerProps {
  multiShotResult: MultiShotGenerationResult;
  onUpdateMultiShotResult?: (updated: MultiShotGenerationResult) => void;
  onConcatComplete?: (concatVideoUrl: string) => void;
}

export const ShotGenerationTracker: React.FC<ShotGenerationTrackerProps> = ({
  multiShotResult,
  onUpdateMultiShotResult,
  onConcatComplete,
}) => {
  const [shots, setShots] = useState<MultiShotItemTask[]>(multiShotResult.shots || []);
  const [concatenatedVideoUrl, setConcatenatedVideoUrl] = useState<string | undefined>(
    multiShotResult.concatenatedVideoUrl
  );
  const [isConcatenating, setIsConcatenating] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [pollIntervalSec, setPollIntervalSec] = useState(0);

  const sessionId = multiShotResult.sessionId;
  const totalShots = multiShotResult.totalShots || shots.length;

  const completedCount = shots.filter((s) => s.status === 'completed' || Boolean(s.video_url)).length;
  const isAllShotsCompleted = totalShots > 0 && completedCount === totalShots;

  // Poll shot generation status from server DB (/api/pipeline/shot-tasks/:sessionId)
  useEffect(() => {
    if (!sessionId || isAllShotsCompleted) return;

    let timer: NodeJS.Timeout;
    const pollStatus = async () => {
      try {
        setPollIntervalSec((prev) => prev + 3);
        const res = await fetch(`/api/pipeline/shot-tasks/${encodeURIComponent(sessionId)}`);
        const json = await res.json();
        if (json.success && json.data) {
          const updatedShots = json.data.shots as MultiShotItemTask[];
          if (updatedShots && updatedShots.length > 0) {
            setShots(updatedShots);
            if (json.data.concatenatedVideoUrl) {
              setConcatenatedVideoUrl(json.data.concatenatedVideoUrl);
              if (onConcatComplete) onConcatComplete(json.data.concatenatedVideoUrl);
            }
            if (onUpdateMultiShotResult) {
              onUpdateMultiShotResult({
                ...multiShotResult,
                shots: updatedShots,
                concatenatedVideoUrl: json.data.concatenatedVideoUrl || concatenatedVideoUrl,
                concatStatus: json.data.concatStatus || multiShotResult.concatStatus,
              });
            }
          }
        }
      } catch (err) {
        console.warn('[ShotGenerationTracker] polling error:', err);
      }
    };

    void pollStatus();
    timer = setInterval(pollStatus, 4000);
    return () => clearInterval(timer);
  }, [sessionId, isAllShotsCompleted]);

  // Trigger FFmpeg multi-shot concatenation manually
  const handleTriggerConcat = async () => {
    const videoUrls = shots.map((s) => s.video_url).filter(Boolean) as string[];
    if (videoUrls.length === 0) {
      notify('尚无已完成的镜头片段可供拼接', 'error');
      return;
    }

    setIsConcatenating(true);
    try {
      const res = await fetch('/api/pipeline/concat-shots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          videoUrls,
        }),
      });
      const json = await res.json();
      if (json.success && json.data?.concatenatedVideoUrl) {
        const concatUrl = json.data.concatenatedVideoUrl;
        setConcatenatedVideoUrl(concatUrl);
        if (onConcatComplete) onConcatComplete(concatUrl);
        if (onUpdateMultiShotResult) {
          onUpdateMultiShotResult({
            ...multiShotResult,
            concatenatedVideoUrl: concatUrl,
            concatStatus: 'completed',
          });
        }
      } else {
        notify(`多镜头 FFmpeg 拼接失败: ${json.error || '未生成有效 MP4'}`, 'error');
      }
    } catch (err: any) {
      notify(`拼接出错: ${err?.message || '网络异常'}`, 'error');
    } finally {
      setIsConcatenating(false);
    }
  };

  const handleCopyPrompt = async (promptText: string, shotIdx: number) => {
    await copyToClipboard(promptText);
    setCopiedIndex(shotIdx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="space-y-4 bg-slate-950 p-5 rounded-2xl border border-slate-800 text-slate-100 shadow-md">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-600/30 text-indigo-400 border border-indigo-500/30 flex items-center justify-center font-bold">
            <Film className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <span>多镜头分段生成 & FFmpeg 自动拼接</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono">
                {totalShots} 个独立镜头
              </span>
            </h4>
            <p className="text-[11px] text-slate-400">
              为每个镜头单独生成 Seedance 运镜与视频片段，完成后由 FFmpeg 无缝拼接
            </p>
          </div>
        </div>

        {/* Global Progress Status */}
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-3 py-1 rounded-full border font-bold flex items-center gap-1.5 ${
              concatenatedVideoUrl
                ? 'bg-emerald-950 text-emerald-300 border-emerald-700/60'
                : isAllShotsCompleted
                ? 'bg-blue-950 text-blue-300 border-blue-700/60'
                : 'bg-amber-950 text-amber-300 border-amber-700/60 animate-pulse'
            }`}
          >
            {concatenatedVideoUrl ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>拼接完成</span>
              </>
            ) : isAllShotsCompleted ? (
              <>
                <Scissors className="w-3.5 h-3.5 text-blue-400" />
                <span>所有片段已完成 · 待拼接</span>
              </>
            ) : (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
                <span>片段生成中 ({completedCount}/{totalShots})</span>
              </>
            )}
          </span>
        </div>
      </div>

      {/* Progress Stepper Display */}
      <div className="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800 space-y-2">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
          <span>多镜头流水线生成进度</span>
          <span className="font-mono text-indigo-400">
            {completedCount} / {totalShots} 片段就绪 ({Math.round((completedCount / (totalShots || 1)) * 100)}%)
          </span>
        </div>

        <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden relative">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 via-blue-500 to-emerald-500 transition-all duration-500 rounded-full"
            style={{
              width: `${Math.min(100, Math.max(5, (completedCount / (totalShots || 1)) * 100))}%`,
            }}
          />
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
          <span>
            {!isAllShotsCompleted
              ? `正在为镜头 ${completedCount + 1} 提交 Seedance 图生视频任务...`
              : concatenatedVideoUrl
              ? '全流程多镜头 AI 生成与 FFmpeg 拼接完成！'
              : '所有镜头片段生成完毕，准备通过 FFmpeg 拼接成片'}
          </span>
          {pollIntervalSec > 0 && !isAllShotsCompleted && (
            <span className="text-amber-400 font-mono flex items-center gap-1">
              <Clock className="w-3 h-3" />
              后台轮询中 ({pollIntervalSec}s)
            </span>
          )}
        </div>
      </div>

      {/* Shot Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {shots.map((shot, idx) => {
          const isShotDone = shot.status === 'completed' || Boolean(shot.video_url);
          const isShotGenerating = shot.status === 'generating';
          const isShotFailed = shot.status === 'failed';

          return (
            <div
              key={shot.id || idx}
              className={`p-3.5 rounded-xl border transition-all space-y-2.5 ${
                isShotDone
                  ? 'bg-slate-900/90 border-emerald-900/60'
                  : isShotGenerating
                  ? 'bg-slate-900/60 border-amber-800/60'
                  : isShotFailed
                  ? 'bg-rose-950/30 border-rose-900/60'
                  : 'bg-slate-900/40 border-slate-800'
              }`}
            >
              {/* Shot Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-md bg-indigo-600 text-white font-bold text-xs flex items-center justify-center">
                    {shot.shotIndex || idx + 1}
                  </span>
                  <span className="text-xs font-bold text-slate-200">
                    镜头 {shot.shotIndex || idx + 1} ({shot.shotType || '特写'})
                  </span>
                </div>

                <span
                  className={`text-[10px] px-2 py-0.5 rounded-md font-semibold border ${
                    isShotDone
                      ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                      : isShotGenerating
                      ? 'bg-amber-950 text-amber-300 border-amber-800 animate-pulse'
                      : isShotFailed
                      ? 'bg-rose-950 text-rose-300 border-rose-800'
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}
                >
                  {isShotDone
                    ? '✅ 预览就绪'
                    : isShotGenerating
                    ? '⚡ Seedance 生成中'
                    : isShotFailed
                    ? '❌ 生成失败'
                    : '⏳ 运镜指令生成中'}
                </span>
              </div>

              {/* Keyframe Thumbnail & Video Preview */}
              <div className="flex gap-3">
                {shot.keyframeUrl ? (
                  <div className="w-20 h-20 rounded-lg overflow-hidden border border-slate-800 shrink-0 bg-black">
                    <img
                      src={shot.keyframeUrl}
                      alt={`镜头 ${shot.shotIndex}`}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="w-20 h-20 rounded-lg border border-dashed border-slate-800 bg-slate-950 shrink-0 flex items-center justify-center text-[10px] text-slate-500">
                    无关键帧
                  </div>
                )}

                <div className="flex-1 min-w-0 space-y-1 text-xs">
                  <p className="text-slate-300 font-semibold truncate">
                    运镜方式: <span className="text-indigo-400">{shot.cameraMovement || '平滑推进'}</span>
                  </p>
                  <p className="text-[11px] text-slate-400 line-clamp-2">
                    {shot.description || '无具体描述'}
                  </p>
                  {shot.seedanceTaskId && (
                    <p className="text-[10px] text-slate-500 font-mono truncate">
                      Task: {shot.seedanceTaskId}
                    </p>
                  )}
                </div>
              </div>

              {/* Video Prompt Preview */}
              {shot.video_prompt && (
                <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-1">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-indigo-400 font-mono font-bold">video_prompt</span>
                    <button
                      type="button"
                      onClick={() => handleCopyPrompt(shot.video_prompt!, shot.shotIndex)}
                      className="text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      {copiedIndex === shot.shotIndex ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      <span>{copiedIndex === shot.shotIndex ? '已复制' : '复制'}</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-300 font-mono leading-tight select-all truncate">
                    {shot.video_prompt}
                  </p>
                </div>
              )}

              {/* Video Player when Shot is Completed */}
              {shot.video_url && (
                <div className="relative rounded-lg overflow-hidden border border-slate-800 bg-black aspect-video">
                  <video
                    src={shot.video_url}
                    controls
                    playsInline
                    className="w-full h-full object-contain"
                  />
                </div>
              )}

              {shot.error_message && (
                <p className="text-[11px] text-rose-300 bg-rose-950/50 p-2 rounded-md border border-rose-900">
                  ⚠️ {shot.error_message}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Concatenation Trigger Bar & Concat Player */}
      <div className="p-4 rounded-xl bg-indigo-950/40 border border-indigo-900/60 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h5 className="text-xs font-bold text-indigo-300 flex items-center gap-2">
              <Scissors className="w-4 h-4 text-indigo-400" />
              <span>FFmpeg 多片段自动拼接引擎</span>
            </h5>
            <p className="text-[11px] text-slate-400">
              使用 FFmpeg complex_filter 对所有已完成镜头进行标准比例裁切与无缝拼接
            </p>
          </div>

          <button
            type="button"
            onClick={handleTriggerConcat}
            disabled={isConcatenating || completedCount === 0}
            className={`px-4 py-2 rounded-xl text-xs font-bold shadow-md transition-all flex items-center gap-2 ${
              isConcatenating
                ? 'bg-indigo-700 text-white cursor-wait opacity-80'
                : completedCount > 0
                ? 'bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white cursor-pointer'
                : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
            }`}
          >
            {isConcatenating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-white" />
                <span>FFmpeg 拼接多片段中...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>拼接 {completedCount} 个镜头成片 ▶</span>
              </>
            )}
          </button>
        </div>

        {/* Concatenated Final Video Player */}
        {concatenatedVideoUrl && (
          <div className="pt-3 border-t border-indigo-900/60 space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-emerald-300">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>拼接完整成片预览 (Concatenated Multi-Shot Video)</span>
              </div>
              <a
                href={concatenatedVideoUrl}
                download="concatenated_multi_shot.mp4"
                className="px-2.5 py-1 rounded-lg bg-emerald-900/60 hover:bg-emerald-800 text-emerald-200 border border-emerald-700/60 text-[11px] font-semibold transition-colors flex items-center gap-1"
              >
                <Download className="w-3.5 h-3.5" />
                <span>下载 MP4</span>
              </a>
            </div>

            <div className="relative rounded-xl overflow-hidden bg-black border border-emerald-900/80 shadow-lg">
              <video
                src={concatenatedVideoUrl}
                controls
                autoPlay
                loop
                muted
                playsInline
                className="w-full aspect-video object-contain max-h-72"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

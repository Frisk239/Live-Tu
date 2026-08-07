import React, { useState } from 'react';
import { Step5Inputs, Step5Output, Step2Output, Step3Output, Step4Output, StepStatus } from '../types';
import { copyToClipboard, downloadTextFile, downloadJsonFile, generateFFmpegCommand } from '../utils/format';
import { notify } from '../services/notifications';
import {
  Film,
  Play,
  Pause,
  RotateCcw,
  Download,
  Copy,
  Check,
  Sparkles,
  ArrowLeft,
  CheckCircle2,
  Terminal,
  Layers,
  FileCode,
  Eye,
  Sliders,
  Volume2,
  RefreshCw,
  Maximize2,
  Minimize2,
  AlertCircle,
  Tag,
  Type,
  MapPin,
} from 'lucide-react';

interface Step5Readiness {
  ffmpegInstalled?: boolean | null;
  publicBaseUrl?: string | null;
}

/**
 * 发布门禁 blocker/warning 的证据解释（S1：发布页必须解释证据来源，不能只显示总分）。
 * report.blockerEvidence[code] / warningEvidence[code] 由服务端 publish-gate 生成，
 * 包含 source（哪个输入/探测产生）与 detail（可读解释）。
 */
function explainGateCode(report: any, code: string, kind: 'blocker' | 'warning'): string {
  const map = kind === 'blocker' ? report.blockerEvidence : report.warningEvidence;
  const entry = map?.[code];
  if (!entry) return `（无证据条目：${code}）`;
  return `证据来源：${entry.source} — ${entry.detail}`;
}

interface Step5CardProps {
  inputs: Step5Inputs;
  output?: Step5Output;
  step2Output?: Step2Output;
  step3Output?: Step3Output;
  step4Output?: Step4Output;
  status: StepStatus;
  onUpdateInputs: (inputs: Partial<Step5Inputs>) => void;
  onSyncFromPrevSteps?: () => void;
  onRun: () => void;
  onAbort?: () => void;
  onReset: () => void;
  onPrev: () => void;
  upstreamStale?: boolean;
  /** Optional: jump back to step 2 when video missing */
  onGoStep2?: () => void;
  readiness?: Step5Readiness;
  // --- P3：镜头质量摘要 ---
  shotQaSummary?: Array<{ shotIndex: number; verdict: string; summary: string | null }>;
  qaPassed?: number;
  qaTotal?: number;
}

export const Step5Card: React.FC<Step5CardProps> = React.memo(({
  inputs,
  output,
  step2Output,
  step3Output,
  step4Output,
  status,
  onUpdateInputs,
  onSyncFromPrevSteps,
  onRun,
  onAbort,
  onReset,
  onPrev,
  upstreamStale = false,
  onGoStep2,
  readiness,
  shotQaSummary = [],
  qaPassed = 0,
  qaTotal = 0,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [copiedFFmpeg, setCopiedFFmpeg] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [activeTab, setActiveTab] = useState<'visual' | 'timeline' | 'json'>('visual');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isArtificialEditorOpen, setIsArtificialEditorOpen] = useState(false);

  const isRunning = status === 'running';
  const isCompleted = status === 'completed' && Boolean(output);
  const isFailed = status === 'failed';
  const videoSource =
    step2Output?.previewVideoUrl ||
    (step2Output as any)?.seedanceLocalUrl ||
    '';
  const audioSource = step4Output?.bgm_recommendation?.audioSampleUrl || '';
  const blockers: string[] = [];
  if (!videoSource) {
    blockers.push('缺少 Step2 视频源（previewVideoUrl）。请完成图生视频或使用公网首帧重新跑 Step2。');
  }
  if (readiness?.ffmpegInstalled === false) {
    blockers.push('本机未检测到 FFmpeg。请安装 ffmpeg 并加入 PATH 后重启服务（Windows: winget install FFmpeg）。');
  }
  const canRun = blockers.length === 0 && !isRunning;

  // Simulated video playback timer
  React.useEffect(() => {
    let interval: any = null;
    if (isPlaying && output) {
      interval = setInterval(() => {
        setCurrentTime((prev) => {
          if (prev >= output.output.duration_sec) {
            setIsPlaying(false);
            return 0;
          }
          return Number((prev + 0.1).toFixed(1));
        });
      }, 100);
    } else {
      clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [isPlaying, output]);

  const handleCopyFFmpeg = async () => {
    if (output) {
      const cmd = generateFFmpegCommand(output.timeline, output.output.filename);
      await copyToClipboard(cmd);
      setCopiedFFmpeg(true);
      setTimeout(() => setCopiedFFmpeg(false), 2000);
    }
  };

  const handleDownloadMarkdown = () => {
    if (!output) return;
    const brandText = output.timeline.find((t) => t.action === 'brand_stamp')?.text || 'AIGC 短视频';
    const md = `# ${brandText} 短视频合成 Brief\n\n- 文件名: ${output.output.filename}\n- 分辨率: ${output.output.resolution}\n- 时长: ${output.output.duration_sec}s\n\n## 时间轴配置\n${output.timeline
      .map((t) => `- [${t.at}] ${t.action}: ${t.text || t.source}`)
      .join('\n')}\n\n## 质检清单\n${output.qa_checklist.join('\n')}\n`;
    const safeName = output.output.filename.replace(/\.mp4$/i, '');
    downloadTextFile(md, `${safeName}_brief.md`);
  };

  const handleCopyJson = async () => {
    if (output) {
      await copyToClipboard(JSON.stringify(output, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  };

  const handleRealDownload = () => {
    const targetUrl = output?.output?.downloadUrl || output?.output?.videoUrl;
    if (targetUrl) {
      const link = document.createElement('a');
      link.href = targetUrl;
      link.download = output?.output?.filename || 'AIGC_Video_Result.mp4';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      notify('成片视频尚未导出完成，请点击【运行一键视频合成】生成 MP4 文件后再下载。', 'error');
    }
  };

  // Find active subtitle at current time
  const currentSubtitle = output?.timeline.find((item) => {
    if (item.action !== 'subtitle_in') return false;
    const timeNum = parseFloat(item.at);
    return currentTime >= timeNum && currentTime < timeNum + 1.5;
  })?.text;

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-white dark:bg-slate-900 overflow-y-auto p-6 md:p-8 flex flex-col shadow-2xl transition-all'
          : 'bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl shadow-surface-md overflow-hidden transition-all'
      }
    >
      {/* Header */}
      <div className="px-6 py-4 bg-slate-50/80 dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white font-bold flex items-center justify-center shadow-surface-sm">
            5
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              第 5 步：视频 + 文案 + BGM → 合成输出成品
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              全流水线产物聚合 + 时间轴控制 + FFmpeg 自动渲染并导出成品短视频
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">

          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-surface-sm ${
              isFullscreen
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
            }`}
            title={isFullscreen ? '退出全屏沉浸模式' : '进入全屏沉浸模式操作'}
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" />
                <span>退出全屏</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>全屏沉浸</span>
              </>
            )}
          </button>
          <button
            onClick={onPrev}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shadow-surface-sm"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>上一步</span>
          </button>

          <button
            onClick={onReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 bg-white border border-slate-200 hover:bg-slate-100 transition-colors shadow-sm"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>重置</span>
          </button>

          {isCompleted && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleCopyFFmpeg}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 transition-colors shadow-sm"
              >
                <Terminal className="w-3.5 h-3.5 text-emerald-600" />
                <span>{copiedFFmpeg ? '已复制 FFmpeg 命令' : 'FFmpeg 命令'}</span>
              </button>

              <button
                onClick={handleDownloadMarkdown}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 transition-colors shadow-sm"
              >
                <Download className="w-3.5 h-3.5 text-emerald-600" />
                <span>下载 Brief</span>
              </button>
            </div>
          )}

          {isRunning ? (
            <div className="flex items-center gap-1.5">
              <button
                disabled
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold text-white bg-emerald-600/80 cursor-wait shadow-md"
              >
                <Sparkles className="w-3.5 h-3.5 animate-spin" />
                <span>合成渲染中...</span>
              </button>
              {onAbort && (
                <button
                  onClick={onAbort}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 transition-all shadow-md cursor-pointer"
                  title="中断并终止当前合成渲染阶段"
                >
                  <span>终止阶段</span>
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={onRun}
              disabled={!canRun}
              title={blockers[0] || '开始服务端 FFmpeg 合成'}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all shadow-md shadow-emerald-600/20"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>运行合成</span>
            </button>
          )}
        </div>
      </div>

      {(blockers.length > 0 || isFailed) && (
        <div className="mx-6 mt-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs space-y-2">
          <p className="font-bold flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4" />
            {isFailed ? '上一次合成失败' : '合成前置条件未满足'}
          </p>
          <ul className="list-disc list-inside space-y-1 text-rose-800/90">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
            {isFailed && !blockers.length && <li>请查看服务端日志或补齐视频/音频源后重试</li>}
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            {onGoStep2 && !videoSource && (
              <button
                type="button"
                onClick={onGoStep2}
                className="px-3 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-800 font-bold hover:bg-rose-100"
              >
                返回 Step2 生成视频
              </button>
            )}
            {videoSource && (
              <span className="text-[11px] text-emerald-700 font-mono truncate max-w-full">
                视频源: {videoSource}
              </span>
            )}
            {audioSource && (
              <span className="text-[11px] text-slate-600 font-mono truncate max-w-full">
                BGM: {audioSource}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Inputs Column */}
        <div className="lg:col-span-5 space-y-4 border-r border-slate-200/80 pr-0 lg:pr-6">
          <div className="text-xs font-bold text-emerald-700 uppercase tracking-wider flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Sliders className="w-4 h-4" />
              <span>1. 聚合全链路产物与合成设置</span>
            </div>
          </div>

          {/* Context Inheritance Banner */}
          <div
            className={`p-3 rounded-xl space-y-2 text-xs ${
              upstreamStale
                ? 'bg-amber-50 border border-amber-300'
                : 'bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/60'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full animate-pulse ${
                    upstreamStale ? 'bg-amber-500' : 'bg-emerald-500'
                  }`}
                />
                <span
                  className={`font-bold ${
                    upstreamStale ? 'text-amber-900' : 'text-emerald-800 dark:text-emerald-300'
                  }`}
                >
                  {upstreamStale
                    ? '上游步骤已更新，成片配置仍保留 — 请确认同步后重跑合成'
                    : '🔗 自动化继承上下文 (Step 1 → Step 4)'}
                </span>
              </div>
              {onSyncFromPrevSteps && (
                <button
                  onClick={onSyncFromPrevSteps}
                  className={`px-2 py-1 bg-white dark:bg-slate-800 rounded-lg text-[11px] font-bold transition-colors flex items-center gap-1 shadow-sm ${
                    upstreamStale
                      ? 'border border-amber-300 text-amber-800 hover:bg-amber-50'
                      : 'border border-emerald-300 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-slate-700'
                  }`}
                  title="一键更新全链路上下文引用"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>全链路同步</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 gap-1 text-[11px] text-slate-600 dark:text-slate-300">
              <div className="flex items-center justify-between px-2 py-1 rounded bg-white/80 dark:bg-slate-800/80 border border-emerald-100 dark:border-emerald-900/50">
                <span className="text-slate-500">Step 2 运镜:</span>
                <span className="font-mono font-medium text-emerald-700 dark:text-emerald-400 truncate max-w-[180px]">
                  {step2Output?.motion_type || '已接入视频运镜描述'}
                </span>
              </div>
              <div className="flex items-center justify-between px-2 py-1 rounded bg-white/80 dark:bg-slate-800/80 border border-emerald-100 dark:border-emerald-900/50">
                <span className="text-slate-500">Step 3 标题:</span>
                <span className="font-medium text-emerald-700 dark:text-emerald-400 truncate max-w-[180px]">
                  {step3Output?.title || '已接入爆款脚本标题'}
                </span>
              </div>
              <div className="flex items-center justify-between px-2 py-1 rounded bg-white/80 dark:bg-slate-800/80 border border-emerald-100 dark:border-emerald-900/50">
                <span className="text-slate-500">Step 4 配乐:</span>
                <span className="font-medium text-emerald-700 dark:text-emerald-400 truncate max-w-[180px]">
                  {step4Output?.bgm_recommendation?.track_name || '已接入推荐 BGM'}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1">
                画面比例 (Aspect Ratio)
              </label>
              <select
                value={inputs.aspectRatio}
                onChange={(e) => onUpdateInputs({ aspectRatio: e.target.value as any })}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 font-medium shadow-sm"
              >
                <option value="9:16">9:16（抖音/小红书短视频）</option>
                <option value="3:4">3:4（小红书经典比例）</option>
                <option value="1:1">1:1（朋友圈/短视频）</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                字幕视觉样式
              </label>
              <select
                value={inputs.subtitleStyle}
                onChange={(e) => onUpdateInputs({ subtitleStyle: e.target.value as any })}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 font-medium shadow-sm"
              >
                <option value="黄字黑边">黄字黑边（经典抖音爆款）</option>
                <option value="白字柔影">白字柔影（大牌低调）</option>
                <option value="极简小绿红书体">极简小绿（BUV绿色）</option>
                <option value="极速黑卡">极速黑卡（测评醒目）</option>
              </select>
            </div>
          </div>

          {/* 🎬 镜头微调：字幕位置与品牌 Stamp 配置 */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-emerald-600" />
                <span>字幕与品牌 Stamp 细节微调</span>
              </span>
              <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-mono font-semibold">
                成片渲染前控制
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1 flex items-center gap-1">
                  <Type className="w-3 h-3 text-slate-500" />
                  <span>字幕垂直放置位置</span>
                </label>
                <select
                  value={inputs.subtitlePosition || 'bottom'}
                  onChange={(e) => onUpdateInputs({ subtitlePosition: e.target.value as any })}
                  className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500 font-medium shadow-sm"
                >
                  <option value="bottom">底部（标准居中）</option>
                  <option value="center">中间（醒目突出）</option>
                  <option value="top">顶部（避让安全区）</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1 flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-slate-500" />
                  <span>品牌 Stamp 位置</span>
                </label>
                <select
                  value={inputs.brandStampPosition || 'top-right'}
                  onChange={(e) => onUpdateInputs({ brandStampPosition: e.target.value as any })}
                  className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500 font-medium shadow-sm"
                >
                  <option value="top-right">右上角 (Top Right)</option>
                  <option value="top-left">左上角 (Top Left)</option>
                  <option value="bottom-right">右下角 (Bottom Right)</option>
                  <option value="bottom-left">左下角 (Bottom Left)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1 flex items-center gap-1">
                <Tag className="w-3 h-3 text-slate-500" />
                <span>品牌 Stamp 水印文字</span>
              </label>
              <input
                type="text"
                value={inputs.brandStampText ?? 'BUV 笔薇'}
                onChange={(e) => onUpdateInputs({ brandStampText: e.target.value })}
                placeholder="例如: BUV 笔薇 / AIGC 独家小剪辑"
                className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-500 font-medium shadow-sm"
              />
            </div>
          </div>

          {/* Aggregated Sources Summary */}
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
            <span className="text-emerald-800 font-bold block">上游流水线产物就绪状态：</span>
            <div className="space-y-1.5 text-slate-700">
              <div className="flex items-center justify-between text-[11px]">
                <span>第2步视频运镜：</span>
                <span className={`font-bold font-mono ${step2Output ? 'text-emerald-700' : 'text-slate-400'}`}>
                  {step2Output ? `✓ ${step2Output.motion_description || step2Output.duration_sec + 's 运镜'}` : '⏳ 待注入'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span>第3步爆款文案：</span>
                <span className={`font-bold font-mono ${step3Output ? 'text-emerald-700' : 'text-slate-400'}`}>
                  {step3Output ? `✓ 标题：${step3Output.title}` : '⏳ 待注入'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span>第4步商用BGM：</span>
                <span className={`font-bold font-mono ${step4Output ? 'text-emerald-700' : 'text-slate-400'}`}>
                  {step4Output ? `✓ ${step4Output.bgm_recommendation.track_name} (${step4Output.bgm_recommendation.bpm} BPM)` : '⏳ 待注入'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Output Column (Immersive Dark Focus Canvas) */}
        <div className="lg:col-span-7 flex flex-col justify-between bg-slate-950 p-5 rounded-2xl border border-slate-800 shadow-inner">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-4 h-4" />
                <span>2. 成品预览 & 时间轴 Canvas</span>
              </div>

              {isCompleted && (
                <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                  <button
                    onClick={() => setActiveTab('visual')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      activeTab === 'visual'
                        ? 'bg-emerald-400 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Eye className="w-3 h-3 inline mr-1" />
                    成片模拟器
                  </button>
                  <button
                    onClick={() => setActiveTab('timeline')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      activeTab === 'timeline'
                        ? 'bg-emerald-400 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Layers className="w-3 h-3 inline mr-1" />
                    时间轴 Timeline
                  </button>
                  <button
                    onClick={() => setActiveTab('json')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      activeTab === 'json'
                        ? 'bg-emerald-400 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <FileCode className="w-3 h-3 inline mr-1" />
                    JSON
                  </button>
                </div>
              )}
            </div>

            {/* Output Display Area */}
            {!output ? (
              <div className="h-72 rounded-xl border border-dashed border-slate-800 bg-slate-900/50 flex flex-col items-center justify-center p-6 text-center">
                <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mb-3 text-slate-500">
                  <Film className="w-6 h-6" />
                </div>
                <p className="text-xs text-slate-300 font-medium">
                  点击【运行 ▶】生成成片合成时间轴与 FFmpeg 渲染指令
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  （系统将合成视频轨、音轨、字幕浮层、品牌Logo角标与QA质检表）
                </p>
              </div>
            ) : activeTab === 'visual' ? (
              <div className="space-y-4 animate-fade-in">
                {/* Real Rendered Video Player Frame */}
                <div className="relative mx-auto w-full max-w-sm rounded-2xl bg-slate-950 border border-emerald-500/30 overflow-hidden shadow-2xl flex flex-col justify-center items-center p-3">
                  {/* Brand Stamp Preview Overlay */}
                  {inputs.brandStampText && (
                    <div
                      className={`absolute z-20 px-2 py-1 bg-slate-950/80 border border-emerald-400/60 text-emerald-300 text-[11px] font-bold rounded-lg backdrop-blur-md shadow-lg flex items-center gap-1 transition-all ${
                        inputs.brandStampPosition === 'top-left'
                          ? 'top-5 left-5'
                          : inputs.brandStampPosition === 'bottom-left'
                          ? 'bottom-12 left-5'
                          : inputs.brandStampPosition === 'bottom-right'
                          ? 'bottom-12 right-5'
                          : 'top-5 right-5'
                      }`}
                    >
                      <Tag className="w-3 h-3 text-emerald-400" />
                      <span>{inputs.brandStampText}</span>
                    </div>
                  )}

                  {/* Subtitle Live Overlay Preview */}
                  <div
                    className={`absolute z-20 w-4/5 text-center transition-all pointer-events-none ${
                      inputs.subtitlePosition === 'top'
                        ? 'top-10'
                        : inputs.subtitlePosition === 'center'
                        ? 'top-1/2 -translate-y-1/2'
                        : 'bottom-12'
                    }`}
                  >
                    <span
                      className={`px-3 py-1 rounded text-xs font-black shadow-xl inline-block ${
                        inputs.subtitleStyle === '黄字黑边'
                          ? 'bg-yellow-400 text-black border border-black font-extrabold'
                          : inputs.subtitleStyle === '白字柔影'
                          ? 'bg-white/90 text-slate-900 shadow-md font-bold'
                          : inputs.subtitleStyle === '极简小绿红书体'
                          ? 'bg-emerald-600 text-white font-bold'
                          : 'bg-slate-950 text-emerald-400 border border-emerald-500 font-mono'
                      }`}
                    >
                      {currentSubtitle || step3Output?.title || '【字幕预览】精简有效的高光短视频'}
                    </span>
                  </div>

                  {output.output?.videoUrl ? (
                    <div className="w-full flex flex-col items-center">
                      <video
                        src={output.output.videoUrl}
                        className="w-full h-auto max-h-[380px] rounded-xl object-contain shadow-lg"
                        controls
                        autoPlay
                        loop
                        playsInline
                        poster={step2Output?.previewVideoUrl}
                      />
                      <div className="mt-2 w-full flex items-center justify-between px-1 text-[11px] text-slate-400 font-mono">
                        <span className="text-emerald-400 font-bold">✓ FFmpeg 渲染输出成品</span>
                        <span>{output.output.resolution} | {output.output.duration_sec}s</span>
                      </div>
                    </div>
                  ) : step2Output?.previewVideoUrl ? (
                    <div className="w-full flex flex-col items-center">
                      <video
                        src={step2Output.previewVideoUrl}
                        className="w-full h-auto max-h-[380px] rounded-xl object-contain opacity-80"
                        controls
                        playsInline
                      />
                      <span className="mt-2 text-[11px] text-amber-400 font-mono">
                        Step2 视频预览源（等待合成渲染）
                      </span>
                    </div>
                  ) : (
                    <div className="w-full h-64 flex flex-col items-center justify-center text-slate-400 text-xs">
                      <Film className="w-8 h-8 mb-2 text-slate-600" />
                      <span>暂无可播放视频源</span>
                    </div>
                  )}
                </div>

                {/* QA Checklist */}
                <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800">
                  <span className="text-xs font-bold text-slate-300 block mb-2">成片 AI 质检清单 (QA Checklist)</span>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {output.qa_checklist.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-1.5 text-emerald-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Publish Gate Report */}
                {(output as any).publishReport && (
                  <div className="p-3.5 rounded-xl bg-slate-900 border border-violet-800/60">
                    <span className="text-xs font-bold text-violet-300 block mb-2">
                      Publish Gate 发布门禁报告
                    </span>
                    <div className="grid grid-cols-4 gap-2 mb-2">
                      {[
                        ['产品身份', (output as any).publishReport.scores?.productIdentity],
                        ['结构覆盖', (output as any).publishReport.scores?.structureCoverage],
                        ['技术质量', (output as any).publishReport.scores?.technical],
                        ['合规', (output as any).publishReport.scores?.compliance],
                      ].map(([label, score]) => (
                        <div key={String(label)} className="rounded-lg bg-slate-800/70 p-2 text-center">
                          <div className="text-[10px] text-slate-400">{label}</div>
                          <div className="text-sm font-black text-emerald-400">
                            {Math.round(Number(score || 0) * 100)}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="text-[11px] text-slate-300 mb-1">
                      状态：
                      {(output as any).publishReport.status === 'passed'
                        ? '✅ 已通过'
                        : (output as any).publishReport.status === 'needs_review'
                          ? '🟡 待审核（成片已生成，未达发布标准）'
                          : (output as any).publishReport.status === 'unverified'
                            ? '🔵 未验证（无法确认，不计为通过）'
                            : '❌ 未通过'}
                    </div>
                    {(output as any).publishReport.blockers?.length > 0 && (
                      <div className="flex flex-col gap-1 mb-1">
                        {(output as any).publishReport.blockers.map((b: string) => (
                          <div key={b} className="text-[10px] text-rose-300 px-1.5 py-1 rounded bg-rose-500/15">
                            ✗ <b>{b}</b>
                            <span className="block text-rose-300/80 mt-0.5">
                              {explainGateCode((output as any).publishReport, b, 'blocker')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {(output as any).publishReport.warnings?.length > 0 && (
                      <div className="flex flex-col gap-1">
                        {(output as any).publishReport.warnings.map((w: string) => (
                          <div key={w} className="text-[10px] text-amber-300 px-1.5 py-1 rounded bg-amber-500/10">
                            ○ <b>{w}</b>
                            <span className="block text-amber-300/80 mt-0.5">
                              {explainGateCode((output as any).publishReport, w, 'warning')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 text-[10px] text-slate-500">
                      评分卡版本 {(output as any).publishReport.scorerVersion || 'unknown'} · 证据随每项展示
                    </div>
                  </div>
                )}

                {/* P3：镜头质量摘要（语义 QA 逐镜判决） */}
                {shotQaSummary && shotQaSummary.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-slate-900 border border-emerald-800/60" data-testid="shot-qa-summary">
                    <span className="text-xs font-bold text-emerald-300 block mb-2">
                      镜头质量摘要（{qaPassed}/{qaTotal} 通过）
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                      {shotQaSummary.map((s) => (
                        <div
                          key={s.shotIndex}
                          className={`rounded-lg px-2 py-1.5 text-[11px] border ${
                            s.verdict === 'pass'
                              ? 'bg-emerald-500/10 border-emerald-700/40 text-emerald-300'
                              : s.verdict === 'fail'
                                ? 'bg-rose-500/10 border-rose-700/40 text-rose-300'
                                : s.verdict === 'warning'
                                  ? 'bg-amber-500/10 border-amber-700/40 text-amber-300'
                                  : 'bg-slate-800/70 border-slate-700 text-slate-400'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <b>#{s.shotIndex}</b>
                            <span>
                              {s.verdict === 'pass' ? '✅' : s.verdict === 'fail' ? '❌' : s.verdict === 'warning' ? '🟡' : '🔵'}
                            </span>
                          </div>
                          {s.summary && <div className="text-[10px] opacity-80 mt-0.5 truncate">{s.summary}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : activeTab === 'timeline' ? (
              /* Timeline Table View */
              <div className="space-y-3 animate-fade-in">
                <span className="text-xs font-bold text-slate-300 block">合成时间轴轨道 (Timeline Tracks)</span>
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {output.timeline.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono text-[11px] font-bold">
                          {item.at}
                        </span>
                        <span className="font-bold text-slate-200 uppercase font-mono">{item.action}</span>
                      </div>
                      <span className="text-slate-400 text-[11px] truncate max-w-xs">
                        {item.text || item.source}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* JSON View */
              <div className="relative group animate-fade-in">
                <button
                  onClick={handleCopyJson}
                  className="absolute top-3 right-3 z-10 flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 text-slate-300 text-xs hover:bg-slate-700 transition-colors"
                >
                  {copiedJson ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedJson ? '已复制 JSON' : '复制 JSON'}</span>
                </button>

                <pre className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-emerald-400 font-mono overflow-x-auto max-h-96 leading-relaxed">
                  {JSON.stringify(output, null, 2)}
                </pre>
              </div>
            )}
          </div>

          {/* Complete Status Banner */}
          {isCompleted && (
            <div className="mt-4 pt-3 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
              <span className="text-emerald-400 font-bold font-mono">
                🎉 5步反推流水线已全线贯通！同款爆款视频生产指令已就绪。
              </span>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleRealDownload}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md transition-all flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>下载最终视频</span>
                </button>

                <button
                  onClick={() => {
                    downloadJsonFile(output, 'AIGC_Pipeline_Bundle.json');
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-all flex items-center gap-1.5"
                >
                  <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                  <span>导出工程包</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

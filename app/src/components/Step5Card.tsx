import React, { useState } from 'react';
import { Step5Inputs, Step5Output, Step2Output, Step3Output, Step4Output, StepStatus } from '../types';
import { copyToClipboard, downloadTextFile, downloadJsonFile, generateFFmpegCommand } from '../utils/format';
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
  Scissors,
} from 'lucide-react';
import { ArtificialVideoEditor } from './ArtificialVideoEditor';

interface Step5CardProps {
  inputs: Step5Inputs;
  output?: Step5Output;
  step2Output?: Step2Output;
  step3Output?: Step3Output;
  step4Output?: Step4Output;
  status: StepStatus;
  useMockMode: boolean;
  onUpdateInputs: (inputs: Partial<Step5Inputs>) => void;
  onSyncFromPrevSteps?: () => void;
  onRun: () => void;
  onReset: () => void;
  onPrev: () => void;
}

export const Step5Card: React.FC<Step5CardProps> = ({
  inputs,
  output,
  step2Output,
  step3Output,
  step4Output,
  status,
  useMockMode,
  onUpdateInputs,
  onSyncFromPrevSteps,
  onRun,
  onReset,
  onPrev,
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
    const md = `# BUV 小绿泥短视频合成 Brief\n\n- 文件名: ${output.output.filename}\n- 分辨率: ${output.output.resolution}\n- 时长: ${output.output.duration_sec}s\n\n## 时间轴配置\n${output.timeline
      .map((t) => `- [${t.at}] ${t.action}: ${t.text || t.source}`)
      .join('\n')}\n\n## 质检清单\n${output.qa_checklist.join('\n')}\n`;
    downloadTextFile(md, 'buv_video_brief.md');
  };

  const handleCopyJson = async () => {
    if (output) {
      await copyToClipboard(JSON.stringify(output, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
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
      {/* Artificial Video Editor Fullscreen Overlay */}
      {isArtificialEditorOpen && (
        <ArtificialVideoEditor
          initialTitle={inputs.copywritingTitle || '高奢小绿泥晨间洗漱视频成片'}
          initialBgmTrack={inputs.bgmName || 'Chill Lofi Beats'}
          onClose={() => setIsArtificialEditorOpen(false)}
        />
      )}

      {/* Header */}
      <div className="px-6 py-4 bg-slate-50/80 dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white font-bold flex items-center justify-center shadow-surface-sm">
            5
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              第 5 步：视频 + 文案 + BGM → 合成输出成品 & 二次精细剪辑
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              全流水线产物聚合 + 时间轴控制 + FFmpeg 渲染指令 + 支持人工二次微调剪辑
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Artificial Video Editor Launch Button */}
          <button
            onClick={() => setIsArtificialEditorOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 transition-all shadow-md shadow-indigo-500/20"
            title="打开人工剪辑工作台 (字体、BGM、音效等)"
          >
            <Scissors className="w-3.5 h-3.5" />
            <span>人工二次剪辑</span>
          </button>

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

          <button
            onClick={onRun}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-all shadow-md shadow-emerald-600/20"
          >
            {isRunning ? (
              <>
                <Sparkles className="w-3.5 h-3.5 animate-spin" />
                <span>合成渲染中...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>运行 </span>
              </>
            )}
          </button>
        </div>
      </div>

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
          <div className="p-3 bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/60 rounded-xl space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-bold text-emerald-800 dark:text-emerald-300">
                  🔗 自动化继承上下文 (Step 1 → Step 4)
                </span>
              </div>
              {onSyncFromPrevSteps && (
                <button
                  onClick={onSyncFromPrevSteps}
                  className="px-2 py-1 bg-white dark:bg-slate-800 border border-emerald-300 text-emerald-700 dark:text-emerald-300 rounded-lg text-[11px] font-bold hover:bg-emerald-100 dark:hover:bg-slate-700 transition-colors flex items-center gap-1 shadow-sm"
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

          {/* Aggregated Sources Summary */}
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
            <span className="text-emerald-800 font-bold block">上游流水线产物就绪状态：</span>
            <div className="space-y-1.5 text-slate-700">
              <div className="flex items-center justify-between text-[11px]">
                <span>第2步视频运镜：</span>
                <span className="text-emerald-700 font-bold font-mono">✓ 4s 动态运镜已注入</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span>第3步爆款文案：</span>
                <span className="text-emerald-700 font-bold font-mono">✓ 含 SGS 8h控油数据</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span>第4步商用BGM：</span>
                <span className="text-emerald-700 font-bold font-mono">✓ Mint Breeze 82BPM</span>
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
                {/* Interactive Player Frame */}
                <div className="relative mx-auto w-full max-w-sm h-80 rounded-2xl bg-slate-950 border border-emerald-500/30 overflow-hidden shadow-2xl flex flex-col justify-between p-4">
                  {/* Background Video Simulation */}
                  <div className="absolute inset-0 z-0 bg-gradient-to-b from-slate-900/60 via-slate-950/80 to-slate-950 flex items-center justify-center">
                    <img
                      src="https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80"
                      alt="video frame"
                      className={`w-full h-full object-cover opacity-60 transition-transform duration-1000 ${
                        isPlaying ? 'scale-110' : 'scale-100'
                      }`}
                    />
                  </div>

                  {/* Top Brand Watermark Stamp */}
                  <div className="relative z-10 flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500 text-slate-950 shadow-md">
                      BUV 小绿泥
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-900/80 text-emerald-300 border border-emerald-500/30 backdrop-blur-sm">
                      沙利文国货控油洁面销量第一
                    </span>
                  </div>

                  {/* Subtitle Overlay */}
                  <div className="relative z-10 text-center my-auto px-4">
                    {currentSubtitle ? (
                      <span className="inline-block px-3 py-1.5 rounded bg-amber-400 text-slate-950 font-extrabold text-sm shadow-xl">
                        {currentSubtitle}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400/80 font-mono italic">
                        [音画卡点播放中...]
                      </span>
                    )}
                  </div>

                  {/* Bottom Controls Bar */}
                  <div className="relative z-10 bg-slate-900/90 backdrop-blur-md p-2.5 rounded-xl border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setIsPlaying(!isPlaying)}
                          className="w-7 h-7 rounded-full bg-emerald-400 hover:bg-emerald-300 text-slate-950 flex items-center justify-center transition-colors"
                        >
                          {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
                        </button>
                        <span className="font-mono text-slate-300 text-[11px]">
                          {currentTime}s / {output.output.duration_sec}s
                        </span>
                      </div>

                      <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono">
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>BGM 0.3</span>
                      </div>
                    </div>

                    {/* Progress Slider */}
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-emerald-400 h-full transition-all duration-100"
                        style={{
                          width: `${(currentTime / output.output.duration_sec) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
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
                  onClick={() => {
                    const blob = new Blob(['AIGC Synthetic Video Stream Data'], { type: 'video/mp4' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = output?.output.filename || 'AIGC_Video_Result.mp4';
                    a.click();
                  }}
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
};

import React, { useState } from 'react';
import { Step4Inputs, Step4Output, Step3Output, StepStatus } from '../types';
import { copyToClipboard, downloadJsonFile } from '../utils/format';
import {
  Music,
  Play,
  Pause,
  RotateCcw,
  Download,
  Copy,
  Check,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Disc,
  ShieldAlert,
  Radio,
  FileCode,
  Eye,
  RefreshCw,
  Maximize2,
  Minimize2,
  Scissors,
  Film,
  Type,
  Volume2,
} from 'lucide-react';
import { ArtificialVideoEditor } from './ArtificialVideoEditor';

interface Step4CardProps {
  inputs: Step4Inputs;
  output?: Step4Output;
  step3Output?: Step3Output;
  status: StepStatus;
  useMockMode: boolean;
  onUpdateInputs: (inputs: Partial<Step4Inputs>) => void;
  onSyncFromStep3?: () => void;
  onRun: () => void;
  onReset: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export const Step4Card: React.FC<Step4CardProps> = ({
  inputs,
  output,
  step3Output,
  status,
  useMockMode,
  onUpdateInputs,
  onSyncFromStep3,
  onRun,
  onReset,
  onPrev,
  onNext,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [activeTab, setActiveTab] = useState<'visual' | 'json'>('visual');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isArtificialEditorOpen, setIsArtificialEditorOpen] = useState(false);

  const isRunning = status === 'running';
  const isCompleted = status === 'completed' && Boolean(output);

  const handleCopyJson = async () => {
    if (output) {
      await copyToClipboard(JSON.stringify(output, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  };

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
          initialTitle={inputs.copywritingTitle || '高奢小绿泥晨间洗漱'}
          initialBgmTrack={output?.bgm_recommendation?.track_name || 'Chill Lofi Beats - Morning Routine'}
          onClose={() => setIsArtificialEditorOpen(false)}
        />
      )}

      {/* Header */}
      <div className="px-6 py-4 bg-slate-50/80 dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white font-bold flex items-center justify-center shadow-surface-sm">
            4
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              第 4 步：文案 + 视频 → 匹配 BGM 音轨 & 人工精细剪辑
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              情绪匹配 + BPM 节奏卡点点位推荐 + 支持人工多轨道剪辑（字体、BGM、音效、字幕等）
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
            <span>人工剪辑工作台</span>
          </button>

          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-surface-sm ${
              isFullscreen
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
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
                <Maximize2 className="w-3.5 h-3.5 text-indigo-600" />
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
            <button
              onClick={() => downloadJsonFile(output, 'step4_bgm_recommendation.json')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 transition-colors shadow-sm"
            >
              <Download className="w-3.5 h-3.5 text-indigo-600" />
              <span>下载 BGM 建议</span>
            </button>
          )}

          <button
            onClick={onRun}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-all shadow-md shadow-indigo-600/20"
          >
            {isRunning ? (
              <>
                <Sparkles className="w-3.5 h-3.5 animate-spin" />
                <span>BGM 匹配中...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>运行 </span>
              </>
            )}
          </button>

          <button
            onClick={onNext}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 transition-colors shadow-sm"
          >
            <span>下一步</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Inputs Column */}
        <div className="lg:col-span-5 space-y-4 border-r border-slate-200/80 pr-0 lg:pr-6">
          <div className="text-xs font-bold text-indigo-700 uppercase tracking-wider flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Music className="w-4 h-4" />
              <span>1. 继承文案标题与音律偏好</span>
            </div>
          </div>

          {/* Context Inheritance Banner */}
          <div className="p-2.5 bg-indigo-50/80 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-800/60 rounded-xl flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
              <span className="font-semibold text-indigo-800 dark:text-indigo-300">
                🔗 已自动引用 Step 3 爆款标题
              </span>
            </div>
            {onSyncFromStep3 && (
              <button
                onClick={onSyncFromStep3}
                className="px-2 py-1 bg-white dark:bg-slate-800 border border-indigo-300 text-indigo-700 dark:text-indigo-300 rounded-lg text-[11px] font-bold hover:bg-indigo-100 dark:hover:bg-slate-700 transition-colors flex items-center gap-1 shadow-sm"
                title="一键拉取 Step 3 最新文案标题"
              >
                <RefreshCw className="w-3 h-3" />
                <span>同步 Step 3 结果</span>
              </button>
            )}
          </div>

          {/* Artificial Video Editing Workbench Feature Card */}
          <div className="p-3.5 bg-gradient-to-r from-purple-900/20 via-indigo-900/20 to-slate-900/40 dark:from-purple-950/50 dark:via-indigo-950/50 dark:to-slate-900/80 border border-purple-500/30 rounded-xl flex items-center justify-between text-xs">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-gradient-to-br from-purple-600 to-indigo-600 text-white shadow-md">
                <Scissors className="w-4 h-4" />
              </div>
              <div>
                <span className="font-bold text-slate-800 dark:text-slate-100 block">
                  人工精细剪辑与自定义音效字幕
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  支持多轨道剪辑、自定义字体、精细卡点、BGM及音效独立控制
                </span>
              </div>
            </div>
            <button
              onClick={() => setIsArtificialEditorOpen(true)}
              className="px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-lg font-bold text-xs shadow-md transition-all shrink-0 flex items-center gap-1.5"
            >
              <span>进入剪辑台</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1">
              第 3 步爆款标题 (copywritingTitle)
            </label>
            <input
              type="text"
              value={inputs.copywritingTitle}
              onChange={(e) => onUpdateInputs({ copywritingTitle: e.target.value })}
              placeholder="来自于第 3 步的标题..."
              className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-xs text-slate-800 focus:outline-none focus:border-indigo-500 font-medium shadow-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                调性偏好
              </label>
              <select
                value={inputs.tonePreference}
                onChange={(e) => onUpdateInputs({ tonePreference: e.target.value as any })}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-indigo-500 font-medium shadow-sm"
              >
                <option value="治愈">治愈（晨间舒缓轻音乐/Lofi）</option>
                <option value="卡点">卡点（抖音强低音节奏 Trap）</option>
                <option value="高级">高级（大牌冷感/优雅钢琴）</option>
                <option value="反差">反差（神转折反差音效）</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                商用合规场景
              </label>
              <select
                value={inputs.commercialScenario}
                onChange={(e) => onUpdateInputs({ commercialScenario: e.target.value as any })}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-indigo-500 font-medium shadow-sm"
              >
                <option value="抖音/小红书商业化">商业化（挂车/小店带货免版权）</option>
                <option value="个人">个人分享（非商业化）</option>
              </select>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
            <span className="text-indigo-800 font-bold block">版权合规控制网：</span>
            <p className="text-[11px] text-slate-600 leading-relaxed">
              严格在 60-140 BPM 范围内筛选，推荐抖音与小红书曲库自带的 CC0 免版权或商业授权音乐，保障小黄车挂车不封流。
            </p>
          </div>
        </div>

        {/* Right Output Column (Immersive Dark Focus Canvas) */}
        <div className="lg:col-span-7 flex flex-col justify-between bg-slate-950 p-5 rounded-2xl border border-slate-800 shadow-inner">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-4 h-4" />
                <span>2. BGM 推荐与卡点点位产物</span>
              </div>

              {isCompleted && (
                <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                  <button
                    onClick={() => setActiveTab('visual')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      activeTab === 'visual'
                        ? 'bg-indigo-400 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Eye className="w-3 h-3 inline mr-1" />
                    音频组件
                  </button>
                  <button
                    onClick={() => setActiveTab('json')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      activeTab === 'json'
                        ? 'bg-indigo-400 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <FileCode className="w-3 h-3 inline mr-1" />
                    JSON 代码
                  </button>
                </div>
              )}
            </div>

            {/* Output Display Area */}
            {!output ? (
              <div className="h-64 rounded-xl border border-dashed border-slate-800 bg-slate-900/50 flex flex-col items-center justify-center p-6 text-center">
                <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mb-3 text-slate-500">
                  <Disc className="w-6 h-6 animate-spin-slow" />
                </div>
                <p className="text-xs text-slate-300 font-medium">
                  点击【运行 ▶】启动第 4 步 BGM 匹配引擎
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  （系统将寻找符合调性的曲目、标注 BPM 节奏与卡点建议点位）
                </p>
              </div>
            ) : activeTab === 'visual' ? (
              <div className="space-y-4 animate-fade-in">
                {/* Primary BGM Card */}
                <div className="p-4 rounded-xl bg-slate-900 border border-indigo-500/30 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setIsPlaying(!isPlaying)}
                        className="w-10 h-10 rounded-full bg-indigo-500 hover:bg-indigo-400 text-slate-950 flex items-center justify-center transition-colors shadow-lg shadow-indigo-500/20"
                      >
                        {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
                      </button>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-slate-100">
                            {output.bgm_recommendation.track_name}
                          </h4>
                          <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono text-[10px] border border-indigo-500/30">
                            {output.bgm_recommendation.bpm} BPM
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                          艺人：{output.bgm_recommendation.artist}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-mono bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                      <ShieldAlert className="w-3.5 h-3.5" />
                      <span>已验证商用授权</span>
                    </div>
                  </div>

                  {/* Audio Waveform Simulation */}
                  <div className="h-10 bg-slate-950 rounded-lg p-2 flex items-center gap-1 overflow-hidden">
                    {Array.from({ length: 40 }).map((_, i) => {
                      const heights = [30, 50, 80, 40, 90, 60, 100, 45, 75, 35];
                      const h = heights[i % heights.length];
                      return (
                        <div
                          key={i}
                          className={`flex-1 rounded-full transition-all duration-300 ${
                            isPlaying ? 'bg-indigo-400 animate-pulse' : 'bg-slate-700'
                          }`}
                          style={{ height: `${h}%` }}
                        />
                      );
                    })}
                  </div>

                  {/* Style tags & Mood match */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {output.bgm_recommendation.style.map((s, idx) => (
                      <span key={idx} className="px-2 py-0.5 rounded bg-slate-800 text-indigo-300 text-[11px]">
                        #{s}
                      </span>
                    ))}
                  </div>

                  <p className="text-xs text-slate-300 bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                    <strong className="text-indigo-400 block mb-0.5">契合度解析：</strong>
                    {output.bgm_recommendation.mood_match}
                  </p>

                  <div className="p-2.5 rounded-lg bg-amber-950/20 border border-amber-500/20 text-xs text-amber-200">
                    <span className="font-bold block text-amber-400 mb-0.5">重音卡点建议 (Sync Points)：</span>
                    {output.bgm_recommendation.sync_point}
                  </div>
                </div>

                {/* Alternatives List */}
                <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800">
                  <span className="text-xs font-bold text-slate-300 block mb-2">备选曲目推荐 (Alternatives)</span>
                  <div className="space-y-2">
                    {output.alternatives.map((alt, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 rounded-lg bg-slate-950 border border-slate-800 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <Radio className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                          <span className="font-bold text-slate-200">{alt.track_name}</span>
                          <span className="text-slate-500">({alt.style})</span>
                        </div>
                        <span className="text-[11px] text-slate-400">{alt.when_to_use}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              /* JSON Code View */
              <div className="relative group animate-fade-in">
                <button
                  onClick={handleCopyJson}
                  className="absolute top-3 right-3 z-10 flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 text-slate-300 text-xs hover:bg-slate-700 transition-colors"
                >
                  {copiedJson ? <Check className="w-3.5 h-3.5 text-indigo-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedJson ? '已复制 JSON' : '复制 JSON'}</span>
                </button>

                <pre className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-indigo-400 font-mono overflow-x-auto max-h-96 leading-relaxed">
                  {JSON.stringify(output, null, 2)}
                </pre>
              </div>
            )}
          </div>

          {/* Bottom Step Transfer Notice */}
          {isCompleted && (
            <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
              <span className="text-indigo-400/90 font-mono">
                ✓ BGM 音轨已注入，将结合前 3 步产物进行第 5 步成片合成
              </span>
              <button
                onClick={onNext}
                className="flex items-center gap-1 font-bold text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <span>下一步：合成输出成品</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

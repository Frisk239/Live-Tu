import React, { useState } from 'react';
import { Step3Inputs, Step3Output, Step2Output, StepStatus } from '../types';
import { copyToClipboard, downloadTextFile } from '../utils/format';
import {
  FileText,
  Play,
  RotateCcw,
  Download,
  Copy,
  Check,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Flame,
  ShoppingBag,
  FileCode,
  Eye,
  MessageSquare,
  Edit3,
  RefreshCw,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { PromptEditorModal } from './PromptEditorModal';

interface Step3CardProps {
  inputs: Step3Inputs;
  output?: Step3Output;
  step2Output?: Step2Output;
  status: StepStatus;
  useMockMode: boolean;
  onUpdateInputs: (inputs: Partial<Step3Inputs>) => void;
  onUpdateOutput?: (updatedOutput: Partial<Step3Output>) => void;
  onSyncFromStep2?: () => void;
  onRun: () => void;
  onReset: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export const Step3Card: React.FC<Step3CardProps> = ({
  inputs,
  output,
  step2Output,
  status,
  useMockMode,
  onUpdateInputs,
  onUpdateOutput,
  onSyncFromStep2,
  onRun,
  onReset,
  onPrev,
  onNext,
}) => {
  const [copiedTitle, setCopiedTitle] = useState(false);
  const [copiedFull, setCopiedFull] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [activeTab, setActiveTab] = useState<'visual' | 'json'>('visual');
  const [previewPlatform, setPreviewPlatform] = useState<'douyin' | 'xiaohongshu'>('douyin');
  const [isScriptEditorOpen, setIsScriptEditorOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isRunning = status === 'running';
  const isCompleted = status === 'completed' && Boolean(output);

  const handleCopyTitle = async () => {
    if (output?.title) {
      await copyToClipboard(output.title);
      setCopiedTitle(true);
      setTimeout(() => setCopiedTitle(false), 2000);
    }
  };

  const handleCopyFullText = async () => {
    if (output) {
      const fullText = `【${output.title}】\n\n📌 3秒前置钩子：${output.hook}\n\n📝 正文文案：\n${output.body}\n\n🏷 话题标签：${output.hashtags.join(' ')}\n\n🛒 行动号召：${output.cta}`;
      await copyToClipboard(fullText);
      setCopiedFull(true);
      setTimeout(() => setCopiedFull(false), 2000);
    }
  };

  const handleCopyJson = async () => {
    if (output) {
      await copyToClipboard(JSON.stringify(output, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  };

  const handleSaveScriptFromEditor = (updatedText: string) => {
    if (output && onUpdateOutput) {
      onUpdateOutput({ body: updatedText });
    }
  };

  const handleRegenerateFromEditor = (updatedText: string) => {
    if (output && onUpdateOutput) {
      onUpdateOutput({ body: updatedText });
    }
    onRun();
  };

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
          <div className="w-8 h-8 rounded-lg bg-cyan-600 text-white font-bold flex items-center justify-center shadow-surface-sm">
            3
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              第 3 步：视频 → 爆款文案生成
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              视频内容理解 + BUV 3:4:3 控油卖点 & SGS 实测数据高转化融入（禁用违禁词）
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-surface-sm ${
              isFullscreen
                ? 'bg-cyan-600 text-white hover:bg-cyan-700'
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
                <Maximize2 className="w-3.5 h-3.5 text-cyan-600" />
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
              onClick={() =>
                downloadTextFile(
                  `【${output?.title}】\n\n钩子：${output?.hook}\n\n正文：\n${output?.body}\n\n标签：${output?.hashtags.join(' ')}\n\n号召：${output?.cta}`,
                  'buv_script.txt'
                )
              }
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 transition-colors shadow-sm"
            >
              <Download className="w-3.5 h-3.5 text-cyan-600" />
              <span>下载文案</span>
            </button>
          )}

          <button
            onClick={onRun}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 transition-all shadow-md shadow-cyan-600/20"
          >
            {isRunning ? (
              <>
                <Sparkles className="w-3.5 h-3.5 animate-spin" />
                <span>文案生成中...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>运行 ▶</span>
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
          <div className="text-xs font-bold text-cyan-700 uppercase tracking-wider flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <FileText className="w-4 h-4" />
              <span>1. 继承视频 Prompt 与平台人设</span>
            </div>
          </div>

          {/* Context Inheritance Banner */}
          <div className="p-2.5 bg-cyan-50/80 dark:bg-cyan-950/30 border border-cyan-200/80 dark:border-cyan-800/60 rounded-xl flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
              <span className="font-semibold text-cyan-800 dark:text-cyan-300">
                🔗 已自动引用 Step 2 运镜 Prompt
              </span>
            </div>
            {onSyncFromStep2 && (
              <button
                onClick={onSyncFromStep2}
                className="px-2 py-1 bg-white dark:bg-slate-800 border border-cyan-300 text-cyan-700 dark:text-cyan-300 rounded-lg text-[11px] font-bold hover:bg-cyan-100 dark:hover:bg-slate-700 transition-colors flex items-center gap-1 shadow-sm"
                title="一键拉取 Step 2 最新 video_prompt"
              >
                <RefreshCw className="w-3 h-3" />
                <span>同步 Step 2 结果</span>
              </button>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1">
              继承的视频描述 video_prompt
            </label>
            <textarea
              value={inputs.videoPrompt}
              onChange={(e) => onUpdateInputs({ videoPrompt: e.target.value })}
              placeholder="来自于第 2 步的视频镜头描述..."
              className="w-full h-24 bg-white border border-slate-300 rounded-lg p-2.5 text-xs text-slate-800 font-mono focus:outline-none focus:border-cyan-500 resize-none shadow-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                目标平台
              </label>
              <select
                value={inputs.targetPlatform}
                onChange={(e) => onUpdateInputs({ targetPlatform: e.target.value as any })}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-cyan-500 font-medium shadow-sm"
              >
                <option value="douyin">抖音（卡点强引导）</option>
                <option value="xiaohongshu">小红书（真实长文体验）</option>
                <option value="shipinhao">视频号（信任长辈口碑）</option>
                <option value="general">通用平台</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                文案人设
              </label>
              <select
                value={inputs.scriptPersona}
                onChange={(e) => onUpdateInputs({ scriptPersona: e.target.value as any })}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-cyan-500 font-medium shadow-sm"
              >
                <option value="油皮亲妈">油皮亲妈（共情出油痛点）</option>
                <option value="成分党">成分党（3重泥+4重植萃深扒）</option>
                <option value="学生党平价">学生党平价（49元极致性价比）</option>
                <option value="高级感沉浸">高级感沉浸（SPA级晨间洗面）</option>
              </select>
            </div>
          </div>

          {/* BUV Selling point tags */}
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
            <span className="text-slate-700 font-bold block">自动注入品牌硬核卖点：</span>
            <div className="flex flex-wrap gap-1.5">
              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 text-[11px] font-medium">
                3重天然泥
              </span>
              <span className="px-2 py-0.5 rounded bg-teal-100 text-teal-800 border border-teal-200 text-[11px] font-medium">
                4重控油植萃
              </span>
              <span className="px-2 py-0.5 rounded bg-cyan-100 text-cyan-800 border border-cyan-200 text-[11px] font-medium">
                SGS 8h控油 -66.87%
              </span>
              <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 border border-indigo-200 text-[11px] font-medium">
                14天黑头 -35.92%
              </span>
            </div>
          </div>
        </div>

        {/* Right Output Column (Dark Immersive Viewport) */}
        <div className="lg:col-span-7 flex flex-col justify-between bg-slate-950 p-5 rounded-2xl border border-slate-800 shadow-inner">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-4 h-4" />
                <span>2. 爆款文案结构化产物与平台预览</span>
              </div>

              {isCompleted && (
                <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                  <button
                    onClick={() => setActiveTab('visual')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      activeTab === 'visual'
                        ? 'bg-cyan-400 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Eye className="w-3 h-3 inline mr-1" />
                    手机渲染
                  </button>
                  <button
                    onClick={() => setActiveTab('json')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      activeTab === 'json'
                        ? 'bg-cyan-400 text-slate-950 font-bold'
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
                  <MessageSquare className="w-6 h-6" />
                </div>
                <p className="text-xs text-slate-300 font-medium">
                  点击【运行 ▶】启动第 3 步爆款文案撰写引擎
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  （系统将自动编写标题、前3秒钩子、段落正文、话题标签与挂车号召）
                </p>
              </div>
            ) : activeTab === 'visual' ? (
              <div className="space-y-4 animate-fade-in">
                {/* Platform Switcher Pills */}
                <div className="flex items-center justify-between bg-slate-900 p-1.5 rounded-xl border border-slate-800">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPreviewPlatform('douyin')}
                      className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                        previewPlatform === 'douyin'
                          ? 'bg-black text-emerald-400 border border-emerald-500/40 shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      抖音挂车模式
                    </button>
                    <button
                      onClick={() => setPreviewPlatform('xiaohongshu')}
                      className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                        previewPlatform === 'xiaohongshu'
                          ? 'bg-rose-500 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      小红书笔记模式
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setIsScriptEditorOpen(true)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors border border-slate-700"
                    >
                      <Edit3 className="w-3.5 h-3.5 text-cyan-400" />
                      <span>查看 / 编辑文案</span>
                    </button>

                    <button
                      onClick={handleCopyFullText}
                      className="flex items-center gap-1 px-3 py-1 rounded-lg bg-cyan-500/20 text-cyan-300 text-xs font-medium hover:bg-cyan-500/30 transition-colors"
                    >
                      {copiedFull ? <Check className="w-3.5 h-3.5 text-cyan-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedFull ? '已复制全套' : '复制文案'}</span>
                    </button>
                  </div>
                </div>

                {/* Phone Post Mockup Frame */}
                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 relative space-y-3">
                  {/* Hook Pill */}
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950 border border-amber-500/30">
                    <div className="flex items-center gap-2">
                      <Flame className="w-4 h-4 text-amber-400 shrink-0" />
                      <div>
                        <span className="text-[10px] text-amber-300 block font-mono">前3秒黄金钩子 (Hook)</span>
                        <span className="text-xs font-bold text-slate-100">{output.hook}</span>
                      </div>
                    </div>
                  </div>

                  {/* Title */}
                  <div className="flex items-center justify-between bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                    <div className="pr-2">
                      <span className="text-[10px] text-slate-400 block font-mono">爆款标题 (Title)</span>
                      <h4 className="text-sm font-bold text-emerald-300">{output.title}</h4>
                    </div>
                    <button
                      onClick={handleCopyTitle}
                      className="p-1.5 rounded bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors shrink-0"
                      title="复制标题"
                    >
                      {copiedTitle ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {/* Script Body */}
                  <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 leading-relaxed whitespace-pre-line font-sans">
                    {previewPlatform === 'douyin'
                      ? output.platform_fit.douyin
                      : output.platform_fit.xiaohongshu}
                  </div>

                  {/* Hashtags & CTA */}
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pt-1">
                    <div className="flex flex-wrap gap-1.5">
                      {output.hashtags.map((tag, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 rounded text-[11px] bg-slate-800 text-cyan-300 font-mono"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center gap-1.5 text-xs font-bold text-amber-300 bg-amber-500/10 px-2.5 py-1 rounded-md border border-amber-500/20 shrink-0">
                      <ShoppingBag className="w-3.5 h-3.5" />
                      <span>{output.cta}</span>
                    </div>
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
                  {copiedJson ? <Check className="w-3.5 h-3.5 text-cyan-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedJson ? '已复制 JSON' : '复制 JSON'}</span>
                </button>

                <pre className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-cyan-400 font-mono overflow-x-auto max-h-96 leading-relaxed">
                  {JSON.stringify(output, null, 2)}
                </pre>
              </div>
            )}
          </div>

          {/* Bottom Step Transfer Notice */}
          {isCompleted && (
            <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
              <span className="text-cyan-400/90 font-mono">
                ✓ 爆款文案已生成，将传递至第 4 步匹配商用 BGM 音轨
              </span>
              <button
                onClick={onNext}
                className="flex items-center gap-1 font-bold text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                <span>下一步：匹配 BGM</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Script Text Editor Modal */}
      {output && (
        <PromptEditorModal
          isOpen={isScriptEditorOpen}
          onClose={() => setIsScriptEditorOpen(false)}
          title="第 3 步：爆款视频文案脚本编辑器"
          promptType="script_body"
          modelName="BUV 爆款文案生成器"
          initialPrompt={output.body}
          onSavePrompt={handleSaveScriptFromEditor}
          onRegenerate={handleRegenerateFromEditor}
          isRegenerating={isRunning}
        />
      )}
    </div>
  );
};

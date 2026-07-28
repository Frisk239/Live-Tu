import React, { useState, useEffect } from 'react';
import {
  X,
  Copy,
  Check,
  RefreshCw,
  Sparkles,
  Save,
  Wand2,
} from 'lucide-react';

interface PromptEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  promptType: 'static_image_prompt' | 'video_prompt' | 'script_body';
  modelName?: string;
  initialPrompt: string;
  onSavePrompt: (updatedPrompt: string) => void;
  onRegenerate: (updatedPrompt: string) => void;
  isRegenerating?: boolean;
}

export const PromptEditorModal: React.FC<PromptEditorModalProps> = ({
  isOpen,
  onClose,
  title,
  promptType,
  modelName,
  initialPrompt,
  onSavePrompt,
  onRegenerate,
  isRegenerating = false,
}) => {
  const [promptText, setPromptText] = useState(initialPrompt);
  const [copied, setCopied] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);

  useEffect(() => {
    setPromptText(initialPrompt);
  }, [initialPrompt, isOpen]);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(promptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = () => {
    onSavePrompt(promptText);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 1500);
  };

  const handleRegenerateClick = () => {
    onSavePrompt(promptText);
    onRegenerate(promptText);
  };

  const handleAiEnhance = () => {
    setIsEnhancing(true);
    setTimeout(() => {
      let enhanced = promptText;
      if (promptType === 'static_image_prompt') {
        enhanced +=
          ', cinematic lighting, soft focus bokeh background, ultra-realistic texture, 8k resolution, perfect composition';
      } else if (promptType === 'video_prompt') {
        enhanced +=
          ', seamless fluid 60fps motion, cinematic camera pan, natural soft morning lighting, high detail physics rendering';
      } else {
        enhanced += '\n\n【排版优化】：加入了高转化引导词与爆款文案心理按压策略';
      }
      setPromptText(enhanced);
      setIsEnhancing(false);
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xl w-full max-w-3xl overflow-hidden text-slate-900 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/80">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600 border border-blue-200/60">
              <Wand2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-slate-900 text-base">{title}</h3>
                {modelName && (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200/60">
                    {modelName} 专属适配
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                可直接在下方编辑提示词词组，调整参数权重后点击重新生成
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

        {/* Action Quickbar */}
        <div className="px-6 py-3 bg-slate-50/50 border-b border-slate-100 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <button
              onClick={handleAiEnhance}
              disabled={isEnhancing}
              className="px-3.5 py-1.5 rounded-lg bg-white border border-slate-200/80 text-slate-700 font-semibold text-xs shadow-2xs hover:bg-slate-100/60 transition-all cursor-pointer flex items-center gap-1.5"
            >
              <Sparkles className={`w-3.5 h-3.5 text-blue-600 ${isEnhancing ? 'animate-spin' : ''}`} />
              <span>{isEnhancing ? 'AI 智能润色中...' : 'AI 智能提示词润色'}</span>
            </button>
            <span className="text-slate-500 font-medium">
              字数: {promptText.length} 字
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="px-3.5 py-1.5 rounded-lg bg-white border border-slate-200/80 text-slate-700 font-semibold text-xs shadow-2xs hover:bg-slate-100/60 transition-all cursor-pointer flex items-center gap-1.5"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="text-emerald-700">已复制!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>复制 Prompt</span>
                </>
              )}
            </button>

            <button
              onClick={handleSave}
              className="px-3.5 py-1.5 rounded-lg bg-white border border-slate-200/80 text-slate-700 font-semibold text-xs shadow-2xs hover:bg-slate-100/60 transition-all cursor-pointer flex items-center gap-1.5"
            >
              {savedSuccess ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="text-emerald-700">已保存</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>保存修改</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Text Area */}
        <div className="p-6 flex-1 bg-white flex flex-col">
          <label className="text-xs font-semibold text-slate-700 mb-2 flex items-center justify-between">
            <span>Prompt Asset Raw Text Editor</span>
            <span className="text-[11px] text-slate-400">提示：修改关键词可精细控制光影、材质与动作</span>
          </label>
          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            rows={8}
            className="w-full flex-1 bg-white border border-slate-200 rounded-xl p-4 text-xs font-mono text-slate-900 leading-relaxed focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none shadow-2xs"
            placeholder="输入或修改 Prompt..."
          />
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            Prompt 作为核心数字资产，修改后将同步更新流水线中的下一步衔接
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 bg-white border border-slate-200/80 shadow-2xs hover:bg-slate-100 transition-colors cursor-pointer"
            >
              关闭
            </button>
            <button
              onClick={handleRegenerateClick}
              disabled={isRegenerating}
              className="px-5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
              <span>{isRegenerating ? '重新渲染中...' : '使用新 Prompt 重新生成图片/视频'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

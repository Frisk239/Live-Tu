import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles,
  ArrowRight,
  ArrowLeft,
  X,
  BookOpen,
  CheckCircle2,
  Film,
  Layers,
  Cpu,
  HelpCircle,
} from 'lucide-react';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStartAutoPipeline?: () => void;
  onOpenKnowledge?: () => void;
}

const ONBOARDING_STEPS = [
  {
    id: 1,
    title: '欢迎体验 AI 爆款视频反推与重构工作台',
    tagline: '短视频反向工程 · 结构化 AIGC 商业落地',
    description:
      '本工作台基于 BUV (Bottom-Up Video) 爆款视频反推算法，将爆款短视频或 Live 图精准拆解，并重构为高转化率带货视频工程。',
    highlights: [
      { icon: Film, label: '全流程 5 步贯通', desc: '从视频视觉解析到镜头运镜、爆款脚本文案、BGM卡点及成片导出' },
      { icon: BookOpen, label: '品牌卖点库深度绑定', desc: '自动注入产品核心配方、SGS 实测数据与合规避坑词' },
    ],
  },
  {
    id: 2,
    title: 'Step 1: 绑定品牌卖点与知识资产库',
    tagline: '深度融合 DeepSeek V3 / R1 & GPT-4o 多模型',
    description:
      '在【卖点库】中，你可以自由录入或选定不同产品。AI 卖点提炼引擎将帮助你一键提炼专业配方与高转化带货痛点。',
    highlights: [
      { icon: BookOpen, label: '自定义卖点与行业预设', desc: '提供美妆护肤、数码科技、食品饮料等丰富的行业爆款产品模板' },
      { icon: Cpu, label: 'AI 深度卖点润色', desc: '支持 DeepSeek V3 / R1 / GPT-4o / Gemini 一键润色提炼规范卖点' },
      { icon: CheckCircle2, label: '合规禁忌词智能避坑', desc: '文案生成时自动规避极限词与违规广告词，确保商业投放安全' },
    ],
  },
  {
    id: 3,
    title: '拆解 BUV 5步核心反推工作台',
    tagline: '5 个核心模块环环相扣，实现专业级短视频重构',
    description:
      '在工作台主区域，你将体验到清晰递进的 5 步爆款视频生成与剪辑模块：',
    pipelineItems: [
      { step: 'Step 1', title: '视觉抽帧与静态图 Prompt', desc: '提取视频黄金帧，生成适配 Imagen/Midjourney 的提示词' },
      { step: 'Step 2', title: '运镜轨迹与动态 Prompt', desc: '设定推拉摇移运镜，支持发送至 AI 视频渲染引擎（Veo3 / Kling）' },
      { step: 'Step 3', title: '爆款带货脚本文案', desc: '黄金 3 秒 Hook 抓人眼球，结合卖点库生成口播与爆款花字' },
      { step: 'Step 4', title: '智能卡点 BGM & 剪辑', desc: '匹配抖音/小红书热歌 BPM，并提供人工精细剪辑（字体/音效/BGM）' },
      { step: 'Step 5', title: '综合成片预览与工程打包', desc: '实时合成视频预览，提供高清 MP4、视频字幕与剪映草稿工程导出' },
    ],
  },
  {
    id: 4,
    title: '高级功能：模型配置中心与任务资产',
    tagline: '媲美专业 AIGC 团队的落地级生产基础设施',
    description:
      '侧边栏导航为你提供了完善的专业辅助矩阵，提升创作效率与控制粒度：',
    highlights: [
      { icon: Layers, label: '爆款预设模版库', desc: '内置美妆护肤、数码测评、美食探店等热门短视频爆款模板' },
      { icon: Cpu, label: 'AI 模型配置中心', desc: '自由配置 DeepSeek、GPT-4o、Gemini 3.6 及 Imagen/Veo3 API 密钥' },
      { icon: Film, label: '视频素材与后台任务', desc: '管理上传的视频素材与后台正在运行的 AI 高并发渲染任务' },
    ],
  },
  {
    id: 5,
    title: '准备完毕！开启你的第一个爆款生成',
    tagline: '开启商业落地级短视频重构',
    description:
      '点击开始体验，工作台将为你呈现完整的反推与重构成果！',
    highlights: [
      { icon: Sparkles, label: '全流程智能贯通', desc: '自动无缝链接 5 步流程，极速获得完整爆款成果工程' },
      { icon: Film, label: '人工精细剪辑与微调', desc: '支持随时微调画面 Prompt、文案风格、替换 BGM 与修剪轨道' },
    ],
  },
];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  if (!isOpen) return null;

  const step = ONBOARDING_STEPS[currentStepIndex];
  const isFirst = currentStepIndex === 0;
  const isLast = currentStepIndex === ONBOARDING_STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      handleComplete();
    } else {
      setCurrentStepIndex((prev) => prev + 1);
    }
  };

  const handlePrev = () => {
    if (!isFirst) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  };

  const handleComplete = () => {
    if (dontShowAgain) {
      localStorage.setItem('aigc_onboarding_completed', 'true');
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white text-slate-900 border border-slate-200/90 rounded-2xl w-full max-w-2xl shadow-xl overflow-hidden my-auto flex flex-col">
        {/* Header Progress Bar */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/80">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-50 text-blue-600 border border-blue-200/60">
              <Sparkles className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-slate-900">
              新手操作指南 ({currentStepIndex + 1} / {ONBOARDING_STEPS.length})
            </span>
          </div>

          {/* Step Dots */}
          <div className="flex items-center gap-1.5">
            {ONBOARDING_STEPS.map((s, idx) => (
              <button
                key={s.id}
                onClick={() => setCurrentStepIndex(idx)}
                className={`h-2 rounded-full transition-all cursor-pointer ${
                  idx === currentStepIndex
                    ? 'w-6 bg-blue-600'
                    : idx < currentStepIndex
                    ? 'w-2 bg-emerald-500'
                    : 'w-2 bg-slate-200'
                }`}
                title={`跳转到第 ${idx + 1} 步`}
              />
            ))}
          </div>

          <button
            onClick={handleComplete}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            title="关闭引导"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Animated Body Content */}
        <div className="p-6 md:p-8 flex-1 overflow-y-auto bg-white">
          <AnimatePresence mode="wait">
            <motion.div
              key={step.id}
              initial={{ opacity: 0, x: 15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -15 }}
              transition={{ duration: 0.18 }}
              className="space-y-5"
            >
              {/* Title & Tagline Banner */}
              <div>
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200/60 mb-2">
                  <HelpCircle className="w-3.5 h-3.5 text-blue-600" />
                  <span>{step.tagline}</span>
                </div>
                <h3 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">
                  {step.title}
                </h3>
                <p className="text-xs md:text-sm text-slate-500 mt-2 leading-relaxed">
                  {step.description}
                </p>
              </div>

              {/* Highlights Cards */}
              {step.highlights && (
                <div className="grid grid-cols-1 gap-2.5">
                  {step.highlights.map((item, idx) => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={idx}
                        className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 hover:bg-blue-50/50 transition-colors flex items-start gap-3"
                      >
                        <div className="p-2 rounded-lg bg-blue-100 text-blue-700 shrink-0 mt-0.5">
                          <Icon className="w-4 h-4" />
                        </div>
                        <div>
                          <h4 className="text-xs font-semibold text-slate-900">
                            {item.label}
                          </h4>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {item.desc}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pipeline Step List (Step 3) */}
              {step.pipelineItems && (
                <div className="space-y-2">
                  {step.pipelineItems.map((p, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="px-2 py-0.5 rounded-md font-semibold text-[11px] bg-blue-50 text-blue-700 border border-blue-200/60 shrink-0">
                          {p.step}
                        </span>
                        <div className="truncate">
                          <span className="font-semibold text-slate-900 mr-2">{p.title}</span>
                          <span className="text-slate-500 hidden sm:inline text-[11px]">{p.desc}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer Navigation Bar */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            />
            <span>不再自动弹出新手指南</span>
          </label>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            {!isFirst && (
              <button
                onClick={handlePrev}
                className="px-3.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-medium transition-all flex items-center gap-1 cursor-pointer shadow-2xs"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>上一步</span>
              </button>
            )}

            {isLast ? (
              <button
                onClick={handleComplete}
                className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-2xs transition-all cursor-pointer"
              >
                开始体验工作台
              </button>
            ) : (
              <button
                onClick={handleNext}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <span>下一步</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

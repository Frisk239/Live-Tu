import React, { useState, useEffect } from 'react';
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
  Play,
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
      '本工作台基于 BUV (Bottom-Up Video) 爆款视频反推算法，将已有的爆款短视频或静态参考图拆解为可复用的要素，端到端复刻同款高转化率内容。',
    highlights: [
      { icon: Film, label: '全流程 5 步贯通', desc: '包含 视觉抽帧拆解 → 运镜轨迹 → 爆款脚本文案 → BGM卡点 → 多轨视频合成导出' },
      { icon: Sparkles, label: '内置素材智能匹配', desc: '选取内置爆款素材时，系统自动锁定专属来源平台（小红书/抖音）与博主人设' },
    ],
  },
  {
    id: 2,
    title: 'Step 1: 绑定品牌卖点与知识资产库',
    tagline: '默认 Gemini 3.6 Flash，支持 GPT-4o / DeepSeek 多模型',
    description:
      '在【卖点库】中，你可以自由录入或选定不同产品。AI 卖点提炼引擎将帮助你一键提炼专业配方与高转化带货痛点。',
    highlights: [
      { icon: BookOpen, label: '自定义卖点与行业预设', desc: '提供美妆护肤、数码科技、食品饮料等丰富的行业爆款产品模板' },
      { icon: Cpu, label: 'AI 深度卖点润色', desc: '默认 Gemini 3.6 Flash，亦可切换 GPT-4o / DeepSeek 一键润色卖点' },
      { icon: CheckCircle2, label: '合规禁忌词智能避坑', desc: '文案生成时自动规避极限词与违规广告词，确保商业投放安全' },
    ],
    actionType: 'knowledge',
  },
  {
    id: 3,
    title: '拆解 BUV 5步核心反推工作台',
    tagline: '5 个核心模块环环相扣，实现专业级短视频重构',
    description:
      '在工作台主区域，你将体验到清晰递进的 5 步爆款视频生成与剪辑模块：',
    pipelineItems: [
      { step: 'Step 1', title: '视觉抽帧与静态图 Prompt', desc: '提取视频黄金帧与风格要素，生成适配 GPT Image / Seedream 提示词' },
      { step: 'Step 2', title: '运镜轨迹与动态 Prompt', desc: '设定推拉摇移运镜，支持发送至 Seedance / Veo AI 视频生成引擎' },
      { step: 'Step 3', title: '爆款带货脚本文案', desc: '黄金 3 秒 Hook 抓人眼球，按平台（抖音/小红书）精准生成带货文本' },
      { step: 'Step 4', title: '智能卡点 BGM 匹配', desc: '推荐高质量确权 BGM，计算 BPM 重音卡点点位与商业合规授权' },
      { step: 'Step 5', title: '综合成片预览与真 MP4 导出', desc: '实时多轨 Timeline 预览，一键导出最终 MP4 视频与工程包' },
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
      { icon: Cpu, label: 'AI 模型配置中心', desc: '默认 Gemini 3.6 Flash + GPT Image 2，云雾网关极速响应' },
      { icon: Film, label: '素材管理与后台任务', desc: '管理上传的素材库与后台高并发全自动 AI 贯通任务' },
    ],
  },
  {
    id: 5,
    title: '准备完毕！开启你的第一个爆款生成',
    tagline: '开启商业落地级短视频重构',
    description:
      '你可以直接启动全自动贯通反推，也可以手动逐步体验每个步骤的精细控制！',
    highlights: [
      { icon: Sparkles, label: '全流程智能贯通', desc: '点击「一键全自动贯通反推」，极速获取包含全套产物的完整爆款工程' },
      { icon: Film, label: '人工精细剪辑与微调', desc: '随时查看与编辑 Prompt、切换平台预览模式及导出 MP4 视频' },
    ],
    actionType: 'start',
  },
];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
  onStartAutoPipeline,
  onOpenKnowledge,
}) => {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Keyboard navigation support
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleComplete();
      } else if (e.key === 'ArrowRight') {
        if (currentStepIndex < ONBOARDING_STEPS.length - 1) {
          setCurrentStepIndex((prev) => prev + 1);
        }
      } else if (e.key === 'ArrowLeft') {
        if (currentStepIndex > 0) {
          setCurrentStepIndex((prev) => prev - 1);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, currentStepIndex]);

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
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) handleComplete();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs overflow-y-auto"
    >
      <div className="bg-white text-slate-900 border border-slate-200/90 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden my-auto flex flex-col">
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
            title="关闭指南 (Esc)"
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

              {/* Quick Action Button for Knowledge Page */}
              {step.actionType === 'knowledge' && onOpenKnowledge && (
                <div className="pt-1">
                  <button
                    onClick={() => {
                      handleComplete();
                      onOpenKnowledge();
                    }}
                    className="px-3.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-blue-700 font-semibold text-xs transition-colors flex items-center gap-1.5 cursor-pointer border border-slate-200"
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>前往【卖点库与 AI 润色】页面</span>
                  </button>
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
              <div className="flex items-center gap-2">
                {onStartAutoPipeline && (
                  <button
                    onClick={() => {
                      handleComplete();
                      onStartAutoPipeline();
                    }}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>一键全自动反推工程</span>
                  </button>
                )}
                <button
                  onClick={handleComplete}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-2xs transition-all cursor-pointer"
                >
                  开始体验工作台
                </button>
              </div>
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

import React from 'react';
import { ProductItem } from '../types';
import {
  BookOpen,
  Layers,
  Zap,
  Cpu,
  Film,
  ListTodo,
  PackageCheck,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Settings2,
  FolderKanban,
  RotateCcw,
  Workflow,
  Music2,
  LogOut,
} from 'lucide-react';

export type MainViewType =
  | 'pipeline'
  | 'materials'
  | 'tasks'
  | 'presets'
  | 'models'
  | 'knowledge'
  | 'bgm';

interface SidebarProps {
  sidebarWidth?: number;
  setSidebarWidth?: (w: number) => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
  activeView: MainViewType;
  onChangeView: (view: MainViewType) => void;
  onOpenOnboarding: () => void;
  onResetAll: () => void;
  activeProduct?: ProductItem;
  products?: ProductItem[];
  onSelectActiveProduct?: (id: string) => void;
  onOpenSessionManager?: () => void;
  onLogout?: () => void;
  isAdmin?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isExpanded,
  onToggleExpand,
  activeView,
  onChangeView,
  onOpenOnboarding,
  onResetAll,
  activeProduct,
  products = [],
  onSelectActiveProduct,
  onOpenSessionManager,
  onLogout,
  isAdmin = false,
}) => {
  const currentWidthClass = isExpanded ? 'w-[240px]' : 'w-[68px]';

  return (
    <aside
      className={`sticky top-0 h-screen z-30 bg-white text-slate-900 border-r border-slate-200/80 flex flex-col justify-between shrink-0 select-none transition-all duration-300 ${currentWidthClass}`}
    >
      {/* Top Section */}
      <div className="overflow-hidden flex flex-col h-full justify-between">
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
          {/* Header */}
          <div className={`p-3.5 border-b border-slate-200/80 bg-slate-50/50 flex items-center min-h-[61px] ${isExpanded ? 'justify-between' : 'justify-center'}`}>
            {isExpanded ? (
              <>
                <div className="flex items-center gap-2.5 overflow-hidden pl-1">
                  <div className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600 text-white font-bold shrink-0 shadow-2xs">
                    <span className="text-xs font-black">LIVE</span>
                  </div>
                  <div className="truncate">
                    <span className="font-semibold text-xs text-slate-900 block truncate">
                      AI 爆款反推工作台
                    </span>
                    <span className="text-[10px] text-blue-700 font-medium bg-blue-50 px-1.5 py-0.5 rounded-full border border-blue-200/60 inline-block">
                      v2.5 PRO
                    </span>
                  </div>
                </div>

                <button
                  onClick={onToggleExpand}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
                  title="收起侧边栏"
                >
                  <PanelLeftClose className="w-4 h-4" />
                </button>
              </>
            ) : (
              <button
                onClick={onToggleExpand}
                className="p-2 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors cursor-pointer"
                title="展开侧边栏"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Navigation Items Group */}
          <div className="p-2.5 space-y-4 flex-1 overflow-y-auto">
            {/* Main Pipeline Entrance */}
            <div className="flex flex-col space-y-1">
              <div className="px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                <span>核心工程</span>
                <Workflow className="w-3.5 h-3.5 text-slate-400" />
              </div>

              <button
                onClick={() => onChangeView('pipeline')}
                className={`flex items-center gap-2.5 rounded-lg text-xs font-medium transition-all w-full px-3 py-2 cursor-pointer ${
                  activeView === 'pipeline'
                    ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                    : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                }`}
                title="5步短视频反推与生成主工程"
              >
                <Workflow className="w-4 h-4 shrink-0" />
                <span className="truncate">5步反推生成工作台</span>
              </button>
            </div>

            {/* Section 1: Active Product & Knowledge Base */}
            <div className="flex flex-col space-y-1">
              <div className="px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                <span>品牌与卖点库</span>
                <Sparkles className="w-3.5 h-3.5 text-slate-400" />
              </div>

              {/* Active Product Selector Card */}
              {activeProduct && (
                <div className="my-1 rounded-lg p-2.5 bg-slate-50 border border-slate-200/80 transition-all">
                  <div className="flex items-center justify-between text-[11px] font-medium text-slate-600 mb-1.5">
                    <span className="flex items-center gap-1 text-slate-700">
                      <PackageCheck className="w-3.5 h-3.5 text-blue-600" />
                      绑定产品
                    </span>
                    <span className="text-[10px] text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                      {activeProduct.category}
                    </span>
                  </div>

                  <select
                    value={activeProduct.id}
                    onChange={(e) =>
                      onSelectActiveProduct && onSelectActiveProduct(e.target.value)
                    }
                    className="w-full bg-white text-xs font-medium text-slate-900 border border-slate-200 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Knowledge Base Direct Page Navigation */}
              {isAdmin && (
                <button
                  onClick={() => onChangeView('knowledge')}
                  className={`flex items-center gap-2.5 rounded-lg text-xs font-medium transition-all w-full px-3 py-2 cursor-pointer ${
                    activeView === 'knowledge'
                      ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                      : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                  }`}
                  title="卖点库与品牌知识中心"
                >
                  <BookOpen className="w-4 h-4 shrink-0" />
                  <span className="truncate">卖点库 & AI润色</span>
                </button>
              )}
            </div>

            {/* Section 2: Core Workspace Modules */}
            <div className="flex flex-col space-y-1">
              <div className="px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                <span>创作中心</span>
                <FolderKanban className="w-3.5 h-3.5 text-slate-400" />
              </div>

              {/* Workspace Sessions Modal Trigger */}
              {onOpenSessionManager && (
                <button
                  onClick={onOpenSessionManager}
                  className="flex items-center gap-2.5 rounded-lg text-xs font-semibold transition-all w-full px-3 py-2 cursor-pointer bg-blue-50/70 text-blue-700 hover:bg-blue-100/80 border border-blue-200/60"
                  title="查看与恢复历史工作区会话"
                >
                  <ListTodo className="w-4 h-4 shrink-0 text-blue-600" />
                  <span className="truncate">会话与历史工作区</span>
                </button>
              )}

              {/* Materials Library */}
              <button
                onClick={() => onChangeView('materials')}
                className={`flex items-center gap-2.5 rounded-lg text-xs font-medium transition-all w-full px-3 py-2 cursor-pointer ${
                  activeView === 'materials'
                    ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                    : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                }`}
                title="视频素材库页面"
              >
                <Film className="w-4 h-4 shrink-0" />
                <span className="truncate">视频素材库</span>
              </button>

              {/* Tasks Center */}
              <button
                onClick={() => onChangeView('tasks')}
                className={`flex items-center gap-2.5 rounded-lg text-xs font-medium transition-all w-full px-3 py-2 cursor-pointer ${
                  activeView === 'tasks'
                    ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                    : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                }`}
                title="后台任务中心页面"
              >
                <FolderKanban className="w-4 h-4 shrink-0" />
                <span className="truncate">历史会话全集</span>
              </button>

              {/* Presets Library */}
              <button
                onClick={() => onChangeView('presets')}
                className={`flex items-center justify-between rounded-lg text-xs font-medium transition-all w-full px-3 py-2 cursor-pointer ${
                  activeView === 'presets'
                    ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                    : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                }`}
                title="8 大黄金爆款示范模板库与 AI 全链路反推"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Layers className="w-4 h-4 shrink-0 text-blue-600" />
                  <span className="truncate">8大爆款模版库</span>
                </div>
                {isExpanded && (
                  <span className="text-[10px] bg-blue-100 text-blue-800 font-bold px-1.5 py-0.2 rounded border border-blue-200 shrink-0">
                    8 大公式
                  </span>
                )}
              </button>

              {isAdmin && (
                <button
                  onClick={() => onChangeView('models')}
                  className={`flex items-center gap-2.5 rounded-lg text-xs font-medium transition-all w-full px-3 py-2 cursor-pointer ${
                    activeView === 'models'
                      ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                      : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                  }`}
                  title="大模型与提示词配置页面"
                >
                  <Cpu className="w-4 h-4 shrink-0" />
                  <span className="truncate">模型配置中心</span>
                </button>
              )}

              {/* BGM Library */}
              {isAdmin && (
                <button
                  onClick={() => onChangeView('bgm')}
                  className={`flex items-center gap-2.5 rounded-lg text-xs font-medium transition-all w-full px-3 py-2 cursor-pointer ${
                    activeView === 'bgm'
                      ? 'bg-blue-50 text-blue-700 font-semibold border border-blue-200/60'
                      : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                  }`}
                  title="确权 BGM 曲库管理"
                >
                  <Music2 className="w-4 h-4 shrink-0" />
                  <span className="truncate">BGM 确权曲库</span>
                </button>
              )}
            </div>

            {/* Section 3: Help & System Settings */}
            <div className="flex flex-col space-y-1">
              <div className="px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                <span>帮助与系统</span>
                <Settings2 className="w-3.5 h-3.5 text-slate-400" />
              </div>

              {/* Onboarding Guide */}
              <button
                onClick={onOpenOnboarding}
                className="flex items-center gap-2.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-all w-full px-3 py-2 cursor-pointer"
                title="新手引导 & 操作指南"
              >
                <HelpCircle className="w-4 h-4 text-slate-400 shrink-0" />
                <span className="truncate">新手上手指南</span>
              </button>

              {/* AI Engine Status Badge */}
              <div
                className="flex items-center gap-2.5 rounded-lg text-xs font-medium border border-emerald-200/80 bg-emerald-50 text-emerald-700 px-3 py-2 mt-1"
                title="企业级多模型 (DeepSeek / Gemini / GPT)"
              >
                <Zap className="w-4 h-4 fill-emerald-600 text-emerald-600 shrink-0" />
                <span className="truncate">
                  全量 AI 引擎在线
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Section: Reset / Clear Footer */}
        <div className="p-2.5 border-t border-slate-200/80 bg-slate-50/50 flex flex-col items-center">
          <button
            onClick={onResetAll}
            className={`flex items-center justify-center gap-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-600 border border-slate-200/80 hover:border-rose-200 transition-all px-3 py-2 cursor-pointer bg-white shadow-2xs ${isExpanded ? 'w-full' : 'w-10 px-0'}`}
            title="一键清空工作台全部输入、产物与离线缓存"
          >
            <RotateCcw className="w-4 h-4 shrink-0 text-slate-500" />
            {isExpanded && <span>一键清空工作台</span>}
          </button>
          <button
            onClick={onLogout}
            className={`mt-1.5 flex items-center justify-center gap-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-all px-3 py-2 cursor-pointer ${isExpanded ? 'w-full' : 'w-10 px-0'}`}
            title="退出当前账号"
          >
            <LogOut className="w-4 h-4 shrink-0 text-slate-500" />
            {isExpanded && <span>退出登录</span>}
          </button>
        </div>
      </div>
    </aside>
  );
};

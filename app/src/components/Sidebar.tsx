import React from 'react';
import { ProductItem } from '../types';
import type { Permission } from '../services/api';
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
  can: (permission: Permission) => boolean;
  /** S0 真实引擎就绪状态（来自 /api/health 探测）；null = 探测中 */
  engineReadiness?: { ffmpegInstalled: boolean | null; seedanceReady: boolean } | null;
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
  can,
  engineReadiness,
}) => {
  const currentWidthClass = isExpanded ? 'w-[240px]' : 'w-[68px]';

  const mobileItems: Array<{
    view: MainViewType;
    title: string;
    label: string;
    permission: Permission;
    icon: React.ReactNode;
  }> = [
    { view: 'pipeline', title: '5步短视频反推与生成主工程', label: '工作台', permission: 'module.pipeline.read', icon: <Workflow className="w-5 h-5" /> },
    { view: 'materials', title: '视频素材库页面', label: '素材库', permission: 'module.materials.read', icon: <Film className="w-5 h-5" /> },
    { view: 'tasks', title: '后台任务中心页面', label: '任务', permission: 'module.tasks.read', icon: <FolderKanban className="w-5 h-5" /> },
    { view: 'presets', title: '8 大黄金爆款示范模板库与 AI 全链路反推', label: '模板', permission: 'module.presets.read', icon: <Sparkles className="w-5 h-5" /> },
    { view: 'knowledge', title: '卖点库与品牌知识中心', label: '知识库', permission: 'module.knowledge.read', icon: <BookOpen className="w-5 h-5" /> },
  ];

  return (
    <aside
      className={`fixed bottom-0 inset-x-0 z-40 md:z-30 md:sticky md:top-0 md:bottom-auto md:left-auto md:right-auto md:h-screen bg-white text-slate-900 border-t md:border-t-0 md:border-r border-slate-200/80 shrink-0 select-none transition-all duration-300 md:${currentWidthClass}`}
      aria-label="主导航"
    >
      {/* 桌面端：常驻侧栏 */}
      <div className="hidden md:flex overflow-hidden flex-col h-full justify-between">
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

              {can('module.pipeline.read') && (
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
              )}
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
              {can('module.knowledge.read') && (
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
              {can('module.tasks.read') && onOpenSessionManager && (
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
              {can('module.materials.read') && (
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
              )}

              {/* Tasks Center */}
              {can('module.tasks.read') && (
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
              )}

              {/* Presets Library */}
              {can('module.presets.read') && (
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
              )}

              {can('module.models.read') && (
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
              {can('module.bgm.read') && (
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

              {/* S0 真实引擎状态（来自 /api/health 探测），不再静态宣称在线 */}
              {(() => {
                const readiness = engineReadiness;
                const ffmpegOk = readiness?.ffmpegInstalled === true;
                const seedanceOk = readiness?.seedanceReady === true;
                const allOk = Boolean(readiness && ffmpegOk && seedanceOk);
                const checking = !readiness;
                const palette = allOk
                  ? 'border-emerald-200/80 bg-emerald-50 text-emerald-700'
                  : checking
                    ? 'border-slate-200 bg-slate-50 text-slate-500'
                    : 'border-amber-200/80 bg-amber-50 text-amber-700';
                const label = allOk
                  ? '引擎就绪'
                  : checking
                    ? '引擎检测中…'
                    : '引擎部分离线';
                const detail = allOk
                  ? 'FFmpeg ✓ Seedance ✓'
                  : checking
                    ? '正在探测 FFmpeg / Seedance'
                    : `FFmpeg ${ffmpegOk ? '✓' : '✗'} Seedance ${seedanceOk ? '✓' : '✗'}`;
                return (
                  <div
                    className={`flex items-center gap-2.5 rounded-lg text-xs font-medium border px-3 py-2 mt-1 ${palette}`}
                    title={detail}
                  >
                    <Zap className={`w-4 h-4 shrink-0 ${allOk ? 'fill-emerald-600 text-emerald-600' : checking ? 'text-slate-400' : 'fill-amber-500 text-amber-500'}`} />
                    <span className="truncate">{label}</span>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        {/* Bottom Section: Reset / Clear Footer */}
        <div className="p-2.5 border-t border-slate-200/80 bg-slate-50/50 flex flex-col items-center">
          {can('module.pipeline.write') && (
            <button
              onClick={onResetAll}
              className={`flex items-center justify-center gap-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-600 border border-slate-200/80 hover:border-rose-200 transition-all px-3 py-2 cursor-pointer bg-white shadow-2xs ${isExpanded ? 'w-full' : 'w-10 px-0'}`}
              title="一键清空工作台全部输入、产物与离线缓存"
            >
              <RotateCcw className="w-4 h-4 shrink-0 text-slate-500" />
              {isExpanded && <span>一键清空工作台</span>}
            </button>
          )}
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

      {/* 移动端：底部导航（drawer/bottom navigation，不保留压缩后的常驻窄侧栏） */}
      <nav className="md:hidden flex items-stretch justify-around h-14 border-t border-slate-200/80 bg-white" aria-label="移动端底部导航">
        {mobileItems.map((item) =>
          can(item.permission) ? (
            <button
              key={item.view}
              onClick={() => onChangeView(item.view)}
              aria-label={item.title}
              aria-current={activeView === item.view ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-1.5 cursor-pointer ${
                activeView === item.view ? 'text-blue-600' : 'text-slate-500 hover:text-slate-700'
              }`}
              data-testid={`mobile-nav-${item.view}`}
            >
              {item.icon}
              <span className="text-[10px] font-semibold leading-none truncate max-w-full px-0.5">{item.label}</span>
            </button>
          ) : null
        )}
      </nav>
    </aside>
  );
};

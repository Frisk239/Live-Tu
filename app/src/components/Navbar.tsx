import React from 'react';
import { ProductItem } from '../types';
import {
  PackageCheck,
  Zap,
  PanelLeft,
} from 'lucide-react';

interface NavbarProps {
  isSidebarExpanded?: boolean;
  onToggleSidebar?: () => void;
  activeProduct?: ProductItem;
  useMockMode?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  isSidebarExpanded,
  onToggleSidebar,
  activeProduct,
}) => {
  return (
    <header className="sticky top-0 z-20 bg-white/90 backdrop-blur-md border-b border-slate-200/80 px-4 lg:px-8 py-3 text-slate-900 transition-all select-none">
      <div className="flex items-center justify-between gap-4">
        {/* Left Side: Sidebar Toggle & Brand Title */}
        <div className="flex items-center gap-3">
          {!isSidebarExpanded && onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-1.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200/80 transition-colors cursor-pointer"
              title="展开侧边栏"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          )}

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm md:text-base font-semibold text-slate-900 tracking-tight">
                AI 爆款视频反推与生成工作台
              </h1>
              <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/60 hidden sm:inline-block">
                PRO WORKBENCH
              </span>
            </div>
            <p className="text-xs text-slate-500 hidden lg:block mt-0.5">
              短视频解析 → 静态Prompt → 运镜轨迹 → 爆款文案 → BGM卡点 → 合成导出
            </p>
          </div>
        </div>

        {/* Right Side: Active Product & Engine Status */}
        <div className="flex items-center gap-2.5">
          {/* Active Product Badge */}
          {activeProduct && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100/80 border border-slate-200/80 text-slate-800 text-xs font-medium">
              <PackageCheck className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="text-slate-500 text-[11px] hidden sm:inline">当前商品:</span>
              <span className="truncate max-w-[120px] md:max-w-[180px] text-slate-900 font-semibold">
                {activeProduct.name}
              </span>
            </div>
          )}

          {/* Engine Mode Badge */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-emerald-200/80 bg-emerald-50 text-emerald-700">
            <Zap className="w-3.5 h-3.5 fill-emerald-600 text-emerald-600" />
            <span>AI 引擎在线</span>
          </div>
        </div>
      </div>
    </header>
  );
};

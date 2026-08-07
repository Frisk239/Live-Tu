import React, { useEffect, useState } from 'react';
import { ProductItem } from '../types';
import {
  PackageCheck,
  Zap,
  PanelLeft,
  AlertTriangle,
  X,
  Info,
  Plus,
  ListTodo,
} from 'lucide-react';

interface NavbarProps {
  isSidebarExpanded?: boolean;
  onToggleSidebar?: () => void;
  activeProduct?: ProductItem;
  activeSessionTitle?: string;
  onOpenSessionManager?: () => void;
  onCreateNewWorkspace?: () => void;
}

interface ReadinessState {
  yunwu: boolean;
  seedance: boolean;
  ffmpeg: boolean;
  minio: boolean;
  publicBase: boolean;
  hasPublicStorage: boolean;
  notes: string[];
}

export const Navbar: React.FC<NavbarProps> = ({
  isSidebarExpanded,
  onToggleSidebar,
  activeProduct,
  activeSessionTitle,
  onOpenSessionManager,
  onCreateNewWorkspace,
}) => {
  const [readiness, setReadiness] = useState<ReadinessState | null>(null);
  const [dismissPublicTip, setDismissPublicTip] = useState(() => {
    try {
      return sessionStorage.getItem('aigc_dismiss_public_tip') === '1';
    } catch {
      return false;
    }
  });
  const [dismissFfmpegTip, setDismissFfmpegTip] = useState(() => {
    try {
      return sessionStorage.getItem('aigc_dismiss_ffmpeg_tip') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health?probe=1')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json?.readiness) return;
        const r = json.readiness;
        setReadiness({
          yunwu: Boolean(r.yunwu?.configured),
          seedance: Boolean(
            r.seedance?.ready === true ||
              (r.seedance?.configured && r.seedance?.tokenOk === true)
          ),
          ffmpeg: Boolean(r.ffmpeg?.installed),
          minio: Boolean(r.minio?.configured),
          publicBase: Boolean(r.publicBaseUrl),
          hasPublicStorage: Boolean(r.hasPublicStorage || r.publicBaseUrl || r.minio?.configured),
          notes: Array.isArray(r.notes) ? r.notes : [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setReadiness({
            yunwu: false,
            seedance: false,
            ffmpeg: false,
            minio: false,
            publicBase: false,
            hasPublicStorage: false,
            notes: ['无法连接后端 /api/health'],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allCoreOk = readiness && readiness.yunwu && readiness.seedance && readiness.ffmpeg && readiness.hasPublicStorage;
  const title =
    readiness?.notes?.length
      ? readiness.notes.join('\n')
      : allCoreOk
        ? '云雾 / Seedance / FFmpeg / MinIO 就绪'
        : '点击查看引擎状态';

  const showPublicTip = readiness && !readiness.hasPublicStorage && !dismissPublicTip;
  const showFfmpegTip = readiness && readiness.ffmpeg === false && !dismissFfmpegTip;

  return (
    <header className="sticky top-0 z-20 bg-white/90 backdrop-blur-md border-b border-slate-200/80 text-slate-900 transition-all select-none">
      <div className="px-4 lg:px-8 py-3 flex items-center justify-between gap-4">
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
              {activeSessionTitle && onOpenSessionManager && (
                <button
                  onClick={onOpenSessionManager}
                  className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200/80 transition-colors flex items-center gap-1.5 cursor-pointer max-w-[200px] sm:max-w-[260px] truncate"
                  title="点击管理/切换工作区会话"
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  <span className="truncate">工作区: {activeSessionTitle}</span>
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500 hidden lg:block mt-0.5">
              短视频解析 → 静态Prompt → 运镜轨迹 → 爆款文案 → BGM卡点 → 合成导出
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {onCreateNewWorkspace && (
            <button
              onClick={onCreateNewWorkspace}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-2xs transition-all flex items-center gap-1 cursor-pointer"
              title="新建全新的工作区草稿"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建工作区</span>
            </button>
          )}

          {onOpenSessionManager && (
            <button
              onClick={onOpenSessionManager}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200/80 shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
              title="查看与加载历史会话"
            >
              <ListTodo className="w-3.5 h-3.5 text-blue-600" />
              <span>历史会话</span>
            </button>
          )}

          {activeProduct && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100/80 border border-slate-200/80 text-slate-800 text-xs font-medium">
              <PackageCheck className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="text-slate-500 text-[11px] hidden sm:inline">商品:</span>
              <span className="truncate max-w-[120px] md:max-w-[180px] text-slate-900 font-semibold">
                {activeProduct.name}
              </span>
            </div>
          )}

          {/* Dark mode toggle for perfect UX */}
          <button
            onClick={() => {
              const isDark = document.documentElement.classList.contains('dark');
              if (isDark) {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('theme', 'light');
              } else {
                document.documentElement.classList.add('dark');
                localStorage.setItem('theme', 'dark');
              }
            }}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            title="切换深色模式"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 17.657l-.707-.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M17.657 17.657l.707-.707M17.657 6.343l.707-.707M4 12H3" />
            </svg>
          </button>

          <div
            className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border ${
              !readiness
                ? 'border-slate-200 bg-slate-50 text-slate-500'
                : allCoreOk
                  ? 'border-emerald-200/80 bg-emerald-50 text-emerald-700'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}
            title={title}
          >
            {allCoreOk ? (
              <Zap className="w-3.5 h-3.5 fill-emerald-600 text-emerald-600" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            )}
            <span>
              {!readiness
                ? '检测引擎…'
                : allCoreOk
                  ? '引擎就绪'
                  : `部分未就绪 · 云雾${readiness.yunwu ? '✓' : '✗'} Seedance${readiness.seedance ? '✓' : '✗'} FFmpeg${readiness.ffmpeg ? '✓' : '✗'} MinIO${
                      readiness.minio ? '✓' : readiness.publicBase ? ' (BaseURL)' : '✗'
                    }`}
            </span>
          </div>
        </div>
      </div>

      {(showPublicTip || showFfmpegTip) && (
        <div className="px-4 lg:px-8 pb-2.5 space-y-2">
          {showPublicTip && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-sky-50 border border-sky-200 text-sky-900 text-[11px] leading-relaxed">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sky-600" />
              <p className="flex-1">
                <strong className="font-bold">图生视频存储提示：</strong>
                未检测到 MinIO 对象存储或{' '}
                <code className="px-1 py-0.5 rounded bg-white border border-sky-100 font-mono text-[10px]">
                  PUBLIC_BASE_URL
                </code>
                。建议通过 Docker 运行 MinIO 容器或在 <code className="font-mono text-[10px]">.env</code> 配置存储。
              </p>
              <button
                type="button"
                className="p-0.5 rounded hover:bg-sky-100 text-sky-600 shrink-0"
                title="本次会话不再显示"
                onClick={() => {
                  setDismissPublicTip(true);
                  try {
                    sessionStorage.setItem('aigc_dismiss_public_tip', '1');
                  } catch {
                    /* ignore */
                  }
                }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {showFfmpegTip && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-violet-50 border border-violet-200 text-violet-950 text-[11px] leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-violet-600" />
              <p className="flex-1">
                <strong className="font-bold">成片合成提示：</strong>
                未检测到系统 FFmpeg。Step5 成片渲染与导出需要本机安装 FFmpeg 并加入 PATH。
                Windows 可用{' '}
                <code className="px-1 py-0.5 rounded bg-white border border-violet-100 font-mono text-[10px]">
                  winget install FFmpeg
                </code>
                ，安装后重启 <code className="font-mono text-[10px]">npm run dev</code>。
              </p>
              <button
                type="button"
                className="p-0.5 rounded hover:bg-violet-100 text-violet-600 shrink-0"
                title="本次会话不再显示"
                onClick={() => {
                  setDismissFfmpegTip(true);
                  try {
                    sessionStorage.setItem('aigc_dismiss_ffmpeg_tip', '1');
                  } catch {
                    /* ignore */
                  }
                }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
};

/**
 * S2 保存状态徽章：SaveState 四态 + 「任务可安全离开」+ 服务端 phase/耗时/重试/失败原因。
 * 文案与状态机来自 shared/workbench-contract（单一来源）。
 */
import React from 'react';
import { CheckCircle2, CloudOff, Loader2, TriangleAlert } from 'lucide-react';
import {
  SAVE_STATE_LABELS,
  type SaveState,
} from '../../shared/workbench-contract';

interface SaveStateBadgeProps {
  saveState: SaveState;
  safeToLeave: boolean;
  serverPhase?: string | null;
  elapsedMs?: number;
  retryCount?: number;
  failureReason?: string | null;
  onRetrySave?: () => void;
  // --- P3：成本与等待透明 ---
  estimatedCostUsd?: number | 'unknown';
  incurredCostUsd?: number | 'unknown';
  waitEstimate?: { minSec: number; maxSec: number } | null;
  qaProgress?: { passed: number; total: number };
}

function formatElapsed(ms: number): string {
  if (!ms || ms <= 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest}s`;
}

export const SaveStateBadge: React.FC<SaveStateBadgeProps> = ({
  saveState,
  safeToLeave,
  serverPhase,
  elapsedMs,
  retryCount,
  failureReason,
  onRetrySave,
  estimatedCostUsd,
  incurredCostUsd,
  waitEstimate,
  qaProgress,
}) => {
  const icon =
    saveState === 'saving' ? (
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
    ) : saveState === 'saved' ? (
      <CheckCircle2 className="w-3.5 h-3.5" />
    ) : saveState === 'offline_retry' ? (
      <CloudOff className="w-3.5 h-3.5" />
    ) : (
      <TriangleAlert className="w-3.5 h-3.5" />
    );

  const colorClass =
    saveState === 'saved'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : saveState === 'saving'
        ? 'bg-blue-50 text-blue-700 border-blue-200'
        : saveState === 'offline_retry'
          ? 'bg-rose-50 text-rose-700 border-rose-200'
          : 'bg-amber-50 text-amber-700 border-amber-200';

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="save-state-badge">
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold ${colorClass}`}
        title={`SaveState: ${saveState}`}
      >
        {icon}
        <span>{SAVE_STATE_LABELS[saveState]}</span>
      </span>
      {saveState === 'offline_retry' && onRetrySave && (
        <button
          onClick={onRetrySave}
          className="px-2 py-1 rounded-lg border border-rose-200 bg-white text-rose-600 text-xs font-semibold hover:bg-rose-50"
        >
          重试保存
        </button>
      )}
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-medium ${
          safeToLeave
            ? 'bg-slate-50 text-slate-600 border-slate-200'
            : 'bg-orange-50 text-orange-700 border-orange-200'
        }`}
        data-testid="safe-to-leave"
      >
        {safeToLeave ? '可安全离开（进度已保存）' : '有未保存修改，离开前请保存'}
      </span>
      {serverPhase && (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-medium">
          {serverPhase}
          {elapsedMs ? ` · 已耗时 ${formatElapsed(elapsedMs)}` : ''}
          {retryCount ? ` · 重试 ${retryCount} 次` : ''}
        </span>
      )}
      {failureReason && (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-xs font-medium">
          失败原因：{failureReason}
        </span>
      )}
      {/* P3：成本与等待透明 */}
      {estimatedCostUsd !== undefined && estimatedCostUsd !== 0 && (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-medium" data-testid="badge-estimated-cost">
          预估成本 {formatUsd(estimatedCostUsd)}
        </span>
      )}
      {incurredCostUsd !== undefined && incurredCostUsd !== 'unknown' && incurredCostUsd !== 0 && (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-medium" data-testid="badge-incurred-cost">
          已产生费用 {formatUsd(incurredCostUsd)}
        </span>
      )}
      {waitEstimate && (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-medium" data-testid="badge-wait-estimate">
          预计等待 {Math.ceil(waitEstimate.minSec / 60)}–{Math.ceil(waitEstimate.maxSec / 60)} 分钟
        </span>
      )}
      {qaProgress && qaProgress.total > 0 && (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-medium" data-testid="badge-qa-progress">
          质量检查 {qaProgress.passed}/{qaProgress.total}
        </span>
      )}
    </div>
  );
};

function formatUsd(value: number | 'unknown'): string {
  if (value === 'unknown') return 'unknown';
  return `$${value.toFixed(4)}`;
}

/**
 * S2 提交前预检面板（成本/余额/等待/能力/素材/减成本策略）：
 * - 逐镜预估成本 + 合计（unknown 明确显示 unknown，绝不显示 0）；
 * - 余额状态（无法验证时如实显示）；
 * - 预计等待区间 + 证据来源；
 * - 每镜模型能力匹配结果；
 * - 素材可达性/比例/时长/分辨率/参考输入数量；
 * - provider 不支持的策略禁用并解释（不展示假能力）；
 * - 每个 blocker 带证据与可执行修复动作。
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, Clock, Coins, Info, ShieldCheck } from 'lucide-react';
import type { PreflightResult } from '../../shared/workbench-contract';
import { formatUsd } from '../../shared/workbench-contract';

interface PreflightPanelProps {
  preflight: PreflightResult | null;
  loading?: boolean;
  onRun: () => void;
  onConfirmBatch: () => void;
  paidAuthEnabled: boolean;
  onTogglePaidAuth: (enabled: boolean) => void;
  canSubmit: boolean;
}

export const PreflightPanel: React.FC<PreflightPanelProps> = ({
  preflight,
  loading,
  onRun,
  onConfirmBatch,
  paidAuthEnabled,
  onTogglePaidAuth,
  canSubmit,
}) => {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white overflow-hidden" data-testid="preflight-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50/60">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-indigo-600" />
          <h3 className="text-sm font-bold text-slate-800">提交前预检</h3>
          {preflight && (
            <span
              className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                preflight.canSubmit
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-rose-50 text-rose-700 border border-rose-200'
              }`}
              data-testid="preflight-can-submit"
            >
              {preflight.canSubmit ? '可以提交' : `${preflight.blockers.length} 个阻断项`}
            </span>
          )}
        </div>
        <button
          onClick={onRun}
          disabled={loading}
          className="px-3 py-1.5 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 text-xs font-bold hover:bg-indigo-100 disabled:opacity-50"
          data-testid="run-preflight"
        >
          {loading ? '预检中…' : preflight ? '重新预检' : '运行预检'}
        </button>
      </div>

      {!preflight && (
        <div className="px-4 py-6 text-center text-xs text-slate-500">
          批量付费提交前先运行预检：能力、素材、成本、余额与等待预估全部可见后才允许提交。
        </div>
      )}

      {preflight && (
        <div className="p-4 space-y-4">
          {/* blockers / warnings */}
          {preflight.blockers.length > 0 && (
            <ul className="space-y-2" data-testid="preflight-blockers">
              {preflight.blockers.map((blocker) => (
                <li
                  key={blocker.code}
                  className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 text-xs"
                  data-testid={`blocker-${blocker.code}`}
                >
                  <div className="flex items-start gap-2">
                    <CircleAlert className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-rose-700">{blocker.message}</p>
                      <p className="text-[11px] text-slate-500 mt-1">
                        证据：<span className="font-mono">{blocker.evidence.source}</span> — {blocker.evidence.detail}
                      </p>
                      {blocker.fix && (
                        <p className="text-[11px] text-rose-600 font-semibold mt-1">
                          修复：{blocker.fix.label}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {preflight.warnings.length > 0 && (
            <ul className="space-y-1.5">
              {preflight.warnings.map((warning) => (
                <li key={warning.code} className="flex items-start gap-2 text-xs text-amber-700">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    {warning.message}
                    <span className="text-[11px] text-slate-400">（{warning.evidence.source}）</span>
                    {warning.fix && <span className="text-amber-600 font-semibold"> 修复：{warning.fix.label}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* 成本 */}
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-700 mb-2">
              <Coins className="w-4 h-4 text-emerald-600" /> 预估成本（USD）
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs">
              {preflight.cost.perShot.map((shot) => (
                <div key={shot.shotIndex} className="flex justify-between rounded-lg bg-slate-50 px-2.5 py-1.5">
                  <span className="text-slate-600">第 {shot.shotIndex} 镜（{shot.modelId}）</span>
                  <span className="font-bold text-slate-800" data-testid={`shot-cost-${shot.shotIndex}`}>
                    {formatUsd(shot.estimatedUsd)}
                  </span>
                </div>
              ))}
              <div className="flex justify-between rounded-lg bg-emerald-50 px-2.5 py-1.5 font-bold text-emerald-800 sm:col-span-2">
                <span>合计（逐镜相加）</span>
                <span data-testid="preflight-total-cost">{formatUsd(preflight.cost.totalEstimatedUsd)}</span>
              </div>
              <div className="flex justify-between rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] sm:col-span-2">
                <span className="text-slate-500">实际已发生成本</span>
                <span className="font-bold text-slate-700" data-testid="preflight-actual-cost">
                  {preflight.cost.unknownActual ? 'unknown（未出账单，绝不写 0）' : formatUsd(preflight.cost.actualUsd)}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5">依据：{preflight.cost.evidenceSource}</p>
          </div>

          {/* 余额 + 等待 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-700 mb-1.5">
                <ShieldCheck className="w-4 h-4 text-indigo-500" /> 余额
              </div>
              {preflight.balance.verified ? (
                <p className="text-xs text-slate-700" data-testid="balance-status">
                  余额 {formatUsd(preflight.balance.balanceUsd)}
                  {preflight.balance.shortfallUsd !== 'unknown' && preflight.balance.shortfallUsd > 0
                    ? `，差额 ${formatUsd(preflight.balance.shortfallUsd)}`
                    : ''}
                </p>
              ) : (
                <p className="text-xs text-amber-700 font-semibold" data-testid="balance-status">
                  无法验证余额（{preflight.balance.provider}）——请自行确认额度
                </p>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-700 mb-1.5">
                <Clock className="w-4 h-4 text-blue-500" /> 预计等待
              </div>
              <p className="text-xs text-slate-700" data-testid="wait-estimate">
                {Math.floor(preflight.wait.minSec / 60)}–{Math.floor(preflight.wait.maxSec / 60)} 分钟
              </p>
              <p className="text-[10px] text-slate-400 mt-1">证据来源：{preflight.wait.evidenceSource}</p>
            </div>
          </div>

          {/* 能力匹配 */}
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-700 mb-2">
              <Info className="w-4 h-4 text-slate-500" /> 每镜模型能力匹配
            </div>
            <ul className="space-y-1">
              {preflight.capability.map((cap) => (
                <li key={cap.shotIndex} className="flex items-start gap-2 text-xs">
                  {cap.supported ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                  ) : (
                    <CircleAlert className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                  )}
                  <span className="text-slate-700">
                    第 {cap.shotIndex} 镜 · {cap.modelId}：{cap.supported ? '满足约束' : cap.reason || '不满足约束'}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 素材 */}
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="text-xs font-bold text-slate-700 mb-2">素材预检（可达性/比例/时长/分辨率/参考输入）</div>
            <ul className="space-y-1">
              {preflight.materials.length === 0 && (
                <li className="text-xs text-slate-500">未检测到候选首帧素材</li>
              )}
              {preflight.materials.map((material) => (
                <li key={material.url} className="flex items-start gap-2 text-xs">
                  {material.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                  ) : (
                    <CircleAlert className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                  )}
                  <span className="text-slate-700 break-all">
                    {material.url} — {material.detail}
                    {material.aspectRatio ? ` · ${material.aspectRatio}` : ''}
                    {material.durationSec ? ` · ${material.durationSec}s` : ''}
                    {material.resolution ? ` · ${material.resolution}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 减成本策略 */}
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="text-xs font-bold text-slate-700 mb-2">减成本策略</div>
            <ul className="space-y-1">
              {preflight.strategies.map((strategy) => (
                <li key={strategy.id} className="flex items-start gap-2 text-xs">
                  {strategy.supported ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                  ) : (
                    <span className="text-slate-400 mt-0.5">✕</span>
                  )}
                  <span className={strategy.supported ? 'text-slate-700' : 'text-slate-400'}>
                    {strategy.label}
                    {!strategy.supported && strategy.reason && (
                      <span className="text-[11px]">（不支持：{strategy.reason}）</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 提交区 */}
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                role="switch"
                aria-checked={paidAuthEnabled}
                aria-label="允许 AI 自动提交付费生成"
                onClick={() => onTogglePaidAuth(!paidAuthEnabled)}
                className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${
                  paidAuthEnabled ? 'bg-indigo-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    paidAuthEnabled ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </button>
              <div className="text-xs">
                <p className="font-bold text-slate-800">允许 AI 自动提交付费生成</p>
                <p className="text-[11px] text-slate-500">关闭时批量提交会被拒绝（独立授权，默认关闭）</p>
              </div>
            </div>
            <button
              onClick={onConfirmBatch}
              disabled={!preflight.canSubmit || !paidAuthEnabled}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-bold"
              data-testid="confirm-batch-submit"
              title={
                !paidAuthEnabled
                  ? '需要先开启「允许 AI 自动提交付费生成」'
                  : !preflight.canSubmit
                    ? '预检存在阻断项，无法提交'
                    : '提交全部待生成镜头'
              }
            >
              确认并批量提交
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

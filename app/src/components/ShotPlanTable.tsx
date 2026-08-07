/**
 * S2 分镜计划表（拆片/分镜确认点）：
 * - 时间码/景别/机位/运镜/光线/台词/音效/保留项/替换项（产品语言展示，JSON/prompt 默认折叠）；
 * - 每镜状态、blocker/warning、候选选择、prompt 局部编辑；
 * - 确认分镜计划 → workbench.confirm('shot_plan')（受自主模式驱动）；
 * - 单镜失败可局部重试（retryShot），成功镜头不回滚。
 */
import React, { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Video,
  Wand2,
  History,
} from 'lucide-react';
import type { ShotPlanShot } from '../../shared/workbench-contract';
import { useWorkbench } from '../hooks/useWorkbench';

interface ShotPlanTableProps {
  shots: ShotPlanShot[];
  sessionId: string | null;
  runId?: string | null;
  /** 分镜计划已确认（服务端 confirms.shot_plan） */
  confirmed: boolean;
  onShotsChanged?: (shots: ShotPlanShot[]) => void;
  onConfirmPlan?: () => void;
  /** 批量提交前的预检入口 */
  onRequestPreflight?: () => void;
  canConfirm: boolean;
}

const SHOT_SIZE_LABELS: Record<string, string> = {
  extreme_wide: '大远景',
  wide: '全景',
  medium: '中景',
  close_up: '特写',
  extreme_close_up: '大特写',
  unknown: '未知',
};

export const ShotPlanTable: React.FC<ShotPlanTableProps> = ({
  shots,
  sessionId,
  runId,
  confirmed,
  onShotsChanged,
  onConfirmPlan,
  onRequestPreflight,
  canConfirm,
}) => {
  const workbench = useWorkbench();
  const [expandedShot, setExpandedShot] = useState<number | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<number | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [retryingShotId, setRetryingShotId] = useState<string | null>(null);

  const runtimeByIndex = new Map(
    (workbench.state?.shotStates || []).map((s) => [s.shotIndex, s])
  );

  const updateShot = (shotIndex: number, patch: Partial<ShotPlanShot>) => {
    if (!onShotsChanged) return;
    onShotsChanged(shots.map((s) => (s.shotIndex === shotIndex ? { ...s, ...patch } : s)));
  };

  const handleConfirmPlan = async () => {
    if (onConfirmPlan) {
      onConfirmPlan();
      return;
    }
    if (!sessionId) return;
    await workbench.confirm('shot_plan');
  };

  const handleRetry = async (shot: ShotPlanShot) => {
    const runtime = runtimeByIndex.get(shot.shotIndex);
    const shotId = runtime?.shotId;
    if (!shotId || !sessionId) return;
    setRetryingShotId(shotId);
    try {
      const attempt =
        Math.max(1, ((workbench.state?.shotStates || []).find((s) => s.shotIndex === shot.shotIndex)?.attempt || 0) + 1);
      await workbench.retryShot({
        shotId,
        attempt,
        failureReason: runtime?.failureReason || 'provider_error',
        promptOverride: shot.promptOverride,
      });
    } finally {
      setRetryingShotId(null);
    }
  };

  if (shots.length === 0) return null;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white overflow-hidden" data-testid="shot-plan-table">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50/60">
        <div className="flex items-center gap-2">
          <Video className="w-4 h-4 text-indigo-600" />
          <h3 className="text-sm font-bold text-slate-800">分镜计划（{shots.length} 镜）</h3>
          {confirmed && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold">
              <CheckCircle2 className="w-3 h-3" /> 已确认
            </span>
          )}
        </div>
        {!confirmed && canConfirm && (
          <button
            onClick={() => void handleConfirmPlan()}
            className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold"
            data-testid="confirm-shot-plan"
          >
            确认分镜计划
          </button>
        )}
        {onRequestPreflight && (
          <button
            onClick={onRequestPreflight}
            className="px-3 py-1.5 rounded-xl border border-slate-300 bg-white text-slate-700 text-xs font-bold hover:bg-slate-50"
            data-testid="request-preflight"
          >
            提交前预检
          </button>
        )}
      </div>

      {/* 表头（桌面） */}
      <div className="hidden md:grid grid-cols-[44px_1fr_1fr_1fr_1fr_1fr_auto] gap-2 px-4 py-2 border-b border-slate-100 bg-white text-[11px] font-bold text-slate-500 uppercase tracking-wide">
        <span>#</span>
        <span>时间码</span>
        <span>景别 / 机位</span>
        <span>运镜 / 光线</span>
        <span>台词 / 音效</span>
        <span>保留 / 替换</span>
        <span>状态</span>
      </div>

      <ul>
        {shots.map((shot) => {
          const runtime = runtimeByIndex.get(shot.shotIndex);
          const status = runtime?.status || shot.status;
          const isFailed = status === 'failed';
          const isCompleted = status === 'completed';
          const expanded = expandedShot === shot.shotIndex;
          return (
            <li key={shot.shotIndex} className="border-b border-slate-100 last:border-0">
              <button
                onClick={() => setExpandedShot(expanded ? null : shot.shotIndex)}
                className="w-full grid grid-cols-[44px_1fr_1fr] md:grid-cols-[44px_1fr_1fr_1fr_1fr_1fr_auto] gap-2 px-4 py-2.5 text-left hover:bg-slate-50 text-xs items-center"
                aria-expanded={expanded}
                data-testid={`shot-row-${shot.shotIndex}`}
              >
                <span className="font-bold text-slate-500">#{shot.shotIndex}</span>
                <span className="text-slate-700 font-medium">
                  {formatTime(shot.startTime)} – {formatTime(shot.endTime)}
                </span>
                <span className="text-slate-700 truncate">
                  {SHOT_SIZE_LABELS[shot.shotSize] || shot.shotSize}
                  {shot.cameraPosition ? ` · ${shot.cameraPosition}` : ''}
                </span>
                <span className="text-slate-600 truncate hidden md:block">
                  {shot.cameraMovement || '—'}
                  {shot.lighting ? ` · ${shot.lighting}` : ''}
                </span>
                <span className="text-slate-600 truncate hidden md:block">
                  {shot.dialogue?.[0]?.text || '—'}
                  {shot.soundEffects?.length ? ` 🔊${shot.soundEffects.length}` : ''}
                </span>
                <span className="text-slate-600 truncate hidden md:block">
                  {shot.mustKeep?.length ? `留:${shot.mustKeep.join('/')}` : ''}
                  {shot.mustReplace?.length ? ` 换:${shot.mustReplace.join('/')}` : ''}
                </span>
                <span className="flex items-center gap-1">
                  {isFailed && <TriangleAlert className="w-3.5 h-3.5 text-rose-500" />}
                  <span
                    className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                      isCompleted
                        ? 'bg-emerald-50 text-emerald-700'
                        : isFailed
                          ? 'bg-rose-50 text-rose-700'
                          : status === 'generating' || status === 'submitted'
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {statusLabel(status)}
                  </span>
                  {/* P3：QA 状态徽章 */}
                  {isCompleted && runtime && (
                    <QaBadge runtime={runtime} />
                  )}
                </span>
              </button>

              {expanded && (
                <div className="px-4 pb-3 pt-1 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs bg-slate-50/40" data-testid={`shot-detail-${shot.shotIndex}`}>
                  <div className="space-y-1.5">
                    <p><b className="text-slate-500">机位：</b>{shot.cameraPosition || '—'}</p>
                    <p><b className="text-slate-500">运镜：</b>{shot.cameraMovement || '—'} <b className="text-slate-500 ml-2">光线：</b>{shot.lighting || '—'}</p>
                    <p><b className="text-slate-500">台词：</b>{shot.dialogue?.map((d) => d.text).join(' / ') || '—'}</p>
                    <p><b className="text-slate-500">音效：</b>{shot.soundEffects?.join('、') || '—'}</p>
                    <p><b className="text-slate-500">必须保留：</b>{shot.mustKeep?.join('、') || '—'}</p>
                    <p><b className="text-slate-500">必须替换：</b>{shot.mustReplace?.join('、') || '—'}</p>
                  </div>
                  <div className="space-y-2">
                    {/* 候选选择（高级，折叠时隐藏） */}
                    {shot.candidates.length > 1 && (
                      <div>
                        <b className="text-slate-500 block mb-1">选择该镜首帧候选：</b>
                        <div className="flex gap-2 flex-wrap">
                          {shot.candidates.map((candidate) => (
                            <label
                              key={candidate.id}
                              className={`cursor-pointer rounded-lg border px-2 py-1 ${
                                shot.selectedCandidateId === candidate.id
                                  ? 'border-indigo-400 bg-indigo-50'
                                  : 'border-slate-200'
                              }`}
                            >
                              <input
                                type="radio"
                                name={`shot-candidate-${shot.shotIndex}`}
                                checked={shot.selectedCandidateId === candidate.id}
                                onChange={() => updateShot(shot.shotIndex, { selectedCandidateId: candidate.id })}
                                className="sr-only"
                              />
                              <span className="text-[11px] font-semibold">候选 {candidate.id.slice(-4)}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* prompt 局部编辑（高级，默认折叠） */}
                    <details className="rounded-lg border border-slate-200 bg-white p-2">
                      <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
                        高级：编辑该镜生成参数（JSON/prompt 默认折叠）
                      </summary>
                      {editingPrompt === shot.shotIndex ? (
                        <div className="mt-2 space-y-2">
                          <textarea
                            value={promptDraft}
                            onChange={(e) => setPromptDraft(e.target.value)}
                            rows={3}
                            className="w-full rounded-lg border border-slate-300 p-2 text-[11px] font-mono"
                            aria-label={`第 ${shot.shotIndex} 镜 prompt`}
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                updateShot(shot.shotIndex, { promptOverride: promptDraft });
                                setEditingPrompt(null);
                              }}
                              className="px-2 py-1 rounded-lg bg-indigo-600 text-white text-[11px] font-bold"
                            >
                              应用修改
                            </button>
                            <button
                              onClick={() => setEditingPrompt(null)}
                              className="px-2 py-1 rounded-lg border border-slate-300 text-[11px] font-bold"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setEditingPrompt(shot.shotIndex);
                            setPromptDraft(shot.promptOverride || `镜头 ${shot.shotIndex} 默认生成 prompt`);
                          }}
                          className="mt-1 text-[11px] text-indigo-600 font-semibold"
                        >
                          {shot.promptOverride ? '已修改 · 点击编辑' : '编辑 prompt'}
                        </button>
                      )}
                    </details>
                    {/* 失败镜头局部重试 */}
                    {isFailed && (
                      <button
                        onClick={() => void handleRetry(shot)}
                        disabled={retryingShotId !== null || !sessionId}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-[11px] font-bold"
                        data-testid={`retry-shot-${shot.shotIndex}`}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        {retryingShotId ? '重试中…' : '仅重试该镜'}
                      </button>
                    )}
                    {isCompleted && (
                      <p className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> 已生成成功，不会因其他镜头失败回滚
                      </p>
                    )}
                    {isFailed && runtime?.failureReason && (
                      <p className="text-[11px] text-rose-500">失败原因：{runtime.failureReason}</p>
                    )}
                    {/* P3：质量闭环面板 */}
                    {isCompleted && runtime && (
                      <ShotQaPanel shot={shot} runtime={runtime} />
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {!confirmed && !canConfirm && (
        <div className="px-4 py-3 bg-amber-50 border-t border-amber-100 text-xs text-amber-700 flex items-center gap-2">
          <TriangleAlert className="w-4 h-4 shrink-0" />
          请先完成拆解并保存分镜草稿，再确认分镜计划
        </div>
      )}
    </div>
  );
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'generating':
      return '生成中';
    case 'submitted':
      return '已提交';
    case 'cancelled':
      return '已取消';
    default:
      return '待生成';
  }
}

// ==================== P3 质量闭环 UI ====================

/** QA 状态徽章（行内小圆点） */
function QaBadge({ runtime }: { runtime: any }) {
  const verdict = runtime.semanticVerdict;
  const manualPassed = runtime.manualPassed;

  if (manualPassed) {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-bold"
        title="人工通过"
        data-testid={`qa-manual-pass-${runtime.shotIndex}`}
      >
        <ShieldCheck className="w-3 h-3" /> 人工通过
      </span>
    );
  }
  if (verdict === 'fail') {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-bold" title="语义 QA 不合格">
        <TriangleAlert className="w-3 h-3" /> 不合格
      </span>
    );
  }
  if (verdict === 'warning') {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300 text-[10px] font-bold" title="语义 QA 有风险">
        <TriangleAlert className="w-3 h-3" /> 有风险
      </span>
    );
  }
  if (verdict === 'unverified') {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 text-[10px] font-bold" title="语义 QA 未验证">
        未验证
      </span>
    );
  }
  if (verdict === 'pass') {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-300 text-[10px] font-bold" title="语义 QA 通过">
        <CheckCircle2 className="w-3 h-3" /> QA 通过
      </span>
    );
  }
  return null;
}

/** 镜头质量闭环面板：问题 → 建议 → 修复动作 + 版本比较 */
function ShotQaPanel({ shot, runtime }: { shot: ShotPlanShot; runtime: any }) {
  const workbench = useWorkbench();
  const [busy, setBusy] = useState<string | null>(null);
  const [qaResult, setQaResult] = useState<any>(null);
  const [showVersions, setShowVersions] = useState(false);

  const runQa = async () => {
    setBusy('qa');
    try {
      const result = await workbench.qaShot(runtime.shotId);
      setQaResult(result);
    } catch (e: any) {
      setQaResult({ error: e?.message || 'QA 失败' });
    } finally {
      setBusy(null);
    }
  };

  const runFix = async () => {
    setBusy('fix');
    try {
      await workbench.fixShot(runtime.shotId);
    } catch (e: any) {
      setQaResult({ error: e?.message || '修复失败' });
    } finally {
      setBusy(null);
    }
  };

  const manualPass = async () => {
    setBusy('manual');
    try {
      await workbench.manualPass(runtime.shotId, '人工确认当前版本可用');
    } catch (e: any) {
      setQaResult({ error: e?.message || '人工通过失败' });
    } finally {
      setBusy(null);
    }
  };

  const issues = qaResult?.issues || [];
  const verdict = qaResult?.overallVerdict || runtime.semanticVerdict;
  const summary = qaResult?.summary || runtime.qaSummary;

  return (
    <div
      className="mt-2 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 space-y-2"
      data-testid={`shot-qa-panel-${shot.shotIndex}`}
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-indigo-600" />
          <b className="text-[12px] text-slate-700">质量检查</b>
          {summary && (
            <span className="text-[11px] text-slate-500">· {summary}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => void runQa()}
            disabled={busy !== null}
            className="px-2 py-1 rounded-lg border border-indigo-300 bg-white text-indigo-700 text-[11px] font-bold hover:bg-indigo-50 disabled:opacity-50"
            data-testid={`qa-shot-${shot.shotIndex}`}
          >
            {busy === 'qa' ? '检查中…' : '执行检查'}
          </button>
          {runtime.autoFixCount < 2 && verdict === 'fail' && !runtime.manualPassed && (
            <button
              onClick={() => void runFix()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-600 text-white text-[11px] font-bold hover:bg-indigo-500 disabled:opacity-50"
              data-testid={`fix-shot-${shot.shotIndex}`}
            >
              <Wand2 className="w-3 h-3" />
              自动修复（{runtime.autoFixCount}/2）
            </button>
          )}
          {verdict === 'fail' && !runtime.manualPassed && (
            <button
              onClick={() => void manualPass()}
              disabled={busy !== null}
              className="px-2 py-1 rounded-lg border border-emerald-300 bg-white text-emerald-700 text-[11px] font-bold hover:bg-emerald-50 disabled:opacity-50"
              data-testid={`manual-pass-${shot.shotIndex}`}
            >
              人工通过
            </button>
          )}
          <button
            onClick={() => setShowVersions(!showVersions)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-300 bg-white text-slate-600 text-[11px] font-bold hover:bg-slate-50"
            data-testid={`versions-toggle-${shot.shotIndex}`}
          >
            <History className="w-3 h-3" />
            {runtime.versions?.length ? `${runtime.versions.length} 个版本` : '版本'}
          </button>
        </div>
      </div>

      {qaResult?.error && (
        <p className="text-[11px] text-rose-600">{qaResult.error}</p>
      )}

      {/* 问题列表：问题 → 建议 → 修复动作 */}
      {issues.length > 0 && (
        <ul className="space-y-1.5" data-testid={`qa-issues-${shot.shotIndex}`}>
          {issues
            .filter((i: any) => i.verdict !== 'pass')
            .map((issue: any) => (
              <li
                key={issue.dimension}
                className={`rounded-lg border px-2 py-1.5 text-[11px] ${
                  issue.verdict === 'fail'
                    ? 'border-rose-200 bg-rose-50 text-rose-800'
                    : issue.verdict === 'warning'
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-slate-200 bg-slate-50 text-slate-600'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <b>{dimensionLabel(issue.dimension)}</b>
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                    issue.verdict === 'fail' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {issue.verdict === 'fail' ? '不合格' : '有风险'}
                  </span>
                </div>
                <p className="mt-0.5 text-slate-600">原因：{issue.reason || '—'}</p>
                {issue.fixAction && (
                  <p className="mt-0.5 text-indigo-700 font-medium">建议：{issue.fixAction}</p>
                )}
              </li>
            ))}
        </ul>
      )}

      {/* 版本比较 */}
      {showVersions && runtime.versions?.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-2 space-y-1.5" data-testid={`versions-${shot.shotIndex}`}>
          <b className="text-[11px] text-slate-600 block">版本比较（点击选择使用）</b>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {runtime.versions.map((v: any) => (
              <div key={v.versionId} className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    setBusy('version');
                    void workbench.useVersion(runtime.shotId, v.versionId).finally(() => setBusy(null));
                  }}
                  disabled={busy !== null}
                  className="flex-1 text-left rounded-lg border border-slate-200 px-2 py-1 text-[11px] hover:bg-indigo-50 disabled:opacity-50"
                  data-testid={`use-version-${shot.shotIndex}-${v.version}`}
                >
                  <div className="flex items-center justify-between">
                    <b className="text-slate-700">v{v.version}</b>
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                      v.verdict === 'pass' ? 'bg-emerald-100 text-emerald-700'
                      : v.verdict === 'fail' ? 'bg-rose-100 text-rose-700'
                      : 'bg-slate-100 text-slate-500'
                    }`}>
                      {v.verdict === 'pass' ? '通过' : v.verdict === 'fail' ? '不合格' : '未验证'}
                    </span>
                  </div>
                  {v.videoUrl && (
                    <span className="block truncate text-[10px] text-slate-400 mt-0.5">{v.videoUrl}</span>
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {showVersions && !runtime.versions?.length && (
        <p className="text-[11px] text-slate-500">暂无版本记录</p>
      )}
    </div>
  );
}

function dimensionLabel(dim: string): string {
  const labels: Record<string, string> = {
    product_consistency: '产品一致性',
    competitor_residue: '竞品残留',
    shot_structure_coverage: '镜头结构覆盖',
    hook_quality: 'Hook 质量',
    subject_deformation: '主体形变',
    cross_shot_continuity: '跨镜连续性',
    av_sync: '音画同步',
    compliance_risk: '合规风险',
  };
  return labels[dim] || dim;
}

export { ChevronDown, ChevronUp };

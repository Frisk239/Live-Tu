/**
 * S2 前端工作台控制器（hook）：恢复 / 保存 / 局部重试 / 确认 / 预检
 *
 * - SaveState 状态机：saving → saved；本地编辑 → dirty；保存失败 → offline_retry（保留旧数据 + 可重试）；
 * - 自主模式切换绝不改动付费授权（服务端同样强制）；
 * - 「允许 AI 自动提交付费生成」独立开关，默认关闭；
 * - beforeunload 守卫：dirty / offline_retry / 任务执行中离开前提醒；
 * - 恢复：登录/刷新后 getState 拉取服务端真实状态（run/shot/SaveState）；
 * - API 故障保留最后成功数据（lastGoodState），不闪错误空态。
 *
 * 契约类型全部来自 shared/workbench-contract（单一来源）。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiService } from '../services/api';
import {
  SAVE_STATE_LABELS,
  type AutonomyMode,
  type ConfirmType,
  type PreflightResult,
  type RetryShotResult,
  type SaveState,
  type WorkbenchState,
} from '../../shared/workbench-contract';

export interface WorkbenchDraft {
  /** 分镜计划（含局部编辑/候选选择） */
  shots?: unknown[];
  videoModelId?: string;
  referenceInputCount?: number;
  /** 当前产品 id：服务端按 product_assets 真实计数（Spec2，忽略 referenceInputCount 硬编码） */
  productId?: string;
  /** P5 派生上下文（系统从爆款视频提取的参考关键帧）：前端重建草稿时必须透传，
   *  否则覆盖服务端草稿会丢掉派生上下文 → 预检 first_frame_missing / 派生失败 */
  referenceKeyframes?: string[];
  /** 产品图（包装参考） */
  productAssetUrls?: string[];
}

export interface WorkbenchContextValue {
  /** 服务端持久化的工作台状态（null = 尚未加载/未登录） */
  state: WorkbenchState | null;
  /** 最后成功状态：API 故障时保留旧数据（证据 #9） */
  lastGoodState: WorkbenchState | null;
  /** 恢复/保存是否出错 */
  error: string | null;
  lastErrorAt: number | null;
  loading: boolean;
  /** SaveState 状态机（前端本地视角 + 服务端持久化） */
  saveState: SaveState;
  setDraft: (draft: WorkbenchDraft) => void;
  saveDraft: (opts?: { draft?: WorkbenchDraft; saveState?: SaveState; autonomyMode?: AutonomyMode }) => Promise<boolean>;
  /** 确保已保存；保存失败返回 false —— 调用方必须阻止破坏性切换（证据 #8） */
  ensureSaved: () => Promise<boolean>;
  setAutonomyMode: (mode: AutonomyMode) => Promise<void>;
  togglePaidAuth: (enabled: boolean) => Promise<void>;
  confirm: (type: ConfirmType) => Promise<{ ok: boolean; preflight?: PreflightResult; error?: string }>;
  runPreflight: () => Promise<PreflightResult | null>;
  retryShot: (opts: { shotId: string; attempt: number; failureReason: string; promptOverride?: string | null }) => Promise<RetryShotResult | null>;
  cancel: () => Promise<void>;
  // --- P3 质量闭环 ---
  qaShot: (shotId: string) => Promise<any>;
  fixShot: (shotId: string, skipAutoFix?: boolean) => Promise<any>;
  manualPass: (shotId: string, comment?: string) => Promise<any>;
  useVersion: (shotId: string, versionId: string) => Promise<any>;
  getShotVersions: (shotId: string) => Promise<any[]>;
  recover: () => Promise<void>;
  /** 显式标记本地编辑（dirty） */
  markDirty: () => void;
  /** 与上下文绑定（runId/sessionId 由调用方传入） */
  bind: (opts: { runId?: string | null; sessionId?: string | null }) => void;
  context: { runId: string | null; sessionId: string | null };
  /** 当前自主模式（默认 managed） */
  autonomyMode: AutonomyMode;
  paidAuthEnabled: boolean;
  /** 可安全离开（服务端判定 && 本地无未保存修改） */
  safeToLeave: boolean;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export const useWorkbench = (): WorkbenchContextValue => {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error('useWorkbench 必须在 WorkbenchProvider 内使用');
  return ctx;
};

export function WorkbenchProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [lastGoodState, setLastGoodState] = useState<WorkbenchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastErrorAt, setLastErrorAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState<{ runId: string | null; sessionId: string | null }>({
    runId: null,
    sessionId: null,
  });
  const draftRef = useRef<WorkbenchDraft | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const lastGoodStateRef = useRef<WorkbenchState | null>(null);

  const stateRef = useRef<WorkbenchState | null>(null);
  const applyState = useCallback((next: WorkbenchState) => {
    stateRef.current = next;
    setState(next);
    setLastGoodState(next);
    lastGoodStateRef.current = next;
  }, []);

  /** 生效上下文：bind 未完成时回退到服务端状态携带的 runId/sessionId（消除刷新恢复竞态） */
  const effectiveContext = {
    runId: context.runId ?? state?.runId ?? null,
    sessionId: context.sessionId ?? state?.sessionId ?? null,
  };

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setState((prev) => (prev ? { ...prev, saveState: 'dirty' } : prev));
  }, []);

  /** 恢复服务端真实状态（证据 #7：刷新/重启恢复） */
  const recover = useCallback(async () => {
    setLoading(true);
    try {
      const next = await apiService.workbench.getState(context);
      applyState(next);
      setError(null);
    } catch (e: any) {
      // API 故障：保留最后成功数据，只显示错误与重试入口（证据 #9）
      setError(e?.message || '工作台状态读取失败');
      setLastErrorAt(Date.now());
    } finally {
      setLoading(false);
    }
  }, [context, applyState]);

  useEffect(() => {
    void recover();
  }, [recover]);

  /** 保存草稿：saving → saved；失败 → offline_retry（保留旧数据） */
  const saveDraft = useCallback(
    async (opts?: { draft?: WorkbenchDraft; saveState?: SaveState; autonomyMode?: AutonomyMode }) => {
      // P1-1 修复：已有保存进行中时，本次调用明确返回 false（而非假装成功）。
      // 调用方（ensureSaved → 破坏性切换守卫）据此阻止切换；请求期间的新编辑
      // 由完成时的快照对比兜住（见下方 dirty 清理条件），绝不丢失。
      if (savingRef.current) return false;
      savingRef.current = true;
      setState((prev) => (prev ? { ...prev, saveState: 'saving' } : prev));
      // 快照本次请求携带的草稿：保存期间用户再次 setDraft 时引用会变，
      // 完成后只在此快照仍是最新草稿时才清 dirty（旧请求不得覆盖新编辑的 dirty 标记）。
      const snapshot = opts?.draft !== undefined ? opts.draft : draftRef.current;
      try {
        if (opts?.draft !== undefined) draftRef.current = opts.draft;
        const next = await apiService.workbench.saveDraft({
          runId: effectiveContext.runId,
          sessionId: effectiveContext.sessionId,
          draftJson: draftRef.current ? JSON.stringify(draftRef.current) : null,
          autonomyMode: opts?.autonomyMode,
          saveState: opts?.saveState ?? 'saved',
        });
        applyState(next);
        if (draftRef.current === snapshot) {
          dirtyRef.current = false;
        } else {
          // 保存期间有新编辑：保留 dirty 标记，UI 仍显示「未保存」（旧请求不得抹掉新编辑）
          dirtyRef.current = true;
          setState((prev) => (prev ? { ...prev, saveState: 'dirty' } : prev));
        }
        setError(null);
        return true;
      } catch (e: any) {
        // 保存失败：offline_retry，保留旧数据，不闪空态（证据 #8/#9）
        dirtyRef.current = true;
        setState((prev) => (prev ? { ...prev, saveState: 'offline_retry' } : prev));
        setError(e?.message || '保存失败');
        setLastErrorAt(Date.now());
        return false;
      } finally {
        savingRef.current = false;
      }
    },
    [context, applyState]
  );

  const setDraft = useCallback(
    (draft: WorkbenchDraft) => {
      draftRef.current = draft;
      // 与服务端已保存草稿内容一致时不标 dirty（避免保存成功后立刻又变 dirty）
      const serialized = JSON.stringify(draft);
      if (stateRef.current?.draftJson && stateRef.current.draftJson === serialized) return;
      markDirty();
    },
    [markDirty]
  );

  /** 破坏性切换前的保存守卫：失败必须阻止切换（证据 #8） */
  const ensureSaved = useCallback(async () => {
    if (!dirtyRef.current && !draftRef.current) return true;
    return saveDraft();
  }, [saveDraft]);

  const setAutonomyMode = useCallback(
    async (mode: AutonomyMode) => {
      try {
        const next = await apiService.workbench.setAutonomy({
          runId: effectiveContext.runId,
          sessionId: effectiveContext.sessionId,
          autonomyMode: mode,
        });
        applyState(next);
      } catch (e: any) {
        setError(e?.message || '切换自主模式失败');
        setLastErrorAt(Date.now());
      }
    },
    [effectiveContext, applyState]
  );

  const togglePaidAuth = useCallback(
    async (enabled: boolean) => {
      try {
        const next = await apiService.workbench.setPaidAuth({
          runId: effectiveContext.runId,
          sessionId: effectiveContext.sessionId,
          enabled,
        });
        applyState(next);
      } catch (e: any) {
        setError(e?.message || '更新付费授权失败');
        setLastErrorAt(Date.now());
      }
    },
    [effectiveContext, applyState]
  );

  const runPreflight = useCallback(async () => {
    try {
      return await apiService.workbench.runPreflight({
        runId: effectiveContext.runId,
        sessionId: effectiveContext.sessionId,
      });
    } catch (e: any) {
      setError(e?.message || '预检失败');
      setLastErrorAt(Date.now());
      return null;
    }
  }, [context]);

  const confirm = useCallback(
    async (type: ConfirmType) => {
      try {
        const result = await apiService.workbench.confirm({
          runId: effectiveContext.runId,
          sessionId: effectiveContext.sessionId,
          type,
        });
        applyState(result.state);
        if (type === 'batch_submit' && result.preflight) {
          return { ok: true, preflight: result.preflight };
        }
        return { ok: true };
      } catch (e: any) {
        setError(e?.message || '确认失败');
        setLastErrorAt(Date.now());
        return { ok: false, preflight: e?.preflight, error: e?.message };
      }
    },
    [effectiveContext, applyState]
  );

  const retryShot = useCallback(
    async (opts: { shotId: string; attempt: number; failureReason: string; promptOverride?: string | null }) => {
      try {
        const result = await apiService.workbench.retryShot({
          runId: effectiveContext.runId || effectiveContext.sessionId || '',
          ...opts,
        });
        // 刷新镜头状态
        const next = await apiService.workbench.getState(context);
        applyState(next);
        return result;
      } catch (e: any) {
        setError(e?.message || '重试镜头失败');
        setLastErrorAt(Date.now());
        return null;
      }
    },
    [effectiveContext, applyState]
  );

  const cancel = useCallback(async () => {
    try {
      const next = await apiService.workbench.cancel({
        runId: effectiveContext.runId,
        sessionId: effectiveContext.sessionId,
      });
      applyState(next);
    } catch (e: any) {
      setError(e?.message || '取消失败');
      setLastErrorAt(Date.now());
    }
  }, [context, applyState]);

  // --- P3 质量闭环方法 ---
  const refreshState = useCallback(async () => {
    const next = await apiService.workbench.getState({
      runId: effectiveContext.runId,
      sessionId: effectiveContext.sessionId,
    });
    applyState(next);
  }, [effectiveContext, applyState]);

  const qaShot = useCallback(async (shotId: string) => {
    const result = await apiService.workbench.qaShot({ runId: effectiveContext.runId || '', shotId });
    await refreshState();
    return result;
  }, [effectiveContext, refreshState]);

  const fixShot = useCallback(async (shotId: string, skipAutoFix = false) => {
    const result = await apiService.workbench.fixShot({ runId: effectiveContext.runId || '', shotId, skipAutoFix });
    await refreshState();
    return result;
  }, [effectiveContext, refreshState]);

  const manualPassMethod = useCallback(async (shotId: string, comment?: string) => {
    const result = await apiService.workbench.manualPass({ runId: effectiveContext.runId || '', shotId, comment });
    await refreshState();
    return result;
  }, [effectiveContext, refreshState]);

  const useVersionMethod = useCallback(async (shotId: string, versionId: string) => {
    const result = await apiService.workbench.useVersion({ runId: effectiveContext.runId || '', shotId, versionId });
    await refreshState();
    return result;
  }, [effectiveContext, refreshState]);

  const getShotVersions = useCallback(async (shotId: string) => {
    return apiService.workbench.getShotVersions(shotId);
  }, []);

  const bind = useCallback((opts: { runId?: string | null; sessionId?: string | null }) => {
    setContext((prev) => {
      const next = {
        runId: opts.runId !== undefined ? opts.runId : prev.runId,
        sessionId: opts.sessionId !== undefined ? opts.sessionId : prev.sessionId,
      };
      return next.runId === prev.runId && next.sessionId === prev.sessionId ? prev : next;
    });
  }, []);

  // beforeunload 守卫：dirty / offline_retry 时离开提醒（任务可安全离开的明确状态）
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const saveState: SaveState = state?.saveState ?? (dirtyRef.current ? 'dirty' : 'saved');
  const autonomyMode: AutonomyMode = state?.autonomyMode ?? 'managed';
  const paidAuthEnabled = state?.paidAuthorization?.enabled ?? false;
  const safeToLeave =
    (state?.safeToLeave ?? true) && saveState !== 'dirty' && saveState !== 'offline_retry';

  const value = useMemo<WorkbenchContextValue>(
    () => ({
      state,
      lastGoodState,
      error,
      lastErrorAt,
      loading,
      saveState,
      setDraft,
      saveDraft,
      ensureSaved,
      setAutonomyMode,
      togglePaidAuth,
      confirm,
      runPreflight,
      retryShot,
      cancel,
      qaShot,
      fixShot,
      manualPass: manualPassMethod,
      useVersion: useVersionMethod,
      getShotVersions,
      recover,
      markDirty,
      bind,
      context,
      autonomyMode,
      paidAuthEnabled,
      safeToLeave,
    }),
    [
      state, lastGoodState, error, lastErrorAt, loading, saveState,
      setDraft, saveDraft, ensureSaved, setAutonomyMode, togglePaidAuth,
      confirm, runPreflight, retryShot, cancel,
      qaShot, fixShot, manualPassMethod, useVersionMethod, getShotVersions,
      recover, markDirty, bind,
      context, autonomyMode, paidAuthEnabled, safeToLeave,
    ]
  );

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export { SAVE_STATE_LABELS };

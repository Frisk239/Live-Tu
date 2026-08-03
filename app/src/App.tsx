import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StepId, PipelineData, PresetTemplate, MaterialItem, TaskItem, ProductItem, WorkspaceSession } from './types';
import { ModelConfigState, DEFAULT_MODEL_CONFIG } from './data/models';
import { Navbar } from './components/Navbar';
import { Sidebar, MainViewType } from './components/Sidebar';
import { LoginScreen } from './components/LoginScreen';
import { StepProgress, AutoPipelineProgress } from './components/StepProgress';
import { OnboardingModal } from './components/OnboardingModal';
import { SessionManagerModal } from './components/SessionManagerModal';

import { PackageCheck, Edit3 } from 'lucide-react';
import { apiService, AuthUser, Permission, PipelineRunSnapshot } from './services/api';
import { NotificationViewport, notify } from './services/notifications';

const VIEW_READ_PERMISSIONS: Record<MainViewType, Permission> = {
  pipeline: 'module.pipeline.read',
  materials: 'module.materials.read',
  tasks: 'module.tasks.read',
  presets: 'module.presets.read',
  knowledge: 'module.knowledge.read',
  bgm: 'module.bgm.read',
  models: 'module.models.read',
};

const MaterialsPageView = React.lazy(() =>
  import('./views/MaterialsPageView').then((module) => ({ default: module.MaterialsPageView }))
);
const TasksPageView = React.lazy(() =>
  import('./views/TasksPageView').then((module) => ({ default: module.TasksPageView }))
);
const PresetsPageView = React.lazy(() =>
  import('./views/PresetsPageView').then((module) => ({ default: module.PresetsPageView }))
);
const ModelsPageView = React.lazy(() =>
  import('./views/ModelsPageView').then((module) => ({ default: module.ModelsPageView }))
);
const KnowledgePageView = React.lazy(() =>
  import('./views/KnowledgePageView').then((module) => ({ default: module.KnowledgePageView }))
);
const BgmPageView = React.lazy(() =>
  import('./views/BgmPageView').then((module) => ({ default: module.BgmPageView }))
);
const Step1Card = React.lazy(() =>
  import('./components/Step1Card').then((module) => ({ default: module.Step1Card }))
);
const Step2Card = React.lazy(() =>
  import('./components/Step2Card').then((module) => ({ default: module.Step2Card }))
);
const Step3Card = React.lazy(() =>
  import('./components/Step3Card').then((module) => ({ default: module.Step3Card }))
);
const Step4Card = React.lazy(() =>
  import('./components/Step4Card').then((module) => ({ default: module.Step4Card }))
);
const Step5Card = React.lazy(() =>
  import('./components/Step5Card').then((module) => ({ default: module.Step5Card }))
);

function createEmptyPipelineData(): PipelineData {
  return {
    step1: {
      status: 'pending',
      inputs: {
        mediaUrl: '',
        platform: 'xiaohongshu',
        bloggerType: 'daily_seeding',
        viralReason: '真实场景自然光+产品质感特写',
        textModel: 'Gemini 3.6 Flash',
        imageModel: 'GPT Image 1',
      },
    },
    step2: {
      status: 'pending',
      inputs: {
        static_image_prompt: '',
        imageUrl: '',
        videoTone: 'xiaohongshu_healing',
        durationSec: 4,
        textModel: 'Gemini 3.6 Flash',
        videoModel: 'Seedance 2.0 Fast',
      },
    },
    step3: {
      status: 'pending',
      inputs: {
        videoPrompt: '',
        targetPlatform: 'xiaohongshu',
        scriptPersona: '油皮亲妈',
        textModel: 'Gemini 3.6 Flash',
      },
    },
    step4: {
      status: 'pending',
      inputs: {
        copywritingTitle: '',
        tonePreference: '治愈',
        commercialScenario: '抖音/小红书商业化',
        textModel: 'Gemini 3.6 Flash',
      },
    },
    step5: {
      status: 'pending',
      inputs: {
        aspectRatio: '9:16',
        subtitleStyle: '黄字黑边',
      },
    },
  };
}

function clearUserScopedClientState(options?: { preserveActiveView?: boolean }) {
  const keys = [
    'aigc_active_view',
    'aigc_cached_current_step',
    'aigc_cached_pipeline_data',
    'aigc_draft_task_id',
    'aigc_active_pipeline_run_id',
  ];
  try {
    for (const key of keys) {
      if (options?.preserveActiveView && key === 'aigc_active_view') continue;
      localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable in private browsing; in-memory state is still cleared.
  }
}

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isAuthChecked, setIsAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const can = useCallback(
    (permission: Permission) => Boolean(authUser?.permissions.includes(permission)),
    [authUser]
  );

  useEffect(() => {
    let active = true;
    apiService.auth.me()
      .then((user) => {
        if (active) {
          setAuthUser(user);
          setIsLoggedIn(Boolean(user));
        }
      })
      .finally(() => {
        if (active) setIsAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Main Active View State (Persisted in localStorage to prevent reset to pipeline)
  const [activeView, setActiveView] = useState<MainViewType>(() => {
    try {
      const saved = localStorage.getItem('aigc_active_view') as MainViewType;
      if (saved && ['pipeline', 'materials', 'tasks', 'presets', 'models', 'knowledge', 'bgm'].includes(saved)) {
        return saved;
      }
    } catch {}
    return 'pipeline';
  });

  const resolveAllowedView = useCallback(
    (view: MainViewType): MainViewType =>
      can(VIEW_READ_PERMISSIONS[view]) ? view : 'pipeline',
    [can]
  );

  const handleSetActiveView = useCallback((view: MainViewType) => {
    const allowedView = resolveAllowedView(view);
    setActiveView(allowedView);
    try {
      localStorage.setItem('aigc_active_view', allowedView);
    } catch {}
    if (allowedView === 'tasks') {
      apiService.tasks.fetchTasks().then((list) => {
        if (list?.length) setTasks(list);
      }).catch(() => {});
      apiService.runs.list().then(setPipelineRuns).catch(() => {});
    }
  }, [resolveAllowedView]);

  useEffect(() => {
    if (!authUser) return;
    const allowedView = resolveAllowedView(activeView);
    if (allowedView === activeView) return;
    setActiveView(allowedView);
    try {
      localStorage.setItem('aigc_active_view', allowedView);
    } catch {}
  }, [activeView, authUser, resolveAllowedView]);

  // Sidebar Layout State
  const [sidebarWidth, setSidebarWidth] = useState<number>(240);
  const [isSidebarExpanded, setIsSidebarExpanded] = useState<boolean>(true);

  const handleSetSidebarWidth = (width: number) => {
    setSidebarWidth(width);
    if (width < 120) {
      setIsSidebarExpanded(false);
    } else {
      setIsSidebarExpanded(true);
    }
  };

  const handleToggleSidebar = () => {
    if (isSidebarExpanded) {
      setIsSidebarExpanded(false);
      setSidebarWidth(68);
    } else {
      setIsSidebarExpanded(true);
      setSidebarWidth(240);
    }
  };

  // Onboarding Guide State
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(false);

  // Pipeline & Simulation States (Synchronously hydrated from localStorage to prevent page jumps)
  const [currentStep, setCurrentStep] = useState<StepId>(() => {
    try {
      const saved = localStorage.getItem('aigc_cached_current_step');
      if (saved) {
        const step = Number(saved);
        if (step >= 1 && step <= 5) return step as StepId;
      }
    } catch {}
    return 1;
  });
  const [isAutoPipelineRunning, setIsAutoPipelineRunning] = useState<boolean>(false);
  const [autoProgress, setAutoProgress] = useState<AutoPipelineProgress | null>(null);

  // Products / Selling Points State
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [activeProductId, setActiveProductId] = useState<string>('');
  const activeProduct = products.find((p) => p.id === activeProductId) || products[0];

  // Presets state (fetched from API)
  const [presets, setPresets] = useState<PresetTemplate[]>([]);

  // Bootstrap all persistent resources from SQLite-backed APIs
  useEffect(() => {
    if (!isLoggedIn) return;
    let cancelled = false;

    // Never render another account's in-memory or browser-cached business state while
    // the new account is bootstrapping. Server data is the only source of truth.
    setProducts([]);
    setActiveProductId('');
    setMaterials([]);
    setTasks([]);
    setPipelineRuns([]);
    setPresets([]);
    setPipelineData(createEmptyPipelineData());
    setCurrentStep(1);
    setDraftTaskIdSynced('');
    setDraftSavedLabel(null);
    clearUserScopedClientState({ preserveActiveView: true });

    const bootstrap = async () => {
      try {
        const [productList, materialList, taskList, presetList, models] = await Promise.all([
          apiService.products.fetchProducts().catch((err) => {
            console.warn('[App] products fetch failed:', err);
            return [] as ProductItem[];
          }),
          apiService.materials.fetchMaterials().catch((err) => {
            console.warn('[App] materials fetch failed:', err);
            return [] as MaterialItem[];
          }),
          apiService.tasks.fetchTasks().catch((err) => {
            console.warn('[App] tasks fetch failed:', err);
            return [] as TaskItem[];
          }),
          apiService.presets.fetchPresets().catch((err) => {
            console.warn('[App] presets fetch failed:', err);
            return [] as PresetTemplate[];
          }),
          apiService.models.fetchModels().catch((err) => {
            console.warn('[App] models fetch failed:', err);
            return null;
          }),
        ]);

        if (cancelled) return;

        setProducts(productList);
        setActiveProductId(productList[0]?.id || '');
        setMaterials(materialList);
        setTasks(taskList);
        if (taskList.length > 0) {
          // Restore working draft if present
          const savedDraftId = localStorage.getItem('aigc_draft_task_id');
          if (savedDraftId) {
            const draft = taskList.find((t) => t.id === savedDraftId);
            if (draft?.pipelineData?.step1) {
              const sanitized = { ...draft.pipelineData };
              (['step1', 'step2', 'step3', 'step4', 'step5'] as const).forEach((sKey) => {
                if (sanitized[sKey] && sanitized[sKey].status === 'running') {
                  sanitized[sKey].status = sanitized[sKey].output ? 'completed' : 'pending';
                }
              });
              setPipelineData(sanitized);
              setCurrentStep((draft.currentStep as StepId) || 1);
              setDraftTaskIdSynced(draft.id);
            }
          }
        }
        setPresets(presetList);
        if (models && models.textModels) {
          setModelConfig({
            textModels: models.textModels || [],
            imageModels: models.imageModels || [],
            videoModels: models.videoModels || [],
            autoRecommendationEnabled: models.autoRecommendationEnabled ?? true,
            defaultTextModel: models.defaultTextModel || 'Gemini 3.6 Flash',
            defaultImageModel: models.defaultImageModel || 'GPT Image 1',
            defaultVideoModel: models.defaultVideoModel || 'Seedance 2.0 Fast',
          });
        }
      } catch (err) {
        console.warn('[App] bootstrap failed:', err);
      }
    };

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn]);

  const handleUpdateProducts = async (nextProducts: ProductItem[]) => {
    const prevIds = new Set(products.map((p) => p.id));
    const nextIds = new Set(nextProducts.map((p) => p.id));
    try {
      await Promise.all([
        ...products
          .filter((product) => !nextIds.has(product.id))
          .map((product) => apiService.products.deleteProduct(product.id)),
        ...nextProducts.map((product) =>
          prevIds.has(product.id)
            ? apiService.products.updateProduct(product.id, product)
            : apiService.products.createProduct(product)
        ),
      ]);
      setProducts(nextProducts);
    } catch (error: any) {
      notify(error?.message || '产品知识库保存失败，未应用更改', 'error');
    }
  };

  const [modelConfig, setModelConfig] = useState<ModelConfigState>(DEFAULT_MODEL_CONFIG);
  const safeActiveView = resolveAllowedView(activeView);

  // Materials & Tasks State
  const [materials, setMaterials] = useState<MaterialItem[]>([]);

  const handleDeleteMaterial = async (id: string) => {
    if (!window.confirm('确认删除该素材及其关联文件吗？此操作不可撤销。')) return;
    try {
      await apiService.materials.deleteMaterial(id);
      setMaterials((prev) => prev.filter((material) => material.id !== id));
      notify('素材已删除', 'success');
    } catch (error: any) {
      notify(error?.message || '素材删除失败', 'error');
    }
  };

  const [tasks, setTasks] = useState<WorkspaceSession[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunSnapshot[]>([]);
  const [isSessionManagerOpen, setIsSessionManagerOpen] = useState(false);

  const handleDeleteWorkspace = async (id: string) => {
    if (!window.confirm('确认删除该任务记录吗？此操作不可撤销。')) return;
    try {
      await apiService.tasks.deleteTask(id);
      setTasks((prev) => prev.filter((task) => task.id !== id));
      notify('任务记录已删除', 'success');
    } catch (err: any) {
      notify(err?.message || '任务删除失败', 'error');
    }
  };

  const handleDeleteTask = handleDeleteWorkspace;

  // Auto-draft: refresh-safe working copy with ref sync for silent, non-disruptive saving
  const [draftTaskId, setDraftTaskId] = useState<string>(
    () => localStorage.getItem('aigc_draft_task_id') || ''
  );
  const draftTaskIdRef = useRef<string>(draftTaskId);
  const lastSavedSnapshotRef = useRef<string>('');

  const setDraftTaskIdSynced = useCallback((id: string) => {
    if (draftTaskIdRef.current !== id) {
      draftTaskIdRef.current = id;
      setDraftTaskId(id);
    }
    if (id) {
      localStorage.setItem('aigc_draft_task_id', id);
    } else {
      localStorage.removeItem('aigc_draft_task_id');
    }
  }, []);

  const [draftSavedLabel, setDraftSavedLabel] = useState<string | null>(null);
  const [draftRetryNonce, setDraftRetryNonce] = useState(0);
  const [stepSources, setStepSources] = useState<Partial<Record<StepId, string>>>({});
  const [engineReadiness, setEngineReadiness] = useState<{
    ffmpegInstalled: boolean | null;
    publicBaseUrl: string | null;
    seedanceReady: boolean;
  }>({ ffmpegInstalled: null, publicBaseUrl: null, seedanceReady: false });

  useEffect(() => {
    fetch('/api/health?probe=1')
      .then((r) => r.json())
      .then((json) => {
        const r = json?.readiness;
        if (!r) return;
        setEngineReadiness({
          ffmpegInstalled: Boolean(r.ffmpeg?.installed),
          publicBaseUrl: r.publicBaseUrl || null,
          seedanceReady: Boolean(r.seedance?.ready || r.seedance?.tokenOk),
        });
      })
      .catch(() => {});
  }, []);

  const persistTaskSnapshot = async (
    snapshot: PipelineData,
    opts?: {
      status?: TaskItem['status'];
      currentStep?: StepId;
      title?: string;
      id?: string;
      asDraft?: boolean;
    }
  ) => {
    const title =
      opts?.title ||
      snapshot.step3.output?.title ||
      (opts?.asDraft ? '工作台草稿（自动保存）' : `反推工程_${new Date().toLocaleString('zh-CN')}`);
    const thumbnailUrl =
      snapshot.step1.inputs.mediaUrl ||
      snapshot.step2.output?.previewVideoUrl ||
      snapshot.step2.inputs.imageUrl ||
      undefined;
    const id =
      opts?.id ||
      (opts?.asDraft
        ? draftTaskIdRef.current || `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        : undefined);
    try {
      const res = await apiService.tasks.createTask({
        id,
        title,
        status: opts?.status || 'completed',
        currentStep: opts?.currentStep || 5,
        pipelineData: snapshot,
        thumbnailUrl,
      });
      if (res.success && res.data) {
        if (opts?.asDraft) {
          setDraftTaskIdSynced(res.data.id);
          const newTimeLabel = new Date().toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          setDraftSavedLabel((prev) => (prev === newTimeLabel ? prev : newTimeLabel));
        } else {
          setTasks((prev) => {
            const rest = prev.filter((t) => t.id !== res.data.id);
            return [res.data, ...rest];
          });
        }
        return res.data;
      }
    } catch (err) {
      console.warn('[App] persistTaskSnapshot failed:', err);
    }
    return null;
  };

  const handleCreateNewWorkspace = async () => {
    const currentSerialized = JSON.stringify({ currentStep, pipelineData });
    if (currentSerialized !== lastSavedSnapshotRef.current) {
      const saved = await persistTaskSnapshot(pipelineData, {
        status: 'draft',
        currentStep,
        asDraft: true,
      });
      if (!saved) {
        notify('当前工作区尚未保存，新建操作已取消', 'error');
        return;
      }
      lastSavedSnapshotRef.current = currentSerialized;
    }
    if (activeRunIdRef.current) {
      try {
        await apiService.runs.cancel(activeRunIdRef.current);
        activeRunIdRef.current = null;
        localStorage.removeItem('aigc_active_pipeline_run_id');
      } catch (error: any) {
        notify(error?.message || '后台任务取消失败，新建操作已取消', 'error');
        return;
      }
    }
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }
    setIsAutoPipelineRunning(false);
    setAutoProgress(null);
    setStepSources({});
    setDraftSavedLabel(null);
    setStaleUpstream({ step2: false, step3: false, step4: false, step5: false });

    const freshData: PipelineData = {
      step1: { inputs: { mediaUrl: '', platform: 'douyin', bloggerType: 'daily_seeding', viralReason: '' }, status: 'pending' },
      step2: { inputs: { static_image_prompt: '', imageUrl: '', videoTone: 'douyin_beat', durationSec: 4 }, status: 'pending' },
      step3: { inputs: { videoPrompt: '', targetPlatform: 'douyin', scriptPersona: '成分党' }, status: 'pending' },
      step4: { inputs: { copywritingTitle: '', tonePreference: '治愈', commercialScenario: '个人' }, status: 'pending' },
      step5: { inputs: { aspectRatio: '9:16', subtitleStyle: '黄字黑边' }, status: 'pending' },
    };
    setPipelineData(freshData);
    setCurrentStep(1);

    const newDraftId = `task_draft_${Date.now()}`;
    setDraftTaskIdSynced(newDraftId);
    lastSavedSnapshotRef.current = '';

    try {
      localStorage.removeItem('aigc_cached_pipeline_data');
      localStorage.setItem('aigc_cached_current_step', '1');
    } catch {}
    setActiveView('pipeline');
  };

  const saveCurrentDraftBeforeTransition = async () => {
    const currentSerialized = JSON.stringify({ currentStep, pipelineData });
    if (currentSerialized === lastSavedSnapshotRef.current) return true;
    const saved = await persistTaskSnapshot(pipelineData, {
      status: 'draft',
      currentStep,
      asDraft: true,
    });
    if (!saved) {
      notify('当前修改尚未保存，已取消切换', 'error');
      return false;
    }
    lastSavedSnapshotRef.current = currentSerialized;
    return true;
  };

  const handleLoadWorkspace = async (session: WorkspaceSession) => {
    if (!(await saveCurrentDraftBeforeTransition())) return;
    if (session.pipelineData) {
      setPipelineData(session.pipelineData);
      setCurrentStep(session.currentStep || 1);
      setDraftTaskIdSynced(session.id);
      lastSavedSnapshotRef.current = JSON.stringify({ currentStep: session.currentStep, pipelineData: session.pipelineData });
      setActiveView('pipeline');
    }
  };

  const handleSaveAsPreset = async () => {
    const title = window.prompt('预设名称', pipelineData.step3.output?.title || '自定义爆款模版');
    if (!title) return;
    try {
      const res = await apiService.presets.createPreset({
        title,
        tag: '工作台保存',
        description: pipelineData.step3.output?.hook || '从当前流水线保存的反推预设',
        coverImage: pipelineData.step1.inputs.mediaUrl || '',
        pipelineData,
      });
      if (res.success && res.data) {
        const mapped: PresetTemplate = {
          id: res.data.id,
          title: res.data.title,
          tag: res.data.tag,
          description: res.data.description,
          coverImage: res.data.coverImage,
          pipelineData: res.data.pipelineData || pipelineData,
          createdAt: res.data.createdAt,
        };
        setPresets((prev) => [mapped, ...prev.filter((p) => p.id !== mapped.id)]);
        notify('✅ 已保存为预设模版', 'success');
      } else {
        notify('保存预设失败', 'error');
      }
    } catch (err) {
      notify('保存预设失败，请检查后端', 'error');
    }
  };

  // Initialize pipeline data with cached snapshot or defaults (prevents 200ms layout jump on load)
  const [pipelineData, setPipelineData] = useState<PipelineData>(() => {
    try {
      const saved = localStorage.getItem('aigc_cached_pipeline_data');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.step1) {
          (['step1', 'step2', 'step3', 'step4', 'step5'] as const).forEach((sKey) => {
            if (parsed[sKey] && parsed[sKey].status === 'running') {
              parsed[sKey].status = parsed[sKey].output ? 'completed' : 'pending';
            }
          });
          return parsed;
        }
      }
    } catch {}
    return createEmptyPipelineData();
  });

  // Sync state to local cache for instant refresh
  const latestSnapshotFingerprintRef = useRef('');
  useEffect(() => {
    try {
      localStorage.setItem('aigc_cached_current_step', String(currentStep));
      localStorage.setItem('aigc_cached_pipeline_data', JSON.stringify(pipelineData));
    } catch {}
    latestSnapshotFingerprintRef.current = JSON.stringify({ currentStep, pipelineData });
  }, [currentStep, pipelineData]);

  /** Downstream steps still hold old artifacts after upstream re-run */
  const [staleUpstream, setStaleUpstream] = useState({
    step2: false,
    step3: false,
    step4: false,
    step5: false,
  });

  const markDownstreamStale = (fromStep: StepId, snapshot: PipelineData) => {
    setStaleUpstream((prev) => ({
      step2: fromStep < 2 ? prev.step2 || Boolean(snapshot.step2.output) : prev.step2,
      step3: fromStep < 3 ? prev.step3 || Boolean(snapshot.step3.output) : prev.step3,
      step4: fromStep < 4 ? prev.step4 || Boolean(snapshot.step4.output) : prev.step4,
      step5: fromStep < 5 ? prev.step5 || Boolean(snapshot.step5.output) : prev.step5,
    }));
  };

  // Debounced auto-draft: any meaningful pipeline change → SQLite generating task (with Dirty Check)
  useEffect(() => {
    const hasWork =
      Boolean(pipelineData.step1.inputs.mediaUrl) ||
      Boolean(pipelineData.step1.output) ||
      Boolean(pipelineData.step2.output) ||
      Boolean(pipelineData.step3.output) ||
      Boolean(pipelineData.step4.output) ||
      Boolean(pipelineData.step5.output) ||
      pipelineData.step1.status === 'running' ||
      pipelineData.step2.status === 'running' ||
      pipelineData.step3.status === 'running' ||
      pipelineData.step4.status === 'running' ||
      pipelineData.step5.status === 'running';

    if (!hasWork || isAutoPipelineRunning) return;

    // Fast Fingerprint Dirty Check: skip if snapshot hasn't changed since last persist
    const currentFingerprint = JSON.stringify({ pipelineData, currentStep });
    if (currentFingerprint === lastSavedSnapshotRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      const latestFingerprint = JSON.stringify({ pipelineData, currentStep });
      if (latestFingerprint === lastSavedSnapshotRef.current) return;

      const finished =
        pipelineData.step5.status === 'completed' && Boolean(pipelineData.step5.output);
      void (async () => {
        const saved = await persistTaskSnapshot(pipelineData, {
          asDraft: true,
          status: finished ? 'completed' : 'generating',
          currentStep,
          title: finished
            ? pipelineData.step3.output?.title || '已完成反推工程'
            : '工作台草稿（自动保存）',
        });
        if (saved && latestSnapshotFingerprintRef.current === latestFingerprint) {
          lastSavedSnapshotRef.current = latestFingerprint;
        } else if (!saved) {
          notify('草稿自动保存失败，网络恢复后将自动重试', 'error');
          setDraftRetryNonce((previous) => previous + 1);
        }
      })();
    }, 3500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineData, currentStep, isAutoPipelineRunning, draftRetryNonce]);

  // Handle Login Success
  const handleLoginSuccess = async (username: string, password: string) => {
    const user = await apiService.auth.login(username, password);
    setAuthUser(user);
    setIsLoggedIn(true);

    // Requirement 4: Pop up onboarding guide immediately for new user login
    if (localStorage.getItem('aigc_onboarding_completed') !== 'true') {
      setIsOnboardingOpen(true);
    }
  };

  const handleLogout = async () => {
    if (activeRunIdRef.current) {
      try {
        await apiService.runs.cancel(activeRunIdRef.current);
      } catch (error) {
        console.warn('[App] active run cancellation during logout failed:', error);
      }
    }
    try {
      await apiService.auth.logout();
    } finally {
      activeAbortControllerRef.current?.abort();
      activeAbortControllerRef.current = null;
      activeRunIdRef.current = null;
      clearUserScopedClientState();
      setProducts([]);
      setActiveProductId('');
      setMaterials([]);
      setTasks([]);
      setPipelineRuns([]);
      setPresets([]);
      setModelConfig(DEFAULT_MODEL_CONFIG);
      setPipelineData(createEmptyPipelineData());
      setCurrentStep(1);
      setDraftTaskIdSynced('');
      setDraftSavedLabel(null);
      lastSavedSnapshotRef.current = '';
      setStepSources({});
      setStaleUpstream({ step2: false, step3: false, step4: false, step5: false });
      setActiveView('pipeline');
      setIsAutoPipelineRunning(false);
      setAutoProgress(null);
      setIsOnboardingOpen(false);
      setIsSessionManagerOpen(false);
      setAuthUser(null);
      setIsLoggedIn(false);
    }
  };

  // Sync handlers for user-controlled re-inheritance
  const handleSyncFromStep1 = useCallback(() => {
    setPipelineData((prev) => {
      if (!prev.step1.output) return prev;
      return {
        ...prev,
        step2: {
          ...prev.step2,
          inputs: {
            ...prev.step2.inputs,
            static_image_prompt: prev.step1.output.static_image_prompt,
            imageUrl: prev.step1.inputs.mediaUrl,
          },
        },
      };
    });
    setStaleUpstream((s) => ({ ...s, step2: false }));
  }, []);

  const handleSyncFromStep2 = useCallback(() => {
    setPipelineData((prev) => {
      if (!prev.step2.output) return prev;
      return {
        ...prev,
        step3: {
          ...prev.step3,
          inputs: {
            ...prev.step3.inputs,
            videoPrompt: prev.step2.output.video_prompt,
          },
        },
      };
    });
    setStaleUpstream((s) => ({ ...s, step3: false }));
  }, []);

  const handleSyncFromStep3 = useCallback(() => {
    setPipelineData((prev) => {
      if (!prev.step3.output) return prev;
      return {
        ...prev,
        step4: {
          ...prev.step4,
          inputs: {
            ...prev.step4.inputs,
            copywritingTitle: prev.step3.output.title,
          },
        },
      };
    });
    setStaleUpstream((s) => ({ ...s, step4: false }));
  }, []);

  const handleSyncFromPrevSteps = useCallback(() => {
    setPipelineData((prev) => ({
      ...prev,
      step5: {
        ...prev.step5,
        inputs: {
          ...prev.step5.inputs,
        },
      },
    }));
    setStaleUpstream((s) => ({ ...s, step5: false }));
  }, []);

  // Global AbortController for cancelling in-flight fetch requests & polling loops
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);

  const getNewAbortSignal = useCallback(() => {
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    return controller.signal;
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    let runId = localStorage.getItem('aigc_active_pipeline_run_id');

    let disposed = false;
    let timer: number | undefined;

    const poll = async () => {
      if (!runId) return;
      try {
        const run = await apiService.runs.get(runId);
        if (disposed) return;
        const activeStep = Math.min(5, Math.max(1, run.currentStep)) as StepId;
        setCurrentStep(activeStep);
        setPipelineData((previous) => {
          const next = { ...previous } as PipelineData;
          for (const step of run.steps) {
            const key = `step${step.step}` as keyof PipelineData;
            const current = next[key] as any;
            (next as any)[key] = {
              ...current,
              status:
                step.status === 'completed'
                  ? 'completed'
                  : step.status === 'failed'
                    ? 'failed'
                    : ['running', 'waiting_external'].includes(step.status)
                      ? 'running'
                      : 'pending',
              output: step.output ?? current.output,
            };
          }
          return next;
        });

        if (['completed', 'failed', 'cancelled'].includes(run.status)) {
          localStorage.removeItem('aigc_active_pipeline_run_id');
          activeRunIdRef.current = null;
          setIsAutoPipelineRunning(false);
          setAutoProgress({
            step: activeStep,
            phase: run.status === 'completed' ? 'done' : 'error',
            message:
              run.status === 'completed'
                ? '后台任务已完成并恢复到工作台'
                : run.status === 'cancelled'
                  ? '后台任务已取消'
                  : `Step ${activeStep} 失败：${run.errorMessage || run.errorCode || '未知错误'}`,
          });
          return;
        }

        setAutoProgress({
          step: activeStep,
          phase: activeStep === 5 ? 'render' : 'llm',
          message:
            run.status === 'waiting_external'
              ? `Step ${activeStep}/5 · 外部任务继续运行中`
              : `Step ${activeStep}/5 · 已恢复后台执行状态`,
        });
        timer = window.setTimeout(poll, 2_000);
      } catch (error) {
        if (!disposed) {
          console.warn('[App] recover background run failed:', error);
          timer = window.setTimeout(poll, 5_000);
        }
      }
    };

    const recover = async () => {
      if (!runId) {
        try {
          const runs = await apiService.runs.list();
          const active = runs.find((run) =>
            ['queued', 'running', 'waiting_external'].includes(run.status)
          );
          runId = active?.id || null;
        } catch (error) {
          console.warn('[App] discover background runs failed:', error);
        }
      }
      if (!runId || disposed) return;
      localStorage.setItem('aigc_active_pipeline_run_id', runId);
      activeRunIdRef.current = runId;
      setIsAutoPipelineRunning(true);
      await poll();
    };

    void recover();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [isLoggedIn]);

  const handleAbortCurrentStep = useCallback(async (stepId?: StepId) => {
    const runId = activeRunIdRef.current;
    if (runId) {
      try {
        await apiService.runs.cancel(runId);
        activeRunIdRef.current = null;
        localStorage.removeItem('aigc_active_pipeline_run_id');
      } catch (error: any) {
        notify(error?.message || '后台任务取消失败，任务可能仍在运行', 'error');
        return;
      }
    }
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }
    setIsAutoPipelineRunning(false);
    setAutoProgress(null);

    const target = stepId || currentStep;
    setPipelineData((prev) => {
      const stepKey = `step${target}` as keyof PipelineData;
      const currentObj = prev[stepKey];
      if (currentObj.status === 'running') {
        return {
          ...prev,
          [stepKey]: {
            ...currentObj,
            status: currentObj.output ? 'completed' : 'pending',
          },
        };
      }
      return prev;
    });
  }, [currentStep]);

  const handleAbortFullPipeline = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (runId) {
      try {
        await apiService.runs.cancel(runId);
        activeRunIdRef.current = null;
        localStorage.removeItem('aigc_active_pipeline_run_id');
      } catch (error: any) {
        notify(error?.message || '后台任务取消失败，任务可能仍在运行', 'error');
        return;
      }
    }
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }
    setIsAutoPipelineRunning(false);
    setAutoProgress({
      step: currentStep,
      phase: 'error',
      message: '一键全自动贯通已终止',
    });
    setTimeout(() => setAutoProgress(null), 3000);

    setPipelineData((prev) => {
      const next = { ...prev };
      (['step1', 'step2', 'step3', 'step4', 'step5'] as const).forEach((sKey) => {
        if (next[sKey].status === 'running') {
          next[sKey] = {
            ...next[sKey],
            status: next[sKey].output ? 'completed' : 'pending',
          };
        }
      });
      return next;
    });
  }, [currentStep]);

  const handleClearWorkbench = async () => {
    if (!confirm('确定要一键清空当前工作台吗？清空后 5 个步骤的所有输入与产物均将被重置。')) {
      return;
    }
    if (!(await saveCurrentDraftBeforeTransition())) return;
    if (activeRunIdRef.current) {
      try {
        await apiService.runs.cancel(activeRunIdRef.current);
        activeRunIdRef.current = null;
        localStorage.removeItem('aigc_active_pipeline_run_id');
      } catch (error: any) {
        notify(error?.message || '后台任务取消失败，清空操作已取消', 'error');
        return;
      }
    }
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }
    setIsAutoPipelineRunning(false);
    setAutoProgress(null);
    setStepSources({});
    setDraftSavedLabel(null);
    setDraftTaskIdSynced('');
    lastSavedSnapshotRef.current = '';
    setStaleUpstream({ step2: false, step3: false, step4: false, step5: false });

    try {
      localStorage.removeItem('aigc_cached_pipeline_data');
      localStorage.removeItem('aigc_cached_current_step');
      localStorage.removeItem('aigc_draft_task_id');
    } catch {}

    setPipelineData({
      step1: {
        status: 'pending',
        inputs: {
          mediaUrl: '',
          platform: 'xiaohongshu',
          bloggerType: 'daily_seeding',
          viralReason: '',
          textModel: 'Gemini 3.6 Flash',
          imageModel: 'GPT Image 1',
        },
      },
      step2: {
        status: 'pending',
        inputs: {
          static_image_prompt: '',
          imageUrl: '',
          videoTone: 'xiaohongshu_healing',
          durationSec: 4,
          textModel: 'Gemini 3.6 Flash',
          videoModel: 'Seedance 2.0 Fast',
        },
      },
      step3: {
        status: 'pending',
        inputs: {
          videoPrompt: '',
          targetPlatform: 'xiaohongshu',
          scriptPersona: '油皮亲妈',
          textModel: 'Gemini 3.6 Flash',
        },
      },
      step4: {
        status: 'pending',
        inputs: {
          copywritingTitle: '',
          tonePreference: '治愈',
          commercialScenario: '抖音/小红书商业化',
          textModel: 'Gemini 3.6 Flash',
        },
      },
      step5: {
        status: 'pending',
        inputs: {
          aspectRatio: '9:16',
          subtitleStyle: '黄字黑边',
        },
      },
    });
    setCurrentStep(1);
  };

  // Full end-to-end automated reverse inference runner
  const runFullPipelineAutoLegacy = async () => {
    if (isAutoPipelineRunning) return;
    const signal = getNewAbortSignal();
    setIsAutoPipelineRunning(true);
    handleSetActiveView('pipeline');
    setAutoProgress({ step: 1, phase: 'llm', message: '准备全自动反推…' });

    /** Track latest snapshot for failure persistence */
    let working: PipelineData = { ...pipelineData };
    let failedStep: StepId = 1;

    const markRunning = (step: StepId, phase = 'llm', message?: string) => {
      failedStep = step;
      setCurrentStep(step);
      setAutoProgress({
        step,
        phase,
        message: message || `Step ${step}/5 执行中…`,
      });
      const key = `step${step}` as keyof PipelineData;
      working = {
        ...working,
        [key]: { ...(working as any)[key], status: 'running' },
      } as PipelineData;
      setPipelineData(working);
    };

    try {
      // 1. Step 1
      markRunning(1, 'llm', 'Step 1/5 · 多模态拆解分析…');
      const res1 = await fetch('/api/pipeline/step1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...working.step1.inputs,
          ...productPayload(),
        }),
      });
      const result1 = await res1.json();
      if (!result1.success || !result1.data) throw new Error(result1.error || 'Step 1 failed');
      const out1 = result1.data;
      if (result1.source) setStepSources((s) => ({ ...s, 1: String(result1.source) }));

      const updatedStep2Inputs = {
        ...working.step2.inputs,
        static_image_prompt: out1.static_image_prompt,
        imageUrl: working.step1.inputs.mediaUrl,
      };
      working = {
        ...working,
        step1: { ...working.step1, output: out1, status: 'completed' },
        step2: { ...working.step2, inputs: updatedStep2Inputs },
      };
      setPipelineData(working);
      await new Promise((r) => setTimeout(r, 400));

      // 2 & 3. Parallelize Step 2 (Video Generation) and Step 3 (Copywriting)
      markRunning(2, 'llm', 'Step 2/5 · 运镜与视频生成 + Step 3/5 · 文案并行构建中…');

      // Prepare Step 3 request in parallel
      const runStep3Task = async () => {
        const res3 = await fetch('/api/pipeline/step3', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...working.step3.inputs,
            videoPrompt: out1.static_image_prompt,
            ...productPayload(),
          }),
        });
        const result3 = await res3.json();
        if (!result3.success || !result3.data) throw new Error(result3.error || 'Step 3 failed');
        return result3;
      };

      // Prepare Step 2 request
      const runStep2Task = async () => {
        const res2 = await fetch('/api/pipeline/step2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...updatedStep2Inputs,
            ...productPayload(),
          }),
        });
        const result2 = await res2.json();
        if (!result2.success || !result2.data) throw new Error(result2.error || 'Step 2 failed');
        let out2 = result2.data;

        if (out2.seedanceTaskId && !out2.previewVideoUrl) {
          const taskId = String(out2.seedanceTaskId);
          const maxSec = 180;
          const startedAt = Date.now();
          const deadline = startedAt + maxSec * 1000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 3000));
            try {
              const pollRes = await fetch(`/api/seedance/generations/${encodeURIComponent(taskId)}`);
              const pollJson = await pollRes.json();
              const task = pollJson?.data;
              if (task?.url) {
                out2 = { ...out2, previewVideoUrl: task.url, seedanceStatus: task.status || 'success' };
                break;
              }
              const st = String(task?.status || '').toLowerCase();
              if (st === 'failed' || st === 'error') throw new Error(task?.error || 'Seedance 视频生成失败');
            } catch (pollErr: any) {
              if (String(pollErr?.message || '').includes('Seedance')) throw pollErr;
            }
          }
        }
        return { result2, out2 };
      };

      // Execute Step 2 and Step 3 in Parallel!
      const [step2Res, result3] = await Promise.all([runStep2Task(), runStep3Task()]);
      const out2 = step2Res.out2;
      const out3 = result3.data;

      if (step2Res.result2.source) setStepSources((s) => ({ ...s, 2: String(step2Res.result2.source) }));
      if (result3.source) setStepSources((s) => ({ ...s, 3: String(result3.source) }));

      const updatedStep3Inputs = {
        ...working.step3.inputs,
        videoPrompt: out2.video_prompt || out1.static_image_prompt,
      };
      working = {
        ...working,
        step2: { ...working.step2, inputs: updatedStep2Inputs, output: out2, status: 'completed' },
        step3: { ...working.step3, inputs: updatedStep3Inputs, output: out3, status: 'completed' },
      };
      setPipelineData(working);
      await new Promise((r) => setTimeout(r, 300));

      const updatedStep4Inputs = {
        ...working.step4.inputs,
        copywritingTitle: out3.title,
      };
      working = {
        ...working,
        step4: { ...working.step4, inputs: updatedStep4Inputs },
      };
      setPipelineData(working);
      await new Promise((r) => setTimeout(r, 400));

      // 4. Step 4
      markRunning(4, 'llm', 'Step 4/5 · BGM 库匹配…');
      const res4 = await fetch('/api/pipeline/step4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updatedStep4Inputs,
          ...productPayload(),
        }),
      });
      const result4 = await res4.json();
      if (!result4.success || !result4.data) throw new Error(result4.error || 'Step 4 failed');
      const out4 = result4.data;
      if (result4.source) setStepSources((s) => ({ ...s, 4: String(result4.source) }));

      working = {
        ...working,
        step4: { ...working.step4, inputs: updatedStep4Inputs, output: out4, status: 'completed' },
      };
      setPipelineData(working);
      await new Promise((r) => setTimeout(r, 400));

      // 5. Step 5
      markRunning(5, 'render', 'Step 5/5 · FFmpeg 合成成片…');
      const res5 = await fetch('/api/pipeline/step5', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...working.step5.inputs,
          videoPrompt: out2.video_prompt,
          title: out3.title,
          hook: out3.hook,
          bgmTrack: out4.bgm_recommendation.track_name,
          videoSourceUrl: out2.previewVideoUrl,
          audioSourceUrl: out4.bgm_recommendation.audioSampleUrl,
          ...productPayload(),
        }),
      });
      const result5 = await res5.json();
      if (!result5.success || !result5.data) throw new Error(result5.error || 'Step 5 failed');
      const out5 = result5.data;
      if (result5.source) setStepSources((s) => ({ ...s, 5: String(result5.source) }));

      const finalSnapshot: PipelineData = {
        ...working,
        step5: { ...working.step5, output: out5, status: 'completed' },
      };
      setPipelineData(finalSnapshot);
      setAutoProgress({ step: 5, phase: 'done', message: '全自动贯通完成' });
      setStaleUpstream({ step2: false, step3: false, step4: false, step5: false });

      await persistTaskSnapshot(finalSnapshot, {
        status: 'completed',
        currentStep: 5,
        title: out3.title || '全自动爆款视频产物',
        asDraft: false,
      });
      setDraftSavedLabel(`全自动生成成功！已作为成品入库 ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      console.error('Auto pipeline run error:', e);
      const msg = e instanceof Error ? e.message : '全自动流水线运行失败';
      const failedKey = `step${failedStep}` as keyof PipelineData;
      const failedSnapshot: PipelineData = {
        ...working,
        [failedKey]: {
          ...working[failedKey],
          status: 'failed',
        },
      } as PipelineData;
      setPipelineData(failedSnapshot);
      setCurrentStep(failedStep);
      setAutoProgress({
        step: failedStep,
        phase: 'error',
        message: `失败 @ Step ${failedStep}: ${msg.slice(0, 80)}`,
      });
      await persistTaskSnapshot(failedSnapshot, {
        status: 'failed',
        currentStep: failedStep,
        title: `全自动失败 @ Step${failedStep}: ${msg.slice(0, 40)}`,
        asDraft: true,
      });
      notify(`全自动已停在 Step ${failedStep}\n${msg}`, 'error');
    } finally {
      setIsAutoPipelineRunning(false);
      setTimeout(() => setAutoProgress(null), 4000);
    }
  };

  const isVideoMediaUrl = (url?: string) => {
    if (!url) return false;
    const lower = url.toLowerCase().split('?')[0];
    return (
      lower.endsWith('.mp4') ||
      lower.endsWith('.webm') ||
      lower.endsWith('.mov') ||
      lower.endsWith('.avi') ||
      lower.endsWith('.mkv') ||
      lower.includes('/video')
    );
  };

  const getProductAssetIds = () =>
    (activeProduct?.assets || [])
      .map((a) => a.id)
      .filter(Boolean) as string[];

  const canStartViralDirectOut = () => {
    const mediaUrl = pipelineData.step1.inputs.mediaUrl;
    const hasViral = Boolean(mediaUrl);
    const hasProductAssets = getProductAssetIds().length > 0 || Boolean(activeProduct?.coverImage);
    return { hasViral, hasProductAssets, isVideo: isVideoMediaUrl(mediaUrl) };
  };

  const runFullPipelineAuto = async () => {
    if (isAutoPipelineRunning) return;

    // Dual-input guard for viral direct-out (one-click always uses viral mode when video present)
    const { hasViral, hasProductAssets, isVideo } = canStartViralDirectOut();
    if (!hasViral) {
      notify('请先导入爆款视频或参考图，再一键直出', 'error');
      return;
    }
    if (isVideo && !hasProductAssets) {
      notify('爆款直出需要至少 1 张产品图：请在品牌知识库为当前产品上传产品图', 'error');
      return;
    }

    const signal = getNewAbortSignal();
    const idempotencyKey = crypto.randomUUID();
    setIsAutoPipelineRunning(true);
    handleSetActiveView('pipeline');
    setAutoProgress({ step: 1, phase: 'llm', message: '正在创建可恢复的后台任务…' });

    const applyRunSnapshot = (run: Awaited<ReturnType<typeof apiService.runs.get>>) => {
      const activeStep = Math.min(5, Math.max(1, run.currentStep)) as StepId;
      setCurrentStep(activeStep);
      setPipelineData((previous) => {
        const next = { ...previous } as PipelineData;
        for (const step of run.steps) {
          const key = `step${step.step}` as keyof PipelineData;
          const current = next[key] as any;
          (next as any)[key] = {
            ...current,
            status:
              step.status === 'completed'
                ? 'completed'
                : step.status === 'failed'
                  ? 'failed'
                  : step.status === 'needs_review'
                    ? 'needs_review'
                    : ['running', 'waiting_external'].includes(step.status)
                      ? 'running'
                      : 'pending',
            output: step.output ?? current.output,
          };
        }
        return next;
      });

      const currentStepState = run.steps.find((step) => step.step === activeStep);
      const waitingExternal = currentStepState?.status === 'waiting_external';
      setAutoProgress({
        step: activeStep,
        phase: activeStep === 5 ? 'render' : 'llm',
        message: waitingExternal
          ? `Step ${activeStep}/5 · 外部生成任务运行中，可安全离开页面`
          : `Step ${activeStep}/5 · 后台执行中…`,
      });
    };

    try {
      const productAssetIds = getProductAssetIds();
      const directOutMode = isVideoMediaUrl(pipelineData.step1.inputs.mediaUrl)
        ? 'viral'
        : 'legacy';
      const pipelineForRun = {
        ...pipelineData,
        directOutMode,
        productAssetIds,
      } as PipelineData & { directOutMode?: string; productAssetIds?: string[] };

      let run = await apiService.runs.start(
        pipelineForRun,
        activeProduct?.id,
        activeProduct,
        idempotencyKey,
        { productAssetIds, directOutMode }
      );
      activeRunIdRef.current = run.id;
      localStorage.setItem('aigc_active_pipeline_run_id', run.id);
      applyRunSnapshot(run);

      while (!['completed', 'failed', 'cancelled'].includes(run.status)) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(resolve, 2_000);
          signal.addEventListener(
            'abort',
            () => {
              window.clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true }
          );
        });
        run = await apiService.runs.get(run.id);
        applyRunSnapshot(run);
      }

      if (run.status === 'completed') {
        const completedData = run.steps.reduce((snapshot, step) => {
          const key = `step${step.step}` as keyof PipelineData;
          return {
            ...snapshot,
            [key]: {
              ...(snapshot as any)[key],
              status: 'completed',
              output: step.output,
            },
          };
        }, pipelineData as PipelineData);
        setPipelineData(completedData);
        setAutoProgress({ step: 5, phase: 'done', message: '全自动后台任务已完成' });
        setStaleUpstream({ step2: false, step3: false, step4: false, step5: false });
        await persistTaskSnapshot(completedData, {
          status: 'completed',
          currentStep: 5,
          title: (run.steps[2]?.output as any)?.title || '全自动爆款视频产物',
          asDraft: false,
        });
        setDraftSavedLabel(`全自动生成成功！${new Date().toLocaleTimeString()}`);
      } else if (run.status === 'failed') {
        throw new Error(
          `Step ${run.currentStep} 失败：${run.errorMessage || run.errorCode || '未知错误'}`
        );
      } else {
        setAutoProgress({
          step: run.currentStep as StepId,
          phase: 'error',
          message: '后台任务已取消',
        });
      }
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        console.error('Background pipeline run error:', error);
        setAutoProgress({
          step: currentStep,
          phase: 'error',
          message: String(error?.message || '后台流水线失败').slice(0, 120),
        });
      }
    } finally {
      activeRunIdRef.current = null;
      localStorage.removeItem('aigc_active_pipeline_run_id');
      setIsAutoPipelineRunning(false);
      activeAbortControllerRef.current = null;
      setTimeout(() => setAutoProgress(null), 4_000);
    }
  };

  // Reset entire pipeline
  const handleResetAll = async () => {
    if (!window.confirm('确认清空当前工作台吗？未保存修改会先保存，后台生成任务会被取消。')) return;
    if (!(await saveCurrentDraftBeforeTransition())) return;
    if (activeRunIdRef.current) {
      try {
        await apiService.runs.cancel(activeRunIdRef.current);
        activeRunIdRef.current = null;
        localStorage.removeItem('aigc_active_pipeline_run_id');
      } catch (error: any) {
        notify(error?.message || '后台任务取消失败，清空操作已取消', 'error');
        return;
      }
    }
    setStepSources({});
    setDraftSavedLabel(null);
    setDraftTaskIdSynced('');
    lastSavedSnapshotRef.current = '';
    setStaleUpstream({ step2: false, step3: false, step4: false, step5: false });
    setPipelineData({
      step1: {
        status: 'pending',
        inputs: {
          mediaUrl: '',
          platform: 'xiaohongshu',
          bloggerType: 'daily_seeding',
          viralReason: '',
          textModel: 'Gemini 3.6 Flash',
          imageModel: 'GPT Image 1',
        },
      },
      step2: {
        status: 'pending',
        inputs: {
          static_image_prompt: '',
          imageUrl: '',
          videoTone: 'xiaohongshu_healing',
          durationSec: 4,
          textModel: 'Gemini 3.6 Flash',
          videoModel: 'Seedance 2.0 Fast',
        },
      },
      step3: {
        status: 'pending',
        inputs: {
          videoPrompt: '',
          targetPlatform: 'xiaohongshu',
          scriptPersona: '油皮亲妈',
          textModel: 'Gemini 3.6 Flash',
        },
      },
      step4: {
        status: 'pending',
        inputs: {
          copywritingTitle: '',
          tonePreference: '治愈',
          commercialScenario: '抖音/小红书商业化',
          textModel: 'Gemini 3.6 Flash',
        },
      },
      step5: {
        status: 'pending',
        inputs: {
          aspectRatio: '9:16',
          subtitleStyle: '黄字黑边',
        },
      },
    });
    setCurrentStep(1);
    handleSetActiveView('pipeline');
  };

  // Load a Preset Template
  const handleSelectPreset = (preset: PresetTemplate) => {
    const rawData = (preset.pipelineData || {}) as Partial<PipelineData>;
    if (!rawData?.step1 && !rawData?.step2 && !rawData?.step3 && !rawData?.step4 && !rawData?.step5) {
      notify('该预设缺少流水线数据，无法载入', 'error');
      return;
    }

    const cover = preset.coverImage || 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80';

    const normalizedData: PipelineData = {
      step1: {
        status: rawData.step1?.status || 'completed',
        inputs: {
          mediaUrl: rawData.step1?.inputs?.mediaUrl || cover,
          platform: rawData.step1?.inputs?.platform || 'douyin',
          bloggerType: rawData.step1?.inputs?.bloggerType || 'skincare_expert',
          viralReason: rawData.step1?.inputs?.viralReason || preset.description || '',
          textModel: rawData.step1?.inputs?.textModel || 'Gemini 3.6 Flash',
          imageModel: rawData.step1?.inputs?.imageModel || 'GPT Image 1',
        },
        output: rawData.step1?.output,
      },
      step2: {
        status: rawData.step2?.status || 'completed',
        inputs: {
          static_image_prompt: rawData.step2?.inputs?.static_image_prompt || rawData.step1?.output?.static_image_prompt || '',
          imageUrl: rawData.step2?.inputs?.imageUrl || cover,
          videoTone: rawData.step2?.inputs?.videoTone || 'douyin_beat',
          durationSec: rawData.step2?.inputs?.durationSec || 4,
          textModel: rawData.step2?.inputs?.textModel || 'Gemini 3.6 Flash',
          videoModel: rawData.step2?.inputs?.videoModel || 'Seedance 2.0 Fast',
        },
        output: rawData.step2?.output,
      },
      step3: {
        status: rawData.step3?.status || 'completed',
        inputs: {
          videoPrompt: rawData.step3?.inputs?.videoPrompt || rawData.step2?.output?.video_prompt || '',
          targetPlatform: rawData.step3?.inputs?.targetPlatform || 'douyin',
          scriptPersona: rawData.step3?.inputs?.scriptPersona || '成分党',
          textModel: rawData.step3?.inputs?.textModel || 'Gemini 3.6 Flash',
        },
        output: rawData.step3?.output,
      },
      step4: {
        status: rawData.step4?.status || 'completed',
        inputs: {
          copywritingTitle: rawData.step4?.inputs?.copywritingTitle || rawData.step3?.output?.title || preset.title || '',
          tonePreference: rawData.step4?.inputs?.tonePreference || '卡点',
          commercialScenario: rawData.step4?.inputs?.commercialScenario || '抖音/小红书商业化',
          textModel: rawData.step4?.inputs?.textModel || 'Gemini 3.6 Flash',
        },
        output: rawData.step4?.output,
      },
      step5: {
        status: rawData.step5?.status || 'completed',
        inputs: {
          aspectRatio: rawData.step5?.inputs?.aspectRatio || '9:16',
          subtitleStyle: rawData.step5?.inputs?.subtitleStyle || '黄字黑边',
        },
        output: rawData.step5?.output,
      },
    };

    setPipelineData(normalizedData);
    setCurrentStep(1);
    handleSetActiveView('pipeline');
  };

  const productPayload = () => ({
    productId: activeProduct?.id,
    productInfo: activeProduct,
  });

  // Step 1 Execution
  const runStep1 = async () => {
    const signal = getNewAbortSignal();
    setPipelineData((prev) => ({
      ...prev,
      step1: { ...prev.step1, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          ...pipelineData.step1.inputs,
          ...productPayload(),
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        if (result.source) setStepSources((s) => ({ ...s, 1: String(result.source) }));
        setPipelineData((prev) => {
          // Prefer product-conditioned first frame over viral media URL
          const productFrame =
            output.productHeroFrameUrl ||
            output.migrationPlan?.productHeroUrl ||
            activeProduct?.assets?.[0]?.url ||
            activeProduct?.coverImage ||
            '';
          const nextImageUrl = productFrame || prev.step1.inputs.mediaUrl;
          const next = {
            ...prev,
            step1: { ...prev.step1, output, status: 'completed' as const },
            step2: {
              ...prev.step2,
              inputs: {
                ...prev.step2.inputs,
                static_image_prompt: prev.step2.output
                  ? prev.step2.inputs.static_image_prompt
                  : output.static_image_prompt,
                imageUrl: prev.step2.output ? prev.step2.inputs.imageUrl : nextImageUrl,
              },
            },
          };
          if (prev.step2.output || prev.step3.output || prev.step4.output || prev.step5.output) {
            markDownstreamStale(1, prev);
          } else {
            next.step2.inputs.static_image_prompt = output.static_image_prompt;
            next.step2.inputs.imageUrl = nextImageUrl;
          }
          return next;
        });
      } else {
        notify(result.error || 'Step 1 运行失败', 'error');
        setPipelineData((prev) => ({
          ...prev,
          step1: { ...prev.step1, status: 'failed' },
        }));
      }
    } catch (e: any) {
      if (e.name === 'AbortError' || signal.aborted) {
        console.log('Step 1 execution aborted by user');
        setPipelineData((prev) => ({
          ...prev,
          step1: { ...prev.step1, status: prev.step1.output ? 'completed' : 'pending' },
        }));
        return;
      }
      console.error('Step1 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step1: { ...prev.step1, status: 'failed' },
      }));
    }
  };

  // Step 2 Execution
  const runStep2 = async () => {
    const signal = getNewAbortSignal();
    setPipelineData((prev) => ({
      ...prev,
      step2: { ...prev.step2, status: 'running' },
    }));

    try {
      // 中转繁忙时 step2（3 镜头逐镜提交）可能耗时数分钟，给足超时但避免永久挂起
      const res = await fetch('/api/pipeline/step2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        body: JSON.stringify({
          ...pipelineData.step2.inputs,
          ...productPayload(),
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        // Step2 必须真正提交了视频生成才算完成；否则标记失败并给出可操作提示
        const hasVideoPath = Boolean(
          output.previewVideoUrl ||
            output.concatenatedVideoUrl ||
            output.seedanceTaskId ||
            output.multiShotResult?.sessionId
        );
        const notSubmitted = [
          'awaiting_image_input',
          'awaiting_public_image',
          'submit_failed',
          'unconfigured',
        ].includes(String(output.seedanceStatus || ''));
        if (!hasVideoPath && notSubmitted) {
          notify(
            output.seedanceError ||
              output.seedanceHint ||
              'Step 2 未能提交视频生成：缺少 Seedance 可下载的产品首帧图',
            'error'
          );
          setPipelineData((prev) => ({
            ...prev,
            step2: { ...prev.step2, output, status: 'failed' as const },
          }));
          return;
        }
        if (result.source) setStepSources((s) => ({ ...s, 2: String(result.source) }));
        setPipelineData((prev) => {
          const next = {
            ...prev,
            step2: { ...prev.step2, output, status: 'completed' as const },
            step3: {
              ...prev.step3,
              inputs: {
                ...prev.step3.inputs,
                videoPrompt: prev.step3.output ? prev.step3.inputs.videoPrompt : output.video_prompt,
              },
            },
          };
          if (prev.step3.output || prev.step4.output || prev.step5.output) {
            markDownstreamStale(2, prev);
          } else {
            next.step3.inputs.videoPrompt = output.video_prompt;
          }
          return next;
        });
        setStaleUpstream((s) => ({ ...s, step2: false }));
      } else {
        notify(result.error || 'Step 2 运行失败', 'error');
        setPipelineData((prev) => ({
          ...prev,
          step2: { ...prev.step2, status: 'failed' },
        }));
      }
    } catch (e: any) {
      if (e.name === 'AbortError' || signal.aborted) {
        console.log('Step 2 execution aborted by user');
        setPipelineData((prev) => ({
          ...prev,
          step2: { ...prev.step2, status: prev.step2.output ? 'completed' : 'pending' },
        }));
        return;
      }
      if (e.name === 'TimeoutError') {
        notify('Step 2 等待视频生成超时（5 分钟）：星河中转繁忙，请稍后重试', 'error');
      } else {
        console.error('Step2 run failed:', e);
      }
      setPipelineData((prev) => ({
        ...prev,
        step2: { ...prev.step2, status: 'failed' },
      }));
    }
  };

  // Step 3 Execution
  const runStep3 = async () => {
    const signal = getNewAbortSignal();
    setPipelineData((prev) => ({
      ...prev,
      step3: { ...prev.step3, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          ...pipelineData.step3.inputs,
          ...productPayload(),
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        if (result.source) setStepSources((s) => ({ ...s, 3: String(result.source) }));
        setPipelineData((prev) => {
          const next = {
            ...prev,
            step3: { ...prev.step3, output, status: 'completed' as const },
            step4: {
              ...prev.step4,
              inputs: {
                ...prev.step4.inputs,
                copywritingTitle: prev.step4.output
                  ? prev.step4.inputs.copywritingTitle
                  : output.title,
              },
            },
          };
          if (prev.step4.output || prev.step5.output) {
            markDownstreamStale(3, prev);
          } else {
            next.step4.inputs.copywritingTitle = output.title;
          }
          return next;
        });
        setStaleUpstream((s) => ({ ...s, step3: false }));
      } else {
        notify(result.error || 'Step 3 运行失败', 'error');
        setPipelineData((prev) => ({
          ...prev,
          step3: { ...prev.step3, status: 'failed' },
        }));
      }
    } catch (e: any) {
      if (e.name === 'AbortError' || signal.aborted) {
        console.log('Step 3 execution aborted by user');
        setPipelineData((prev) => ({
          ...prev,
          step3: { ...prev.step3, status: prev.step3.output ? 'completed' : 'pending' },
        }));
        return;
      }
      console.error('Step3 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step3: { ...prev.step3, status: 'failed' },
      }));
    }
  };

  // Step 4 Execution
  const runStep4 = async () => {
    const signal = getNewAbortSignal();
    setPipelineData((prev) => ({
      ...prev,
      step4: { ...prev.step4, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          ...pipelineData.step4.inputs,
          ...productPayload(),
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        if (result.source) setStepSources((s) => ({ ...s, 4: String(result.source) }));
        setPipelineData((prev) => {
          if (prev.step5.output) markDownstreamStale(4, prev);
          return {
            ...prev,
            step4: { ...prev.step4, output, status: 'completed' as const },
          };
        });
        setStaleUpstream((s) => ({ ...s, step4: false }));
      } else {
        notify(result.error || 'Step 4 运行失败', 'error');
        setPipelineData((prev) => ({
          ...prev,
          step4: { ...prev.step4, status: 'failed' },
        }));
      }
    } catch (e: any) {
      if (e.name === 'AbortError' || signal.aborted) {
        console.log('Step 4 execution aborted by user');
        setPipelineData((prev) => ({
          ...prev,
          step4: { ...prev.step4, status: prev.step4.output ? 'completed' : 'pending' },
        }));
        return;
      }
      console.error('Step4 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step4: { ...prev.step4, status: 'failed' },
      }));
    }
  };

  // Step 5 Execution
  const runStep5 = async () => {
    const signal = getNewAbortSignal();
    setPipelineData((prev) => ({
      ...prev,
      step5: { ...prev.step5, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step5', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          ...pipelineData.step5.inputs,
          videoPrompt: pipelineData.step2.output?.video_prompt,
          title: pipelineData.step3.output?.title,
          hook: pipelineData.step3.output?.hook,
          bgmTrack: pipelineData.step4.output?.bgm_recommendation.track_name,
          videoSourceUrl: pipelineData.step2.output?.previewVideoUrl,
          audioSourceUrl: pipelineData.step4.output?.bgm_recommendation.audioSampleUrl,
          ...productPayload(),
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        setPipelineData((prev) => {
          const next = {
            ...prev,
            step5: { ...prev.step5, output, status: 'completed' as const },
          };
          void persistTaskSnapshot(next, {
            status: 'completed',
            currentStep: 5,
            title: prev.step3.output?.title,
          });
          return next;
        });
        if (result.source) setStepSources((s) => ({ ...s, 5: String(result.source) }));
        setStaleUpstream((s) => ({ ...s, step5: false }));
      } else {
        notify(result.error || 'Step 5 运行失败', 'error');
        setPipelineData((prev) => ({
          ...prev,
          step5: { ...prev.step5, status: 'failed' },
        }));
      }
    } catch (e: any) {
      if (e.name === 'AbortError' || signal.aborted) {
        console.log('Step 5 execution aborted by user');
        setPipelineData((prev) => ({
          ...prev,
          step5: { ...prev.step5, status: prev.step5.output ? 'completed' : 'pending' },
        }));
        return;
      }
      console.error('Step5 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step5: { ...prev.step5, status: 'failed' },
      }));
    }
  };

  // Memoized Handlers for Step Cards to maintain React.memo effectiveness
  const handleOpenMaterials = useCallback(() => handleSetActiveView('materials'), [handleSetActiveView]);
  const handleOpenTasks = useCallback(() => handleSetActiveView('tasks'), [handleSetActiveView]);

  const handleStep1UpdateInputs = useCallback(
    (inp: any) =>
      setPipelineData((prev) => ({
        ...prev,
        step1: { ...prev.step1, inputs: { ...prev.step1.inputs, ...inp } },
      })),
    []
  );
  const handleStep1UpdateOutput = useCallback(
    (updated: any) =>
      setPipelineData((prev) => ({
        ...prev,
        step1: {
          ...prev.step1,
          output: prev.step1.output ? { ...prev.step1.output, ...updated } : undefined,
        },
      })),
    []
  );
  const handleStep1GeneratedImage = useCallback(
    ({ imageUrl, promptUsed }: { imageUrl: string; promptUsed: string }) =>
      setPipelineData((prev) => ({
        ...prev,
        step1: {
          ...prev.step1,
          inputs: { ...prev.step1.inputs, mediaUrl: imageUrl },
          output: prev.step1.output
            ? { ...prev.step1.output, static_image_prompt: promptUsed }
            : prev.step1.output,
        },
        step2: {
          ...prev.step2,
          inputs: {
            ...prev.step2.inputs,
            imageUrl,
            static_image_prompt: promptUsed || prev.step2.inputs.static_image_prompt,
          },
        },
      })),
    []
  );
  const handleStep1Reset = useCallback(
    () =>
      setPipelineData((prev) => ({
        ...prev,
        step1: { ...prev.step1, status: 'pending', output: undefined },
      })),
    []
  );
  /** 工作台内上传/删除产品图后刷新产品列表（爆款直出的首帧依赖产品图） */
  const handleProductAssetsChanged = useCallback(async () => {
    try {
      const list = await apiService.products.fetchProducts();
      setProducts(list);
    } catch {
      /* 保留现有列表 */
    }
  }, []);

  const handleStep2UpdateInputs = useCallback(
    (inp: any) =>
      setPipelineData((prev) => ({
        ...prev,
        step2: { ...prev.step2, inputs: { ...prev.step2.inputs, ...inp } },
      })),
    []
  );
  const handleStep2UpdateOutput = useCallback(
    (updated: any) =>
      setPipelineData((prev) => ({
        ...prev,
        step2: {
          ...prev.step2,
          output: prev.step2.output ? { ...prev.step2.output, ...updated } : undefined,
        },
      })),
    []
  );
  const handleStep2Reset = useCallback(
    () =>
      setPipelineData((prev) => ({
        ...prev,
        step2: { ...prev.step2, status: 'pending', output: undefined },
      })),
    []
  );

  const handleStep3UpdateInputs = useCallback(
    (inp: any) =>
      setPipelineData((prev) => ({
        ...prev,
        step3: { ...prev.step3, inputs: { ...prev.step3.inputs, ...inp } },
      })),
    []
  );
  const handleStep3UpdateOutput = useCallback(
    (updated: any) =>
      setPipelineData((prev) => ({
        ...prev,
        step3: {
          ...prev.step3,
          output: prev.step3.output ? { ...prev.step3.output, ...updated } : undefined,
        },
      })),
    []
  );
  const handleStep3Reset = useCallback(
    () =>
      setPipelineData((prev) => ({
        ...prev,
        step3: { ...prev.step3, status: 'pending', output: undefined },
      })),
    []
  );

  const handleStep4UpdateInputs = useCallback(
    (inp: any) =>
      setPipelineData((prev) => ({
        ...prev,
        step4: { ...prev.step4, inputs: { ...prev.step4.inputs, ...inp } },
      })),
    []
  );
  const handleStep4Reset = useCallback(
    () =>
      setPipelineData((prev) => ({
        ...prev,
        step4: { ...prev.step4, status: 'pending', output: undefined },
      })),
    []
  );

  const handleStep5UpdateInputs = useCallback(
    (inp: any) =>
      setPipelineData((prev) => ({
        ...prev,
        step5: { ...prev.step5, inputs: { ...prev.step5.inputs, ...inp } },
      })),
    []
  );
  const handleStep5Reset = useCallback(
    () =>
      setPipelineData((prev) => ({
        ...prev,
        step5: { ...prev.step5, status: 'pending', output: undefined },
      })),
    []
  );

  const goToStep1 = useCallback(() => setCurrentStep(1), []);
  const goToStep2 = useCallback(() => setCurrentStep(2), []);
  const goToStep3 = useCallback(() => setCurrentStep(3), []);
  const goToStep4 = useCallback(() => setCurrentStep(4), []);
  const goToStep5 = useCallback(() => setCurrentStep(5), []);

  if (!isAuthChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-500">
        正在验证登录状态…
      </div>
    );
  }

  if (!isLoggedIn) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="flex min-h-screen bg-[#f8fafc] text-slate-900 font-sans selection:bg-indigo-600 selection:text-white">
      <NotificationViewport />
      {/* Resizable Sidebar */}
      <Sidebar
        sidebarWidth={sidebarWidth}
        setSidebarWidth={handleSetSidebarWidth}
        isExpanded={isSidebarExpanded}
        onToggleExpand={handleToggleSidebar}
        activeView={safeActiveView}
        onChangeView={(view) => handleSetActiveView(view)}
        onOpenOnboarding={() => setIsOnboardingOpen(true)}
        onResetAll={handleResetAll}
        onLogout={handleLogout}
        can={can}
        activeProduct={activeProduct}
        products={products}
        onSelectActiveProduct={(id) => setActiveProductId(id)}
        onOpenSessionManager={() => setIsSessionManagerOpen(true)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        <Navbar
          isSidebarExpanded={isSidebarExpanded}
          onToggleSidebar={handleToggleSidebar}
          activeProduct={activeProduct}
          activeSessionTitle={tasks.find((t) => t.id === draftTaskId)?.title || (draftTaskId ? `草稿会话 (${draftTaskId.slice(-4)})` : '新建工作区')}
          onOpenSessionManager={() => setIsSessionManagerOpen(true)}
          onCreateNewWorkspace={handleCreateNewWorkspace}
        />

        <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-6">
          {/* VIEW ROUTING */}

          <React.Suspense
            fallback={
              <div className="py-20 text-center text-sm font-semibold text-slate-500">
                正在加载页面…
              </div>
            }
          >
          {/* 1. MATERIALS PAGE VIEW */}
          {safeActiveView === 'materials' && can('module.materials.read') && (
            <MaterialsPageView
              materials={materials}
              onAddMaterials={(newItems) =>
                setMaterials((prev) => {
                  const merged = new Map<string, MaterialItem>(
                    prev.map((item): [string, MaterialItem] => [item.id, item])
                  );
                  for (const item of newItems) merged.set(item.id, item);
                  const newIds = new Set(newItems.map((item) => item.id));
                  return [
                    ...newItems,
                    ...[...merged.values()].filter((item) => !newIds.has(item.id)),
                  ];
                })
              }
              onDeleteMaterial={handleDeleteMaterial}
              onSelectMaterial={(material) => {
                setPipelineData((prev) => ({
                  ...prev,
                  step1: {
                    ...prev.step1,
                    inputs: { ...prev.step1.inputs, mediaUrl: material.url },
                  },
                }));
                setCurrentStep(1);
                handleSetActiveView('pipeline');
              }}
              onBackToPipeline={() => handleSetActiveView('pipeline')}
            />
          )}

          {/* 2. TASKS PAGE VIEW */}
          {safeActiveView === 'tasks' && can('module.tasks.read') && (
            <TasksPageView
              tasks={tasks}
              pipelineRuns={pipelineRuns}
              onRefreshRuns={async () => setPipelineRuns(await apiService.runs.list())}
              onCancelRun={async (id) => {
                await apiService.runs.cancel(id);
                setPipelineRuns(await apiService.runs.list());
              }}
              onRetryRun={async (id, step) => {
                const run = await apiService.runs.retry(id, step);
                localStorage.setItem('aigc_active_pipeline_run_id', run.id);
                activeRunIdRef.current = run.id;
                setPipelineRuns(await apiService.runs.list());
                setIsAutoPipelineRunning(true);
                setCurrentStep(Math.min(5, Math.max(1, run.currentStep)) as StepId);
                handleSetActiveView('pipeline');
              }}
              onResumeRun={async (run) => {
                if (!(await saveCurrentDraftBeforeTransition())) return;
                setPipelineData((previous) => {
                  const next = { ...previous } as PipelineData;
                  for (const step of run.steps) {
                    const key = `step${step.step}` as keyof PipelineData;
                    const current = next[key] as any;
                    (next as any)[key] = {
                      ...current,
                      status:
                        step.status === 'completed'
                          ? 'completed'
                          : step.status === 'failed'
                            ? 'failed'
                            : ['running', 'waiting_external'].includes(step.status)
                              ? 'running'
                              : 'pending',
                      output: step.output ?? current.output,
                    };
                  }
                  return next;
                });
                setCurrentStep(Math.min(5, Math.max(1, run.currentStep)) as StepId);
                if (['queued', 'running', 'waiting_external'].includes(run.status)) {
                  localStorage.setItem('aigc_active_pipeline_run_id', run.id);
                  activeRunIdRef.current = run.id;
                  setIsAutoPipelineRunning(true);
                }
                handleSetActiveView('pipeline');
              }}
              onSelectTask={async (task) => {
                if (!(await saveCurrentDraftBeforeTransition())) return;
                const data = task.pipelineData;
                if (data?.step1) {
                  setPipelineData(data);
                }
                // Resume at failed/current step (PRD: reload for iterative refine)
                const step = (task.currentStep || 1) as StepId;
                setCurrentStep(step >= 1 && step <= 5 ? step : 1);
                if (task.id.startsWith('draft_') || task.title.includes('草稿')) {
                  setDraftTaskIdSynced(task.id);
                }
                handleSetActiveView('pipeline');
              }}
              onDeleteTask={handleDeleteTask}
              onBackToPipeline={() => handleSetActiveView('pipeline')}
            />
          )}

          {/* 3. PRESETS PAGE VIEW */}
          {safeActiveView === 'presets' && can('module.presets.read') && (
            <PresetsPageView
              presets={presets}
              onSelectPreset={handleSelectPreset}
              onBackToPipeline={() => handleSetActiveView('pipeline')}
            />
          )}

          {/* 4. MODELS PAGE VIEW */}
          {safeActiveView === 'models' && can('module.models.read') && (
            <ModelsPageView
              config={modelConfig}
              onSaveConfig={(newConfig) => setModelConfig(newConfig)}
              canWrite={can('module.models.write')}
              onBackToPipeline={() => handleSetActiveView('pipeline')}
            />
          )}

          {/* 5. KNOWLEDGE PAGE VIEW */}
          {safeActiveView === 'knowledge' && can('module.knowledge.read') && (
            <KnowledgePageView
              products={products}
              activeProductId={activeProductId}
              onSelectActiveProduct={(id) => setActiveProductId(id)}
              onUpdateProducts={handleUpdateProducts}
              onBackToPipeline={() => handleSetActiveView('pipeline')}
            />
          )}

          {/* 5b. BGM LIBRARY */}
          {safeActiveView === 'bgm' && can('module.bgm.read') && (
            <BgmPageView onBackToPipeline={() => handleSetActiveView('pipeline')} />
          )}
          </React.Suspense>

          {/* 6. MAIN PIPELINE VIEW */}
          {safeActiveView === 'pipeline' && can('module.pipeline.read') && (
            <div className="space-y-6">
              {/* Active Selling Points Banner */}
              {activeProduct && products.length > 0 ? (
              <div className="p-4 rounded-2xl bg-white border border-slate-200/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200 shrink-0">
                    <PackageCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-slate-500">工作台绑定卖点:</span>
                      <span className="text-xs font-extrabold text-indigo-900 bg-indigo-50 px-2.5 py-0.5 rounded-lg border border-indigo-200">
                        {activeProduct.name}
                      </span>
                      <span className="text-[10px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md font-medium border border-slate-200/60">
                        {activeProduct.category}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1 line-clamp-1">
                      {activeProduct.positioning} · {activeProduct.salesRecord}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end flex-wrap">
                  <select
                    value={activeProduct.id}
                    onChange={(e) => setActiveProductId(e.target.value)}
                    className="px-3 py-1.5 rounded-xl bg-white text-slate-800 border border-slate-300 text-xs font-bold focus:outline-none cursor-pointer shadow-xs hover:border-indigo-400"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id} className="bg-white text-slate-900">
                        切换产品: {p.name}
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={() => void handleSaveAsPreset()}
                    className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs transition-all shadow-xs shrink-0 flex items-center gap-1.5"
                    title="将当前 5 步流水线保存为预设模版"
                  >
                    <span>保存为预设</span>
                  </button>

                  <button
                    onClick={() => handleSetActiveView('knowledge')}
                    className="px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition-all shadow-xs shrink-0 flex items-center gap-1.5"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>切换到卖点库页面</span>
                  </button>
                </div>
              </div>
              ) : null}

              {/* Top Step Progress Indicator */}
              <StepProgress
                currentStep={currentStep}
                pipelineData={pipelineData}
                onSelectStep={setCurrentStep}
                onRunFullPipelineAuto={runFullPipelineAuto}
                onAbortFullPipeline={handleAbortFullPipeline}
                onClearWorkbench={handleClearWorkbench}
                isAutoPipelineRunning={isAutoPipelineRunning}
                autoProgress={autoProgress}
                draftSavedLabel={draftSavedLabel}
                stepSources={stepSources}
                onOpenTasks={handleOpenTasks}
                dualInputReady={(() => {
                  const { hasViral, hasProductAssets, isVideo } = canStartViralDirectOut();
                  if (!hasViral) return false;
                  if (isVideo && !hasProductAssets) return false;
                  return true;
                })()}
                dualInputHint={(() => {
                  const { hasViral, hasProductAssets, isVideo } = canStartViralDirectOut();
                  if (!hasViral) return '请先导入爆款视频或参考图';
                  if (isVideo && !hasProductAssets) {
                    return '爆款直出需要产品图：请到「品牌知识库」为当前产品上传至少 1 张产品图';
                  }
                  return undefined;
                })()}
              />

              {/* Active Step Cards Container */}
              <React.Suspense
                fallback={
                  <div className="rounded-3xl border border-slate-200 bg-white py-24 text-center text-sm font-semibold text-slate-500">
                    正在加载当前步骤…
                  </div>
                }
              >
              <div className="space-y-6">
                {currentStep === 1 && (
                  <Step1Card
                    inputs={pipelineData.step1.inputs}
                    output={pipelineData.step1.output}
                    status={pipelineData.step1.status}
                    modelConfig={modelConfig}
                    materials={materials}
                    activeProduct={activeProduct}
                    onOpenMaterials={handleOpenMaterials}
                    onUpdateInputs={handleStep1UpdateInputs}
                    onUpdateOutput={handleStep1UpdateOutput}
                    onGeneratedImage={handleStep1GeneratedImage}
                    onProductAssetsChanged={handleProductAssetsChanged}
                    onRun={runStep1}
                    onAbort={() => handleAbortCurrentStep(1)}
                    onReset={handleStep1Reset}
                    onNext={goToStep2}
                  />
                )}

                {currentStep === 2 && (
                  <Step2Card
                    inputs={pipelineData.step2.inputs}
                    output={pipelineData.step2.output}
                    step1Output={pipelineData.step1.output}
                    status={pipelineData.step2.status}
                    modelConfig={modelConfig}
                    upstreamStale={staleUpstream.step2}
                    onSyncFromStep1={handleSyncFromStep1}
                    onUpdateInputs={handleStep2UpdateInputs}
                    onUpdateOutput={handleStep2UpdateOutput}
                    onRun={runStep2}
                    onAbort={() => handleAbortCurrentStep(2)}
                    onReset={handleStep2Reset}
                    onPrev={goToStep1}
                    onNext={goToStep3}
                  />
                )}

                {currentStep === 3 && (
                  <Step3Card
                    inputs={pipelineData.step3.inputs}
                    output={pipelineData.step3.output}
                    step2Output={pipelineData.step2.output}
                    status={pipelineData.step3.status}
                    modelConfig={modelConfig}
                    upstreamStale={staleUpstream.step3}
                    onSyncFromStep2={handleSyncFromStep2}
                    onUpdateInputs={handleStep3UpdateInputs}
                    onUpdateOutput={handleStep3UpdateOutput}
                    onRun={runStep3}
                    onAbort={() => handleAbortCurrentStep(3)}
                    onReset={handleStep3Reset}
                    onPrev={goToStep2}
                    onNext={goToStep4}
                  />
                )}

                {currentStep === 4 && (
                  <Step4Card
                    inputs={pipelineData.step4.inputs}
                    output={pipelineData.step4.output}
                    step3Output={pipelineData.step3.output}
                    status={pipelineData.step4.status}
                    modelConfig={modelConfig}
                    upstreamStale={staleUpstream.step4}
                    onSyncFromStep3={handleSyncFromStep3}
                    onUpdateInputs={handleStep4UpdateInputs}
                    onRun={runStep4}
                    onAbort={() => handleAbortCurrentStep(4)}
                    onReset={handleStep4Reset}
                    onPrev={goToStep3}
                    onNext={goToStep5}
                  />
                )}

                {currentStep === 5 && (
                  <Step5Card
                    inputs={pipelineData.step5.inputs}
                    output={pipelineData.step5.output}
                    step2Output={pipelineData.step2.output}
                    step3Output={pipelineData.step3.output}
                    step4Output={pipelineData.step4.output}
                    status={pipelineData.step5.status}
                    upstreamStale={staleUpstream.step5}
                    readiness={{
                      ffmpegInstalled: engineReadiness.ffmpegInstalled,
                      publicBaseUrl: engineReadiness.publicBaseUrl,
                    }}
                    onGoStep2={goToStep2}
                    onSyncFromPrevSteps={handleSyncFromPrevSteps}
                    onUpdateInputs={handleStep5UpdateInputs}
                    onRun={runStep5}
                    onAbort={() => handleAbortCurrentStep(5)}
                    onReset={handleStep5Reset}
                    onPrev={goToStep4}
                  />
                )}
              </div>
              </React.Suspense>
            </div>
          )}
        </main>
      </div>

      {/* Onboarding Guide Modal */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        onStartAutoPipeline={runFullPipelineAuto}
        onOpenKnowledge={() => handleSetActiveView('knowledge')}
      />

      {/* Session / Workspace Manager Modal */}
      <SessionManagerModal
        isOpen={isSessionManagerOpen}
        onClose={() => setIsSessionManagerOpen(false)}
        sessions={tasks}
        currentSessionId={draftTaskId}
        onSelectSession={handleLoadWorkspace}
        onDeleteSession={handleDeleteWorkspace}
        onCreateNewWorkspace={handleCreateNewWorkspace}
      />
    </div>
  );
}

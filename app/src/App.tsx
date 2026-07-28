import React, { useState, useEffect } from 'react';
import { StepId, PipelineData, PresetTemplate, MaterialItem, TaskItem, ProductItem } from './types';
import { ModelConfigState } from './data/models';
import { Navbar } from './components/Navbar';
import { Sidebar, MainViewType } from './components/Sidebar';
import { LoginScreen } from './components/LoginScreen';
import { StepProgress, AutoPipelineProgress } from './components/StepProgress';
import { Step1Card } from './components/Step1Card';
import { Step2Card } from './components/Step2Card';
import { Step3Card } from './components/Step3Card';
import { Step4Card } from './components/Step4Card';
import { Step5Card } from './components/Step5Card';
import { OnboardingModal } from './components/OnboardingModal';

// Full View Pages for Direct View Switching
import { MaterialsPageView } from './views/MaterialsPageView';
import { TasksPageView } from './views/TasksPageView';
import { PresetsPageView } from './views/PresetsPageView';
import { ModelsPageView } from './views/ModelsPageView';
import { KnowledgePageView } from './views/KnowledgePageView';
import { BgmPageView } from './views/BgmPageView';

import { PackageCheck, Edit3 } from 'lucide-react';
import { apiService } from './services/api';

export default function App() {
  // Authentication State (Credentials: haini / 888)
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => {
    return localStorage.getItem('aigc_is_logged_in') === 'true';
  });

  // Main Active View State (Direct page switching)
  const [activeView, setActiveView] = useState<MainViewType>('pipeline');

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

  // Pipeline & Simulation States
  const [currentStep, setCurrentStep] = useState<StepId>(1);
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
    let cancelled = false;

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

        if (productList.length > 0) {
          setProducts(productList);
          setActiveProductId((prev) => prev || productList[0].id);
        }
        if (materialList.length > 0) setMaterials(materialList);
        if (taskList.length > 0) {
          setTasks(taskList);
          // Restore working draft if present
          const savedDraftId = localStorage.getItem('aigc_draft_task_id');
          if (savedDraftId) {
            const draft = taskList.find((t) => t.id === savedDraftId);
            if (draft?.pipelineData?.step1) {
              setPipelineData(draft.pipelineData);
              setCurrentStep((draft.currentStep as StepId) || 1);
              setDraftTaskId(draft.id);
            }
          }
        }
        if (presetList.length > 0) setPresets(presetList);
        if (models && models.textModels) {
          setModelConfig({
            textModels: models.textModels || [],
            imageModels: models.imageModels || [],
            videoModels: models.videoModels || [],
            autoRecommendationEnabled: models.autoRecommendationEnabled ?? true,
            defaultTextModel: models.defaultTextModel || 'DeepSeek V3',
            defaultImageModel: models.defaultImageModel || 'Imagen 4 Ultra',
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
  }, []);

  const handleUpdateProducts = (nextProducts: ProductItem[]) => {
    const prevIds = new Set(products.map((p) => p.id));
    const nextIds = new Set(nextProducts.map((p) => p.id));

    // Handle deleted items
    for (const p of products) {
      if (!nextIds.has(p.id)) {
        apiService.products.deleteProduct(p.id).catch(() => {});
      }
    }

    // Handle created or updated items
    for (const p of nextProducts) {
      if (!prevIds.has(p.id)) {
        apiService.products.createProduct(p).catch(() => {});
      } else {
        apiService.products.updateProduct(p.id, p).catch(() => {});
      }
    }

    setProducts(nextProducts);
  };

  const [modelConfig, setModelConfig] = useState<ModelConfigState>({
    textModels: [],
    imageModels: [],
    videoModels: [],
    autoRecommendationEnabled: true,
    defaultTextModel: 'DeepSeek V3',
    defaultImageModel: 'Imagen 4 Ultra',
    defaultVideoModel: 'Seedance 2.0 Fast',
  });
  const [userRole, setUserRole] = useState<'admin' | 'user'>('admin');

  // Materials & Tasks State
  const [materials, setMaterials] = useState<MaterialItem[]>([]);

  const handleDeleteMaterial = (id: string) => {
    apiService.materials.deleteMaterial(id).catch(() => {});
    setMaterials((prev) => prev.filter((m) => m.id !== id));
  };

  const [tasks, setTasks] = useState<TaskItem[]>([]);

  const handleDeleteTask = async (id: string) => {
    try {
      await apiService.tasks.deleteTask(id);
    } catch (err) {
      console.warn('[App] deleteTask failed:', err);
    }
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  // Auto-draft: refresh-safe working copy
  const [draftTaskId, setDraftTaskId] = useState<string>(
    () => localStorage.getItem('aigc_draft_task_id') || ''
  );
  const [draftSavedLabel, setDraftSavedLabel] = useState<string | null>(null);
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
        ? draftTaskId || `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
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
          setDraftTaskId(res.data.id);
          localStorage.setItem('aigc_draft_task_id', res.data.id);
          setDraftSavedLabel(
            new Date().toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          );
        }
        setTasks((prev) => {
          const rest = prev.filter((t) => t.id !== res.data.id);
          return [res.data, ...rest];
        });
        return res.data;
      }
    } catch (err) {
      console.warn('[App] persistTaskSnapshot failed:', err);
    }
    return null;
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
        alert('✅ 已保存为预设模版');
      } else {
        alert('保存预设失败');
      }
    } catch (err) {
      alert('保存预设失败，请检查后端');
    }
  };

  // Initialize pipeline data with defaults
  const [pipelineData, setPipelineData] = useState<PipelineData>({
    step1: {
      status: 'pending',
      inputs: {
        mediaUrl: '',
        platform: 'xiaohongshu',
        bloggerType: 'daily_seeding',
        viralReason: '真实晨间浴室自然光+爆款小绿泥膏体拉丝特写',
        imageModel: 'Imagen 4 Ultra',
      },
    },
    step2: {
      status: 'pending',
      inputs: {
        static_image_prompt: '',
        imageUrl: '',
        videoTone: 'xiaohongshu_healing',
        durationSec: 4,
        videoModel: 'Seedance 2.0 Fast',
      },
    },
    step3: {
      status: 'pending',
      inputs: {
        videoPrompt: '',
        targetPlatform: 'xiaohongshu',
        scriptPersona: '油皮亲妈',
      },
    },
    step4: {
      status: 'pending',
      inputs: {
        copywritingTitle: '',
        tonePreference: '治愈',
        commercialScenario: '抖音/小红书商业化',
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

  // Debounced auto-draft: any meaningful pipeline change → SQLite generating task
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

    const timer = setTimeout(() => {
      const finished =
        pipelineData.step5.status === 'completed' && Boolean(pipelineData.step5.output);
      void persistTaskSnapshot(pipelineData, {
        asDraft: true,
        status: finished ? 'completed' : 'generating',
        currentStep,
        title: finished
          ? pipelineData.step3.output?.title || '已完成反推工程'
          : '工作台草稿（自动保存）',
      });
    }, 2000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineData, currentStep, isAutoPipelineRunning]);

  // Handle Login Success
  const handleLoginSuccess = () => {
    setIsLoggedIn(true);
    localStorage.setItem('aigc_is_logged_in', 'true');

    // Requirement 4: Pop up onboarding guide immediately for new user login
    if (localStorage.getItem('aigc_onboarding_completed') !== 'true') {
      setIsOnboardingOpen(true);
    }
  };

  // Sync handlers for user-controlled re-inheritance
  const handleSyncFromStep1 = () => {
    if (pipelineData.step1.output) {
      setPipelineData((prev) => ({
        ...prev,
        step2: {
          ...prev.step2,
          inputs: {
            ...prev.step2.inputs,
            static_image_prompt: prev.step1.output!.static_image_prompt,
            imageUrl: prev.step1.inputs.mediaUrl,
          },
        },
      }));
      setStaleUpstream((s) => ({ ...s, step2: false }));
    }
  };

  const handleSyncFromStep2 = () => {
    if (pipelineData.step2.output) {
      setPipelineData((prev) => ({
        ...prev,
        step3: {
          ...prev.step3,
          inputs: {
            ...prev.step3.inputs,
            videoPrompt: prev.step2.output!.video_prompt,
          },
        },
      }));
      setStaleUpstream((s) => ({ ...s, step3: false }));
    }
  };

  const handleSyncFromStep3 = () => {
    if (pipelineData.step3.output) {
      setPipelineData((prev) => ({
        ...prev,
        step4: {
          ...prev.step4,
          inputs: {
            ...prev.step4.inputs,
            copywritingTitle: prev.step3.output!.title,
          },
        },
      }));
      setStaleUpstream((s) => ({ ...s, step4: false }));
    }
  };

  const handleSyncFromPrevSteps = () => {
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
  };

  // Full end-to-end automated reverse inference runner
  const runFullPipelineAuto = async () => {
    if (isAutoPipelineRunning) return;
    setIsAutoPipelineRunning(true);
    setActiveView('pipeline');
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

      // 2. Step 2
      markRunning(2, 'llm', 'Step 2/5 · 运镜 Prompt + 提交图生视频…');
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
      if (result2.source) setStepSources((s) => ({ ...s, 2: String(result2.source) }));

      // Wait for Seedance async video when task id present but URL not yet ready
      if (out2.seedanceTaskId && !out2.previewVideoUrl) {
        const taskId = String(out2.seedanceTaskId);
        const maxSec = 180;
        const startedAt = Date.now();
        const deadline = startedAt + maxSec * 1000;
        setAutoProgress({
          step: 2,
          phase: 'seedance_wait',
          message: 'Step 2/5 · 等待 Seedance 出片…',
          seedanceWaitSec: 0,
          seedanceMaxSec: maxSec,
        });
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));
          const waited = Math.floor((Date.now() - startedAt) / 1000);
          setAutoProgress({
            step: 2,
            phase: 'seedance_wait',
            message: `Step 2/5 · Seedance 出片中（已等 ${waited}s / ${maxSec}s）…`,
            seedanceWaitSec: waited,
            seedanceMaxSec: maxSec,
          });
          try {
            const pollRes = await fetch(`/api/seedance/generations/${encodeURIComponent(taskId)}`);
            const pollJson = await pollRes.json();
            const task = pollJson?.data;
            if (task?.url) {
              out2 = {
                ...out2,
                previewVideoUrl: task.url,
                seedanceStatus: task.status || 'success',
              };
              setAutoProgress({
                step: 2,
                phase: 'llm',
                message: 'Step 2/5 · 视频已就绪，继续文案…',
                seedanceWaitSec: waited,
                seedanceMaxSec: maxSec,
              });
              break;
            }
            const st = String(task?.status || '').toLowerCase();
            if (st === 'failed' || st === 'error') {
              throw new Error(task?.error || 'Seedance 视频生成失败');
            }
          } catch (pollErr: any) {
            if (String(pollErr?.message || '').includes('Seedance')) throw pollErr;
          }
        }
        if (!out2.previewVideoUrl) {
          // Continue pipeline with prompt-only; Step5 may fail with clear error
          out2 = {
            ...out2,
            seedanceStatus: out2.seedanceStatus || 'timeout',
            seedanceHint: '全自动等待 Seedance 超时，已继续后续文案步骤；合成前请确认视频源',
          };
        }
      }

      const updatedStep3Inputs = {
        ...working.step3.inputs,
        videoPrompt: out2.video_prompt,
      };
      working = {
        ...working,
        step2: { ...working.step2, inputs: updatedStep2Inputs, output: out2, status: 'completed' },
        step3: { ...working.step3, inputs: updatedStep3Inputs },
      };
      setPipelineData(working);
      await new Promise((r) => setTimeout(r, 400));

      // 3. Step 3
      markRunning(3, 'llm', 'Step 3/5 · 爆款文案生成…');
      const res3 = await fetch('/api/pipeline/step3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updatedStep3Inputs,
          ...productPayload(),
        }),
      });
      const result3 = await res3.json();
      if (!result3.success || !result3.data) throw new Error(result3.error || 'Step 3 failed');
      const out3 = result3.data;
      if (result3.source) setStepSources((s) => ({ ...s, 3: String(result3.source) }));

      const updatedStep4Inputs = {
        ...working.step4.inputs,
        copywritingTitle: out3.title,
      };
      working = {
        ...working,
        step3: { ...working.step3, inputs: updatedStep3Inputs, output: out3, status: 'completed' },
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
      await persistTaskSnapshot(finalSnapshot, {
        status: 'completed',
        currentStep: 5,
        title: out3.title,
        asDraft: true,
      });
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
      alert(`全自动已停在 Step ${failedStep}\n${msg}`);
    } finally {
      setIsAutoPipelineRunning(false);
      setTimeout(() => setAutoProgress(null), 4000);
    }
  };

  // Reset entire pipeline
  const handleResetAll = () => {
    setStepSources({});
    setDraftSavedLabel(null);
    setStaleUpstream({ step2: false, step3: false, step4: false, step5: false });
    setPipelineData({
      step1: {
        status: 'pending',
        inputs: {
          mediaUrl: '',
          platform: 'xiaohongshu',
          bloggerType: 'daily_seeding',
          viralReason: '',
          imageModel: 'Imagen 4 Ultra',
        },
      },
      step2: {
        status: 'pending',
        inputs: {
          static_image_prompt: '',
          imageUrl: '',
          videoTone: 'xiaohongshu_healing',
          durationSec: 4,
          videoModel: 'Seedance 2.0 Fast',
        },
      },
      step3: {
        status: 'pending',
        inputs: {
          videoPrompt: '',
          targetPlatform: 'xiaohongshu',
          scriptPersona: '油皮亲妈',
        },
      },
      step4: {
        status: 'pending',
        inputs: {
          copywritingTitle: '',
          tonePreference: '治愈',
          commercialScenario: '抖音/小红书商业化',
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
    setActiveView('pipeline');
  };

  // Load a Preset Template
  const handleSelectPreset = (preset: PresetTemplate) => {
    const data = preset.pipelineData;
    if (!data?.step1 || !data?.step2 || !data?.step3 || !data?.step4 || !data?.step5) {
      alert('该预设缺少完整流水线数据，无法载入');
      return;
    }
    setPipelineData(data);
    setCurrentStep(1);
    setActiveView('pipeline');
  };

  const productPayload = () => ({
    productId: activeProduct?.id,
    productInfo: activeProduct,
  });

  // Step 1 Execution
  const runStep1 = async () => {
    setPipelineData((prev) => ({
      ...prev,
      step1: { ...prev.step1, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          const next = {
            ...prev,
            step1: { ...prev.step1, output, status: 'completed' as const },
            step2: {
              ...prev.step2,
              // Manual mode: only auto-fill inputs if step2 not yet completed
              inputs: {
                ...prev.step2.inputs,
                static_image_prompt: prev.step2.output
                  ? prev.step2.inputs.static_image_prompt
                  : output.static_image_prompt,
                imageUrl: prev.step2.output ? prev.step2.inputs.imageUrl : prev.step1.inputs.mediaUrl,
              },
            },
          };
          if (prev.step2.output || prev.step3.output || prev.step4.output || prev.step5.output) {
            markDownstreamStale(1, prev);
          } else {
            next.step2.inputs.static_image_prompt = output.static_image_prompt;
            next.step2.inputs.imageUrl = prev.step1.inputs.mediaUrl;
          }
          return next;
        });
      } else {
        alert(result.error || 'Step 1 运行失败');
        setPipelineData((prev) => ({
          ...prev,
          step1: { ...prev.step1, status: 'failed' },
        }));
      }
    } catch (e) {
      console.error('Step1 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step1: { ...prev.step1, status: 'failed' },
      }));
    }
  };

  // Step 2 Execution
  const runStep2 = async () => {
    setPipelineData((prev) => ({
      ...prev,
      step2: { ...prev.step2, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...pipelineData.step2.inputs,
          ...productPayload(),
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
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
        alert(result.error || 'Step 2 运行失败');
        setPipelineData((prev) => ({
          ...prev,
          step2: { ...prev.step2, status: 'failed' },
        }));
      }
    } catch (e) {
      console.error('Step2 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step2: { ...prev.step2, status: 'failed' },
      }));
    }
  };

  // Step 3 Execution
  const runStep3 = async () => {
    setPipelineData((prev) => ({
      ...prev,
      step3: { ...prev.step3, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        alert(result.error || 'Step 3 运行失败');
        setPipelineData((prev) => ({
          ...prev,
          step3: { ...prev.step3, status: 'failed' },
        }));
      }
    } catch (e) {
      console.error('Step3 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step3: { ...prev.step3, status: 'failed' },
      }));
    }
  };

  // Step 4 Execution
  const runStep4 = async () => {
    setPipelineData((prev) => ({
      ...prev,
      step4: { ...prev.step4, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        alert(result.error || 'Step 4 运行失败');
        setPipelineData((prev) => ({
          ...prev,
          step4: { ...prev.step4, status: 'failed' },
        }));
      }
    } catch (e) {
      console.error('Step4 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step4: { ...prev.step4, status: 'failed' },
      }));
    }
  };

  // Step 5 Execution
  const runStep5 = async () => {
    setPipelineData((prev) => ({
      ...prev,
      step5: { ...prev.step5, status: 'running' },
    }));

    try {
      const res = await fetch('/api/pipeline/step5', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        alert(result.error || 'Step 5 运行失败');
        setPipelineData((prev) => ({
          ...prev,
          step5: { ...prev.step5, status: 'failed' },
        }));
      }
    } catch (e) {
      console.error('Step5 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step5: { ...prev.step5, status: 'failed' },
      }));
    }
  };

  // Render Login Screen if not authenticated
  if (!isLoggedIn) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="flex min-h-screen bg-[#f8fafc] text-slate-900 font-sans selection:bg-indigo-600 selection:text-white transition-colors">
      {/* Resizable Sidebar */}
      <Sidebar
        sidebarWidth={sidebarWidth}
        setSidebarWidth={handleSetSidebarWidth}
        isExpanded={isSidebarExpanded}
        onToggleExpand={handleToggleSidebar}
        activeView={activeView}
        onChangeView={(view) => setActiveView(view)}
        onOpenOnboarding={() => setIsOnboardingOpen(true)}
        onResetAll={handleResetAll}
        activeProduct={activeProduct}
        products={products}
        onSelectActiveProduct={(id) => setActiveProductId(id)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        <Navbar
          isSidebarExpanded={isSidebarExpanded}
          onToggleSidebar={handleToggleSidebar}
          activeProduct={activeProduct}
        />

        <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-6">
          {/* VIEW ROUTING */}


          {/* 1. MATERIALS PAGE VIEW */}
          {activeView === 'materials' && (
            <MaterialsPageView
              materials={materials}
              onAddMaterials={(newItems) => setMaterials((prev) => [...newItems, ...prev])}
              onDeleteMaterial={handleDeleteMaterial}
              onSelectMaterial={(material) => {
                setPipelineData((prev) => ({
                  ...prev,
                  step1: {
                    ...prev.step1,
                    inputs: { ...prev.step1.inputs, mediaUrl: material.url },
                  },
                }));
                setActiveView('pipeline');
              }}
              onBackToPipeline={() => setActiveView('pipeline')}
            />
          )}

          {/* 2. TASKS PAGE VIEW */}
          {activeView === 'tasks' && (
            <TasksPageView
              tasks={tasks}
              onSelectTask={(task) => {
                const data = task.pipelineData;
                if (data?.step1) {
                  setPipelineData(data);
                }
                // Resume at failed/current step (PRD: reload for iterative refine)
                const step = (task.currentStep || 1) as StepId;
                setCurrentStep(step >= 1 && step <= 5 ? step : 1);
                if (task.id.startsWith('draft_') || task.title.includes('草稿')) {
                  setDraftTaskId(task.id);
                  localStorage.setItem('aigc_draft_task_id', task.id);
                }
                setActiveView('pipeline');
              }}
              onDeleteTask={handleDeleteTask}
              onBackToPipeline={() => setActiveView('pipeline')}
            />
          )}

          {/* 3. PRESETS PAGE VIEW */}
          {activeView === 'presets' && (
            <PresetsPageView
              presets={presets}
              onSelectPreset={handleSelectPreset}
              onBackToPipeline={() => setActiveView('pipeline')}
            />
          )}

          {/* 4. MODELS PAGE VIEW */}
          {activeView === 'models' && (
            <ModelsPageView
              config={modelConfig}
              onSaveConfig={(newConfig) => setModelConfig(newConfig)}
              userRole={userRole}
              onToggleRole={() => setUserRole((prev) => (prev === 'admin' ? 'user' : 'admin'))}
              onBackToPipeline={() => setActiveView('pipeline')}
            />
          )}

          {/* 5. KNOWLEDGE PAGE VIEW */}
          {activeView === 'knowledge' && (
            <KnowledgePageView
              products={products}
              activeProductId={activeProductId}
              onSelectActiveProduct={(id) => setActiveProductId(id)}
              onUpdateProducts={handleUpdateProducts}
              onBackToPipeline={() => setActiveView('pipeline')}
            />
          )}

          {/* 5b. BGM LIBRARY */}
          {activeView === 'bgm' && (
            <BgmPageView onBackToPipeline={() => setActiveView('pipeline')} />
          )}

          {/* 6. MAIN PIPELINE VIEW */}
          {activeView === 'pipeline' && (
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
                    onClick={() => setActiveView('knowledge')}
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
                onSelectStep={(stepId) => setCurrentStep(stepId)}
                onRunFullPipelineAuto={runFullPipelineAuto}
                isAutoPipelineRunning={isAutoPipelineRunning}
                autoProgress={autoProgress}
                draftSavedLabel={draftSavedLabel}
                stepSources={stepSources}
                onOpenTasks={() => setActiveView('tasks')}
              />

              {/* Active Step Cards Container */}
              <div className="space-y-6">
                {currentStep === 1 && (
                  <Step1Card
                    inputs={pipelineData.step1.inputs}
                    output={pipelineData.step1.output}
                    status={pipelineData.step1.status}
                    modelConfig={modelConfig}
                    materials={materials}
                    activeProduct={activeProduct}
                    onOpenMaterials={() => setActiveView('materials')}
                    onUpdateInputs={(inp) =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step1: { ...prev.step1, inputs: { ...prev.step1.inputs, ...inp } },
                      }))
                    }
                    onUpdateOutput={(updated) =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step1: {
                          ...prev.step1,
                          output: prev.step1.output ? { ...prev.step1.output, ...updated } : undefined,
                        },
                      }))
                    }
                    onGeneratedImage={({ imageUrl, promptUsed }) => {
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
                      }));
                    }}
                    onRun={runStep1}
                    onReset={() =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step1: { ...prev.step1, status: 'pending', output: undefined },
                      }))
                    }
                    onNext={() => setCurrentStep(2)}
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
                    onUpdateInputs={(inp) =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step2: { ...prev.step2, inputs: { ...prev.step2.inputs, ...inp } },
                      }))
                    }
                    onUpdateOutput={(updated) =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step2: {
                          ...prev.step2,
                          output: prev.step2.output ? { ...prev.step2.output, ...updated } : undefined,
                        },
                      }))
                    }
                    onRun={runStep2}
                    onReset={() =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step2: { ...prev.step2, status: 'pending', output: undefined },
                      }))
                    }
                    onPrev={() => setCurrentStep(1)}
                    onNext={() => setCurrentStep(3)}
                  />
                )}

                {currentStep === 3 && (
                  <Step3Card
                    inputs={pipelineData.step3.inputs}
                    output={pipelineData.step3.output}
                    step2Output={pipelineData.step2.output}
                    status={pipelineData.step3.status}
                    upstreamStale={staleUpstream.step3}
                    onSyncFromStep2={handleSyncFromStep2}
                    onUpdateInputs={(inp) =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step3: { ...prev.step3, inputs: { ...prev.step3.inputs, ...inp } },
                      }))
                    }
                    onUpdateOutput={(updated) =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step3: {
                          ...prev.step3,
                          output: prev.step3.output ? { ...prev.step3.output, ...updated } : undefined,
                        },
                      }))
                    }
                    onRun={runStep3}
                    onReset={() =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step3: { ...prev.step3, status: 'pending', output: undefined },
                      }))
                    }
                    onPrev={() => setCurrentStep(2)}
                    onNext={() => setCurrentStep(4)}
                  />
                )}

                {currentStep === 4 && (
                  <Step4Card
                    inputs={pipelineData.step4.inputs}
                    output={pipelineData.step4.output}
                    step3Output={pipelineData.step3.output}
                    status={pipelineData.step4.status}
                    upstreamStale={staleUpstream.step4}
                    onSyncFromStep3={handleSyncFromStep3}
                    onUpdateInputs={(inp) =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step4: { ...prev.step4, inputs: { ...prev.step4.inputs, ...inp } },
                      }))
                    }
                    onRun={runStep4}
                    onReset={() =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step4: { ...prev.step4, status: 'pending', output: undefined },
                      }))
                    }
                    onPrev={() => setCurrentStep(3)}
                    onNext={() => setCurrentStep(5)}
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
                    onGoStep2={() => setCurrentStep(2)}
                    onSyncFromPrevSteps={handleSyncFromPrevSteps}
                    onUpdateInputs={(inp) =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step5: { ...prev.step5, inputs: { ...prev.step5.inputs, ...inp } },
                      }))
                    }
                    onRun={runStep5}
                    onReset={() =>
                      setPipelineData((prev) => ({
                        ...prev,
                        step5: { ...prev.step5, status: 'pending', output: undefined },
                      }))
                    }
                    onPrev={() => setCurrentStep(4)}
                  />
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Onboarding Guide Modal */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        onStartAutoPipeline={runFullPipelineAuto}
        onOpenKnowledge={() => setActiveView('knowledge')}
      />
    </div>
  );
}

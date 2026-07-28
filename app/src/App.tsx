import React, { useState, useEffect } from 'react';
import { StepId, PipelineData, PresetTemplate, MaterialItem, TaskItem, ProductItem } from './types';
import { MOCK_PRESET_TEMPLATES, INITIAL_PRODUCTS } from './data/presets';
import { DEFAULT_MODEL_CONFIG, ModelConfigState } from './data/models';
import { Navbar } from './components/Navbar';
import { Sidebar, MainViewType } from './components/Sidebar';
import { LoginScreen } from './components/LoginScreen';
import { StepProgress } from './components/StepProgress';
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
  const [useMockMode, setUseMockMode] = useState<boolean>(false);
  const [isAutoPipelineRunning, setIsAutoPipelineRunning] = useState<boolean>(false);

  // Products / Selling Points State
  const [products, setProducts] = useState<ProductItem[]>(INITIAL_PRODUCTS);
  const [activeProductId, setActiveProductId] = useState<string>(INITIAL_PRODUCTS[0].id);
  const activeProduct = products.find((p) => p.id === activeProductId) || products[0] || INITIAL_PRODUCTS[0];

  useEffect(() => {
    apiService.products
      .fetchProducts()
      .then((data) => {
        if (data && data.length > 0) {
          setProducts(data);
          setActiveProductId(data[0].id);
        }
      })
      .catch((err) => console.warn('[App] SQLite products fetch fallback:', err));
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

  const [modelConfig, setModelConfig] = useState<ModelConfigState>(DEFAULT_MODEL_CONFIG);
  const [userRole, setUserRole] = useState<'admin' | 'user'>('admin');

  // Materials & Tasks State
  const [materials, setMaterials] = useState<MaterialItem[]>([
    {
      id: 'mat_1',
      name: '纯净高质感膏体拉丝.mp4',
      url: MOCK_PRESET_TEMPLATES[0]?.coverImage || 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
      type: 'image',
      size: '2.4 MB',
      createdAt: '10:30',
    },
    {
      id: 'mat_2',
      name: '沉浸式晨间洗漱与泡泡揉搓.mp4',
      url: MOCK_PRESET_TEMPLATES[1]?.coverImage || 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
      type: 'image',
      size: '4.8 MB',
      createdAt: '11:15',
    },
    {
      id: 'mat_3',
      name: '油敏肌高清毛孔对比特写.mp4',
      url: MOCK_PRESET_TEMPLATES[2]?.coverImage || 'https://images.unsplash.com/photo-1512290900673-7002fffe929a?auto=format&fit=crop&w=600&q=80',
      type: 'image',
      size: '3.1 MB',
      createdAt: '12:00',
    },
  ]);

  const [tasks, setTasks] = useState<TaskItem[]>([
    {
      id: 'TASK-883921',
      title: '高奢治愈系小绿泥反推任务 #1',
      createdAt: new Date().toLocaleString(),
      status: 'completed',
      currentStep: 5,
      pipelineData: MOCK_PRESET_TEMPLATES[0].data,
      thumbnailUrl: MOCK_PRESET_TEMPLATES[0]?.coverImage,
    },
  ]);

  // Initialize pipeline data with defaults
  const [pipelineData, setPipelineData] = useState<PipelineData>({
    step1: {
      status: 'pending',
      inputs: {
        mediaUrl: MOCK_PRESET_TEMPLATES[0].coverImage,
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
  };

  // Full end-to-end automated reverse inference runner
  const runFullPipelineAuto = async () => {
    if (isAutoPipelineRunning) return;
    setIsAutoPipelineRunning(true);
    setActiveView('pipeline');

    try {
      // 1. Step 1 Execution
      setCurrentStep(1);
      setPipelineData((prev) => ({
        ...prev,
        step1: { ...prev.step1, status: 'running' },
      }));

      const res1 = await fetch('/api/pipeline/step1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...pipelineData.step1.inputs,
          productInfo: activeProduct,
        }),
      });
      const result1 = await res1.json();
      if (!result1.success || !result1.data) throw new Error('Step 1 failed');
      const out1 = result1.data;

      const updatedStep2Inputs = {
        ...pipelineData.step2.inputs,
        static_image_prompt: out1.static_image_prompt,
        imageUrl: pipelineData.step1.inputs.mediaUrl,
      };

      setPipelineData((prev) => ({
        ...prev,
        step1: { ...prev.step1, output: out1, status: 'completed' },
        step2: { ...prev.step2, inputs: updatedStep2Inputs },
      }));

      await new Promise((r) => setTimeout(r, 600));

      // 2. Step 2 Execution
      setCurrentStep(2);
      setPipelineData((prev) => ({
        ...prev,
        step2: { ...prev.step2, status: 'running' },
      }));

      const res2 = await fetch('/api/pipeline/step2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updatedStep2Inputs,
          productInfo: activeProduct,
        }),
      });
      const result2 = await res2.json();
      if (!result2.success || !result2.data) throw new Error('Step 2 failed');
      const out2 = result2.data;

      const updatedStep3Inputs = {
        ...pipelineData.step3.inputs,
        videoPrompt: out2.video_prompt,
      };

      setPipelineData((prev) => ({
        ...prev,
        step2: { ...prev.step2, output: out2, status: 'completed' },
        step3: { ...prev.step3, inputs: updatedStep3Inputs },
      }));

      await new Promise((r) => setTimeout(r, 600));

      // 3. Step 3 Execution
      setCurrentStep(3);
      setPipelineData((prev) => ({
        ...prev,
        step3: { ...prev.step3, status: 'running' },
      }));

      const res3 = await fetch('/api/pipeline/step3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updatedStep3Inputs,
          productInfo: activeProduct,
        }),
      });
      const result3 = await res3.json();
      if (!result3.success || !result3.data) throw new Error('Step 3 failed');
      const out3 = result3.data;

      const updatedStep4Inputs = {
        ...pipelineData.step4.inputs,
        copywritingTitle: out3.title,
      };

      setPipelineData((prev) => ({
        ...prev,
        step3: { ...prev.step3, output: out3, status: 'completed' },
        step4: { ...prev.step4, inputs: updatedStep4Inputs },
      }));

      await new Promise((r) => setTimeout(r, 600));

      // 4. Step 4 Execution
      setCurrentStep(4);
      setPipelineData((prev) => ({
        ...prev,
        step4: { ...prev.step4, status: 'running' },
      }));

      const res4 = await fetch('/api/pipeline/step4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updatedStep4Inputs,
          productInfo: activeProduct,
        }),
      });
      const result4 = await res4.json();
      if (!result4.success || !result4.data) throw new Error('Step 4 failed');
      const out4 = result4.data;

      setPipelineData((prev) => ({
        ...prev,
        step4: { ...prev.step4, output: out4, status: 'completed' },
      }));

      await new Promise((r) => setTimeout(r, 600));

      // 5. Step 5 Execution
      setCurrentStep(5);
      setPipelineData((prev) => ({
        ...prev,
        step5: { ...prev.step5, status: 'running' },
      }));

      const res5 = await fetch('/api/pipeline/step5', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...pipelineData.step5.inputs,
          videoPrompt: out2.video_prompt,
          title: out3.title,
          bgmTrack: out4.bgm_recommendation.track_name,
          productInfo: activeProduct,
        }),
      });
      const result5 = await res5.json();
      if (!result5.success || !result5.data) throw new Error('Step 5 failed');
      const out5 = result5.data;

      setPipelineData((prev) => ({
        ...prev,
        step5: { ...prev.step5, output: out5, status: 'completed' },
      }));
    } catch (e) {
      console.error('Auto pipeline run error:', e);
    } finally {
      setIsAutoPipelineRunning(false);
    }
  };

  // Reset entire pipeline
  const handleResetAll = () => {
    setPipelineData({
      step1: {
        status: 'pending',
        inputs: {
          mediaUrl: MOCK_PRESET_TEMPLATES[0].coverImage,
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
    setPipelineData(preset.data);
    setCurrentStep(1);
    setActiveView('pipeline');
  };

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
          productInfo: activeProduct,
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        setPipelineData((prev) => ({
          ...prev,
          step1: { ...prev.step1, output, status: 'completed' },
          step2: {
            ...prev.step2,
            inputs: {
              ...prev.step2.inputs,
              static_image_prompt: output.static_image_prompt,
              imageUrl: prev.step1.inputs.mediaUrl,
            },
          },
        }));
      }
    } catch (e) {
      console.error('Step1 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step1: { ...prev.step1, status: 'pending' },
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
          productInfo: activeProduct,
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        setPipelineData((prev) => ({
          ...prev,
          step2: { ...prev.step2, output, status: 'completed' },
          step3: {
            ...prev.step3,
            inputs: {
              ...prev.step3.inputs,
              videoPrompt: output.video_prompt,
            },
          },
        }));
      }
    } catch (e) {
      console.error('Step2 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step2: { ...prev.step2, status: 'pending' },
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
          productInfo: activeProduct,
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        setPipelineData((prev) => ({
          ...prev,
          step3: { ...prev.step3, output, status: 'completed' },
          step4: {
            ...prev.step4,
            inputs: {
              ...prev.step4.inputs,
              copywritingTitle: output.title,
            },
          },
        }));
      }
    } catch (e) {
      console.error('Step3 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step3: { ...prev.step3, status: 'pending' },
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
          productInfo: activeProduct,
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        setPipelineData((prev) => ({
          ...prev,
          step4: { ...prev.step4, output, status: 'completed' },
        }));
      }
    } catch (e) {
      console.error('Step4 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step4: { ...prev.step4, status: 'pending' },
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
          bgmTrack: pipelineData.step4.output?.bgm_recommendation.track_name,
          productInfo: activeProduct,
        }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        const output = result.data;
        setPipelineData((prev) => ({
          ...prev,
          step5: { ...prev.step5, output, status: 'completed' },
        }));
      }
    } catch (e) {
      console.error('Step5 run failed:', e);
      setPipelineData((prev) => ({
        ...prev,
        step5: { ...prev.step5, status: 'pending' },
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
        useMockMode={useMockMode}
        setUseMockMode={setUseMockMode}
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
          useMockMode={useMockMode}
        />

        <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-6">
          {/* VIEW ROUTING */}


          {/* 1. MATERIALS PAGE VIEW */}
          {activeView === 'materials' && (
            <MaterialsPageView
              materials={materials}
              onAddMaterials={(newItems) => setMaterials((prev) => [...newItems, ...prev])}
              onDeleteMaterial={(id) => setMaterials((prev) => prev.filter((m) => m.id !== id))}
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
                setPipelineData(task.pipelineData);
                setCurrentStep(task.currentStep || 1);
                setActiveView('pipeline');
              }}
              onDeleteTask={(id) => setTasks((prev) => prev.filter((t) => t.id !== id))}
              onBackToPipeline={() => setActiveView('pipeline')}
            />
          )}

          {/* 3. PRESETS PAGE VIEW */}
          {activeView === 'presets' && (
            <PresetsPageView
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

          {/* 6. MAIN PIPELINE VIEW */}
          {activeView === 'pipeline' && (
            <div className="space-y-6">
              {/* Active Selling Points Banner */}
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

                <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
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
                    onClick={() => setActiveView('knowledge')}
                    className="px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition-all shadow-xs shrink-0 flex items-center gap-1.5"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>切换到卖点库页面</span>
                  </button>
                </div>
              </div>

              {/* Top Step Progress Indicator */}
              <StepProgress
                currentStep={currentStep}
                pipelineData={pipelineData}
                onSelectStep={(stepId) => setCurrentStep(stepId)}
                onRunFullPipelineAuto={runFullPipelineAuto}
                isAutoPipelineRunning={isAutoPipelineRunning}
              />

              {/* Active Step Cards Container */}
              <div className="space-y-6">
                {currentStep === 1 && (
                  <Step1Card
                    inputs={pipelineData.step1.inputs}
                    output={pipelineData.step1.output}
                    status={pipelineData.step1.status}
                    useMockMode={useMockMode}
                    modelConfig={modelConfig}
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
                    useMockMode={useMockMode}
                    modelConfig={modelConfig}
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
                    useMockMode={useMockMode}
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
                    useMockMode={useMockMode}
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
                    useMockMode={useMockMode}
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

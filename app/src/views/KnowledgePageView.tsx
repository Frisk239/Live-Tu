import React, { useState } from 'react';
import { ProductItem, SellingPointsAiModel } from '../types';
import { PRODUCT_TEMPLATES, INITIAL_PRODUCTS } from '../data/presets';
import {
  ShieldCheck,
  Award,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Layers,
  Plus,
  Trash2,
  Check,
  RotateCcw,
  Package,
  Cpu,
  Zap,
  ArrowLeft,
} from 'lucide-react';

interface KnowledgePageViewProps {
  products: ProductItem[];
  activeProductId: string;
  onSelectActiveProduct: (productId: string) => void;
  onUpdateProducts: (products: ProductItem[]) => void;
  onBackToPipeline: () => void;
}

export const KnowledgePageView: React.FC<KnowledgePageViewProps> = ({
  products,
  activeProductId,
  onSelectActiveProduct,
  onUpdateProducts,
  onBackToPipeline,
}) => {
  const [selectedProductId, setSelectedProductId] = useState<string>(activeProductId);
  const [selectedAiModel, setSelectedAiModel] = useState<SellingPointsAiModel>('deepseek-v3');
  const [isOptimizing, setIsOptimizing] = useState<boolean>(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState<boolean>(false);

  const currentProduct = products.find((p) => p.id === selectedProductId) || products[0] || INITIAL_PRODUCTS[0];
  const isActive = currentProduct.id === activeProductId;

  const handleFieldChange = (fieldPath: string, value: any) => {
    const updatedProducts = products.map((p) => {
      if (p.id !== currentProduct.id) return p;

      if (fieldPath.startsWith('model343.')) {
        const subField = fieldPath.split('.')[1];
        return {
          ...p,
          model343: { ...p.model343, [subField]: value },
          updatedAt: new Date().toISOString().split('T')[0],
        };
      }
      if (fieldPath.startsWith('sgsData.')) {
        const subField = fieldPath.split('.')[1];
        return {
          ...p,
          sgsData: { ...p.sgsData, [subField]: value },
          updatedAt: new Date().toISOString().split('T')[0],
        };
      }
      if (fieldPath === 'prohibitedWords') {
        const words = typeof value === 'string' ? value.split(/[,，\n]/).map((w) => w.trim()).filter(Boolean) : value;
        return { ...p, prohibitedWords: words, updatedAt: new Date().toISOString().split('T')[0] };
      }
      return { ...p, [fieldPath]: value, updatedAt: new Date().toISOString().split('T')[0] };
    });

    onUpdateProducts(updatedProducts);
  };

  const handleAddNewProductFromTemplate = (template: Partial<ProductItem>) => {
    const newId = 'prod_custom_' + Date.now();
    const newProduct: ProductItem = {
      id: newId,
      name: template.name?.replace('模板', '') || '自定义产品',
      category: template.category || '护肤美妆',
      positioning: template.positioning || '高效功效 · 专研成分',
      price: template.price || '99元',
      salesRecord: template.salesRecord || '爆款推荐 / 高好评率',
      coverImage: template.coverImage || 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
      model343: template.model343 || {
        clays: '核心成分 1',
        extracts: '植萃成分 2',
        surfactants: '温和配方 3',
      },
      sgsData: template.sgsData || {
        oil8h: '即刻改善 +50%',
        oil14d: '14天实测提升 +30%',
        blackhead14d: '28天指标改善 +25%',
      },
      prohibitedWords: template.prohibitedWords || ['绝对第一', '百分百根治'],
      targetAudience: template.targetAudience || '注重品质与性价比的年轻消费群体',
      customSellingPoints: template.customSellingPoints || '请输入产品核心特色...',
      updatedAt: new Date().toISOString().split('T')[0],
    };

    const nextProducts = [...products, newProduct];
    onUpdateProducts(nextProducts);
    setSelectedProductId(newId);
    setShowTemplateMenu(false);
  };

  const handleDeleteProduct = (productId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (products.length <= 1) {
      alert('卖点库至少保留 1 个产品，无法删除！');
      return;
    }
    const filtered = products.filter((p) => p.id !== productId);
    onUpdateProducts(filtered);
    if (selectedProductId === productId) {
      setSelectedProductId(filtered[0].id);
    }
    if (activeProductId === productId) {
      onSelectActiveProduct(filtered[0].id);
    }
  };

  const handleResetDefaults = () => {
    if (confirm('确认重置卖点库为初始品牌产品预设吗？')) {
      onUpdateProducts(INITIAL_PRODUCTS);
      setSelectedProductId(INITIAL_PRODUCTS[0].id);
      onSelectActiveProduct(INITIAL_PRODUCTS[0].id);
    }
  };

  const handleOptimizeWithAi = async () => {
    setIsOptimizing(true);
    try {
      const res = await fetch('/api/selling-points/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product: currentProduct,
          aiModel: selectedAiModel,
        }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        const opt = json.data;
        const updated = products.map((p) => {
          if (p.id !== currentProduct.id) return p;
          return {
            ...p,
            name: opt.name || p.name,
            positioning: opt.positioning || p.positioning,
            price: opt.price || p.price,
            salesRecord: opt.salesRecord || p.salesRecord,
            model343: opt.model343 || p.model343,
            sgsData: opt.sgsData || p.sgsData,
            prohibitedWords: opt.prohibitedWords || p.prohibitedWords,
            targetAudience: opt.targetAudience || p.targetAudience,
            customSellingPoints: opt.customSellingPoints || p.customSellingPoints,
            updatedAt: new Date().toISOString().split('T')[0],
          };
        });
        onUpdateProducts(updated);
      }
    } catch (err) {
      console.error('AI Selling points optimization failed:', err);
    } finally {
      setIsOptimizing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBackToPipeline}
            className="p-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 shadow-2xs transition-all flex items-center gap-1.5 text-xs font-semibold shrink-0 cursor-pointer"
            title="返回主工作台"
          >
            <ArrowLeft className="w-4 h-4 text-slate-500" />
            <span>返回工作台</span>
          </button>

          <div className="p-3 rounded-xl bg-blue-50 text-blue-600 border border-blue-200/60 shrink-0">
            <Sparkles className="w-6 h-6" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">品牌卖点与知识资产库</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60 text-[11px] font-semibold">
                BRAND KNOWLEDGE
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              定义产品矩阵、核心配方343模型、SGS试验权威数据与禁忌词，为AI全步骤反推注入精准依据。
            </p>
          </div>
        </div>

        {/* AI Engine Selector */}
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/80 p-2 rounded-xl shadow-2xs">
          <Cpu className="w-4 h-4 text-blue-600 shrink-0" />
          <span className="text-xs text-slate-600 font-semibold">润色模型:</span>
          <select
            value={selectedAiModel}
            onChange={(e) => setSelectedAiModel(e.target.value as SellingPointsAiModel)}
            className="bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-medium text-slate-800 focus:outline-none focus:border-blue-500 cursor-pointer shadow-2xs"
          >
            <option value="deepseek-v3">🤖 DeepSeek V3 (建议首选)</option>
            <option value="deepseek-r1">🧠 DeepSeek R1 (思维链推理)</option>
            <option value="gpt-4o">⚡ GPT-4o (OpenAI 旗舰)</option>
            <option value="gemini-3.6-flash">✨ Gemini 3.6 Flash</option>
            <option value="claude-3.5-sonnet">🖋️ Claude 3.5 Sonnet</option>
          </select>
        </div>
      </div>

      {/* Main Content Layout: Left Products + Right Details */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-2xs grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Products Management */}
        <div className="lg:col-span-4 border-r border-slate-100 pr-0 lg:pr-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <Package className="w-4 h-4 text-slate-500" />
              <span>品牌产品列表 ({products.length})</span>
            </span>

            <div className="relative">
              <button
                onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-2xs text-xs font-semibold transition-all flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>新增产品</span>
              </button>

              {showTemplateMenu && (
                <div className="absolute right-0 top-10 z-30 w-60 bg-white border border-slate-200/90 rounded-xl shadow-xl p-2 space-y-1">
                  <div className="px-2.5 py-1 text-[10px] font-semibold text-slate-400 uppercase">
                    从预设行业模板加载
                  </div>
                  {PRODUCT_TEMPLATES.map((tmpl, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleAddNewProductFromTemplate(tmpl)}
                      className="w-full text-left px-3 py-2 rounded-lg text-xs text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-between cursor-pointer"
                    >
                      <span className="font-medium truncate">{tmpl.name}</span>
                      <span className="text-[10px] text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200/60">
                        {tmpl.category}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {products.map((prod) => {
              const isSelected = prod.id === selectedProductId;
              const isCurrentActive = prod.id === activeProductId;

              return (
                <div
                  key={prod.id}
                  onClick={() => setSelectedProductId(prod.id)}
                  className={`p-4 rounded-xl border transition-all cursor-pointer relative group ${
                    isSelected
                      ? 'bg-blue-50/50 border-blue-300 shadow-2xs'
                      : 'bg-white hover:bg-slate-50 border-slate-200/80 shadow-2xs'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-sm text-slate-900 truncate">
                          {prod.name}
                        </span>
                        {isCurrentActive && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-0.5 shrink-0">
                            <Check className="w-3 h-3 text-emerald-600" />
                            工作台生效
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 truncate">{prod.positioning}</p>
                      <div className="flex items-center gap-2 mt-2 text-[11px]">
                        <span className="px-2 py-0.5 bg-slate-100 rounded-md border border-slate-200/80 font-medium text-slate-600">
                          {prod.category}
                        </span>
                        <span className="text-slate-700 font-semibold">{prod.price}</span>
                      </div>
                    </div>

                    <button
                      onClick={(e) => handleDeleteProduct(prod.id, e)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-all cursor-pointer"
                      title="删除产品"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-4 border-t border-slate-100">
            <button
              onClick={handleResetDefaults}
              className="w-full px-4 py-2.5 rounded-lg border border-slate-200/80 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors flex items-center justify-center gap-2 shadow-2xs cursor-pointer"
            >
              <RotateCcw className="w-4 h-4 text-slate-500" />
              <span>重置为初始爆款卖点库</span>
            </button>
          </div>
        </div>

        {/* Right Column: Active Product Details Form */}
        <div className="lg:col-span-8 space-y-6">
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200/60">
                  {currentProduct.category}
                </span>
                <h2 className="text-base font-bold text-slate-900">{currentProduct.name}</h2>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                数据更新时间: {currentProduct.updatedAt || '实时云端持久化'}
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {!isActive ? (
                <button
                  onClick={() => onSelectActiveProduct(currentProduct.id)}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>切换为当前工作台生效产品</span>
                </button>
              ) : (
                <span className="px-3.5 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold shadow-2xs flex items-center gap-1.5">
                  <Check className="w-4 h-4 text-emerald-600" />
                  已绑定 Step 1-5 工作台
                </span>
              )}

              <button
                onClick={handleOptimizeWithAi}
                disabled={isOptimizing}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
              >
                {isOptimizing ? (
                  <>
                    <Sparkles className="w-4 h-4 animate-spin" />
                    <span>优化中...</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4 fill-white text-white" />
                    <span>AI 智能提炼卖点</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">产品名称</label>
                <input
                  type="text"
                  value={currentProduct.name}
                  onChange={(e) => handleFieldChange('name', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">行业品类</label>
                <input
                  type="text"
                  value={currentProduct.category}
                  onChange={(e) => handleFieldChange('category', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">品牌定位</label>
                <input
                  type="text"
                  value={currentProduct.positioning}
                  onChange={(e) => handleFieldChange('positioning', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">售价表达</label>
                <input
                  type="text"
                  value={currentProduct.price}
                  onChange={(e) => handleFieldChange('price', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                <Award className="w-4 h-4 text-blue-600" />
                <span>权威背书 & 销量纪录</span>
              </label>
              <input
                type="text"
                value={currentProduct.salesRecord}
                onChange={(e) => handleFieldChange('salesRecord', e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
                <Layers className="w-4 h-4 text-blue-600" />
                <span>3:4:3 核心配方与科技矩阵</span>
              </label>

              <div className="grid grid-cols-1 gap-3">
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                  <span className="text-xs font-semibold text-slate-700 block">模块 1: 主功效吸附成分</span>
                  <input
                    type="text"
                    value={currentProduct.model343.clays}
                    onChange={(e) => handleFieldChange('model343.clays', e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 shadow-2xs"
                  />
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                  <span className="text-xs font-semibold text-slate-700 block">模块 2: 植萃与控油复配</span>
                  <input
                    type="text"
                    value={currentProduct.model343.extracts}
                    onChange={(e) => handleFieldChange('model343.extracts', e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 shadow-2xs"
                  />
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                  <span className="text-xs font-semibold text-slate-700 block">模块 3: 表活与促透修护</span>
                  <input
                    type="text"
                    value={currentProduct.model343.surfactants}
                    onChange={(e) => handleFieldChange('model343.surfactants', e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 shadow-2xs"
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
                <ShieldCheck className="w-4 h-4 text-blue-600" />
                <span>SGS 权威实验实测数据</span>
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
                  <span className="text-[11px] font-semibold text-slate-700 block mb-1">8小时即刻控油</span>
                  <input
                    type="text"
                    value={currentProduct.sgsData.oil8h}
                    onChange={(e) => handleFieldChange('sgsData.oil8h', e.target.value)}
                    className="w-full px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs focus:outline-none focus:border-blue-500 shadow-2xs"
                  />
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
                  <span className="text-[11px] font-semibold text-slate-700 block mb-1">14天长期改善</span>
                  <input
                    type="text"
                    value={currentProduct.sgsData.oil14d}
                    onChange={(e) => handleFieldChange('sgsData.oil14d', e.target.value)}
                    className="w-full px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs focus:outline-none focus:border-blue-500 shadow-2xs"
                  />
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
                  <span className="text-[11px] font-semibold text-slate-700 block mb-1">黑头面积减少</span>
                  <input
                    type="text"
                    value={currentProduct.sgsData.blackhead14d}
                    onChange={(e) => handleFieldChange('sgsData.blackhead14d', e.target.value)}
                    className="w-full px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-900 font-mono text-xs focus:outline-none focus:border-blue-500 shadow-2xs"
                  />
                </div>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-rose-50/60 border border-rose-200/80">
              <label className="text-xs font-semibold text-rose-800 flex items-center gap-1.5 mb-1.5">
                <AlertTriangle className="w-4 h-4 text-rose-600" />
                <span>合规审查禁忌词</span>
              </label>
              <input
                type="text"
                value={currentProduct.prohibitedWords?.join(', ') || ''}
                onChange={(e) => handleFieldChange('prohibitedWords', e.target.value)}
                placeholder="用逗号分隔违规词..."
                className="w-full px-3 py-2 rounded-lg bg-white border border-rose-200 text-slate-900 text-xs focus:outline-none focus:border-rose-400 focus:ring-1 focus:ring-rose-400 shadow-2xs"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

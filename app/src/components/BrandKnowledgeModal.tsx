import React, { useState } from 'react';
import { ProductItem, SellingPointsAiModel } from '../types';
import { PRODUCT_TEMPLATES, INITIAL_PRODUCTS } from '../data/presets';
import {
  X,
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
} from 'lucide-react';

interface BrandKnowledgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  products: ProductItem[];
  activeProductId: string;
  onSelectActiveProduct: (productId: string) => void;
  onUpdateProducts: (products: ProductItem[]) => void;
}

export const BrandKnowledgeModal: React.FC<BrandKnowledgeModalProps> = ({
  isOpen,
  onClose,
  products,
  activeProductId,
  onSelectActiveProduct,
  onUpdateProducts,
}) => {
  const [selectedProductId, setSelectedProductId] = useState<string>(activeProductId);
  const [selectedAiModel, setSelectedAiModel] = useState<SellingPointsAiModel>('deepseek-v3');
  const [isOptimizing, setIsOptimizing] = useState<boolean>(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState<boolean>(false);

  if (!isOpen) return null;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-slate-900/40 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white border border-slate-200/90 rounded-2xl w-full max-w-6xl max-h-[90vh] flex flex-col shadow-xl overflow-hidden my-auto text-slate-900">
        {/* Header Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/80 gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600 border border-blue-200/60">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-slate-900">
                  卖点库与品牌知识中心
                </h3>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] bg-blue-50 text-blue-700 border border-blue-200/60 font-semibold">
                  企业级品牌知识 Base
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                支持陈列多款产品、AI 智能提炼卖点，全自动绑定到 Step 1-5 工作台生成
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* AI Model Switcher */}
            <div className="flex items-center gap-1.5 bg-white border border-slate-200/90 px-3 py-1.5 rounded-lg shadow-2xs">
              <Cpu className="w-4 h-4 text-blue-600" />
              <span className="text-xs text-slate-600 font-medium">优化模型:</span>
              <select
                value={selectedAiModel}
                onChange={(e) => setSelectedAiModel(e.target.value as SellingPointsAiModel)}
                className="bg-transparent text-xs font-semibold text-slate-900 focus:outline-none cursor-pointer"
              >
                <option value="deepseek-v3">🤖 DeepSeek V3 (建议首选)</option>
                <option value="deepseek-r1">🧠 DeepSeek R1 (深度思考推理)</option>
                <option value="gpt-4o">⚡ GPT-4o (OpenAI 旗舰)</option>
                <option value="gemini-3.6-flash">✨ Gemini 3.6 Flash</option>
                <option value="claude-3.5-sonnet">🖋️ Claude 3.5 Sonnet</option>
              </select>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-12 min-h-[500px]">
          {/* Left Column: Products List & Templates */}
          <div className="lg:col-span-4 border-r border-slate-200/80 bg-slate-50/60 p-4 flex flex-col justify-between overflow-y-auto">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Package className="w-4 h-4 text-slate-400" />
                  <span>陈列产品 ({products.length})</span>
                </span>

                <div className="relative">
                  <button
                    onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                    className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-all flex items-center gap-1 shadow-2xs cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>新增产品</span>
                  </button>

                  {/* Template Dropdown */}
                  {showTemplateMenu && (
                    <div className="absolute right-0 top-8 z-30 w-56 bg-white border border-slate-200 rounded-xl shadow-lg p-1 space-y-0.5">
                      <div className="px-2.5 py-1 text-[10px] font-semibold text-slate-400 uppercase">
                        从预设模板创建
                      </div>
                      {PRODUCT_TEMPLATES.map((tmpl, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleAddNewProductFromTemplate(tmpl)}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-slate-700 hover:bg-slate-100 transition-colors flex items-center justify-between cursor-pointer"
                        >
                          <span className="font-medium truncate">{tmpl.name}</span>
                          <span className="text-[10px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded font-medium">
                            {tmpl.category}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Product Cards */}
              <div className="space-y-2">
                {products.map((prod) => {
                  const isSelected = prod.id === selectedProductId;
                  const isCurrentActive = prod.id === activeProductId;

                  return (
                    <div
                      key={prod.id}
                      onClick={() => setSelectedProductId(prod.id)}
                      className={`p-3 rounded-xl border transition-all cursor-pointer relative group ${
                        isSelected
                          ? 'bg-blue-50/80 border-blue-200/90 text-blue-900 shadow-2xs'
                          : 'bg-white border-slate-200/80 text-slate-700 hover:bg-slate-100/60'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="font-semibold text-sm text-slate-900 truncate">
                              {prod.name}
                            </span>
                            {isCurrentActive && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-0.5 shrink-0">
                                <Check className="w-3 h-3" />
                                生效中
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 truncate">
                            {prod.positioning}
                          </p>
                          <div className="flex items-center gap-2 mt-2 text-[11px]">
                            <span className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-600 font-medium">
                              {prod.category}
                            </span>
                            <span className="text-blue-700 font-semibold bg-blue-50 px-1.5 py-0.5 rounded">{prod.price}</span>
                          </div>
                        </div>

                        <button
                          onClick={(e) => handleDeleteProduct(prod.id, e)}
                          className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                          title="删除该产品"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="pt-4 border-t border-slate-200/80 mt-4">
              <button
                onClick={handleResetDefaults}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200/80 bg-white hover:bg-slate-100 text-slate-700 text-xs font-medium shadow-2xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>恢复默认卖点预设</span>
              </button>
            </div>
          </div>

          {/* Right Column: Editable Product Details */}
          <div className="lg:col-span-8 p-6 overflow-y-auto space-y-6 bg-white">
            {/* Top Product Banner & Active Toggle */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200/60">
                    {currentProduct.category}
                  </span>
                  <h4 className="text-base font-bold text-slate-900">
                    {currentProduct.name}
                  </h4>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  上次更新时间: {currentProduct.updatedAt || '实时更新'}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {!isActive ? (
                  <button
                    onClick={() => onSelectActiveProduct(currentProduct.id)}
                    className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>设为当前工作台生效产品</span>
                  </button>
                ) : (
                  <span className="px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold flex items-center gap-1.5">
                    <Check className="w-4 h-4 text-emerald-600" />
                    已绑定当前工作台
                  </span>
                )}

                {/* AI Optimize Button */}
                <button
                  onClick={handleOptimizeWithAi}
                  disabled={isOptimizing}
                  className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-2xs transition-all flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  title={`使用 ${selectedAiModel} 提炼规范 selling points`}
                >
                  {isOptimizing ? (
                    <>
                      <Sparkles className="w-4 h-4 animate-spin text-white" />
                      <span>{selectedAiModel.toUpperCase()} 优化中...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4 fill-white text-white" />
                      <span>AI 润色与提炼卖点</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Editable Fields Form */}
            <div className="space-y-5">
              {/* Basic Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1.5">
                    商品名称 (Product Name)
                  </label>
                  <input
                    type="text"
                    value={currentProduct.name}
                    onChange={(e) => handleFieldChange('name', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1.5">
                    品类/分类 (Category)
                  </label>
                  <input
                    type="text"
                    value={currentProduct.category}
                    onChange={(e) => handleFieldChange('category', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1.5">
                    品牌定位与核心标语 (Positioning)
                  </label>
                  <input
                    type="text"
                    value={currentProduct.positioning}
                    onChange={(e) => handleFieldChange('positioning', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1.5">
                    售价表达 (Price)
                  </label>
                  <input
                    type="text"
                    value={currentProduct.price}
                    onChange={(e) => handleFieldChange('price', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                  />
                </div>
              </div>

              {/* Sales Record & Authority */}
              <div>
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-1.5">
                  <Award className="w-4 h-4 text-blue-600" />
                  <span>权威背书 & 销量纪录 (Sales & Authority)</span>
                </label>
                <input
                  type="text"
                  value={currentProduct.salesRecord}
                  onChange={(e) => handleFieldChange('salesRecord', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shadow-2xs"
                />
              </div>

              {/* 3:4:3 / Core Formula Model */}
              <div>
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
                  <Layers className="w-4 h-4 text-blue-600" />
                  <span>核心技术与配方模型 (3:4:3 / Ingredient Matrix)</span>
                </label>

                <div className="grid grid-cols-1 gap-3">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                    <span className="text-[11px] font-semibold text-slate-700">
                      模块 1: 核心吸附/主体功效成分
                    </span>
                    <input
                      type="text"
                      value={currentProduct.model343.clays}
                      onChange={(e) => handleFieldChange('model343.clays', e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                    <span className="text-[11px] font-semibold text-slate-700">
                      模块 2: 控油舒缓/植萃复配群
                    </span>
                    <input
                      type="text"
                      value={currentProduct.model343.extracts}
                      onChange={(e) => handleFieldChange('model343.extracts', e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                    <span className="text-[11px] font-semibold text-slate-700">
                      模块 3: 清洁表活/促透修护体系
                    </span>
                    <input
                      type="text"
                      value={currentProduct.model343.surfactants}
                      onChange={(e) => handleFieldChange('model343.surfactants', e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* SGS Lab Proof Data */}
              <div>
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
                  <ShieldCheck className="w-4 h-4 text-blue-600" />
                  <span>SGS 权威实验室功效数据 (Lab Proof Data)</span>
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80">
                    <span className="text-[11px] font-semibold text-slate-600 block mb-1">
                      短期/即刻功效 (如控油8h)
                    </span>
                    <input
                      type="text"
                      value={currentProduct.sgsData.oil8h}
                      onChange={(e) => handleFieldChange('sgsData.oil8h', e.target.value)}
                      className="w-full px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs font-bold focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80">
                    <span className="text-[11px] font-semibold text-slate-600 block mb-1">
                      中周期实测 (如14天出油)
                    </span>
                    <input
                      type="text"
                      value={currentProduct.sgsData.oil14d}
                      onChange={(e) => handleFieldChange('sgsData.oil14d', e.target.value)}
                      className="w-full px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs font-bold focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80">
                    <span className="text-[11px] font-semibold text-slate-600 block mb-1">
                      专项改善指标 (如黑头减少)
                    </span>
                    <input
                      type="text"
                      value={currentProduct.sgsData.blackhead14d}
                      onChange={(e) => handleFieldChange('sgsData.blackhead14d', e.target.value)}
                      className="w-full px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs font-bold focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Custom Selling Points & Target Audience */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1.5">
                    目标受众人群 (Target Audience)
                  </label>
                  <textarea
                    rows={3}
                    value={currentProduct.targetAudience || ''}
                    onChange={(e) => handleFieldChange('targetAudience', e.target.value)}
                    placeholder="如：18-35岁大油田、油敏肌、混油皮..."
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none shadow-2xs"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1.5">
                    特色卖点草稿/自由描述 (Selling Points Draft)
                  </label>
                  <textarea
                    rows={3}
                    value={currentProduct.customSellingPoints || ''}
                    onChange={(e) => handleFieldChange('customSellingPoints', e.target.value)}
                    placeholder="可输入自由填写的卖点草稿，点击右上角【AI 润色与提炼卖点】自动生成规范配方..."
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none shadow-2xs"
                  />
                </div>
              </div>

              {/* Prohibited Words */}
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200/80">
                <label className="text-xs font-semibold text-rose-800 flex items-center gap-1.5 mb-1.5">
                  <AlertTriangle className="w-4 h-4 text-rose-600" />
                  <span>合规禁忌词 (Prohibited Words)</span>
                </label>
                <input
                  type="text"
                  value={currentProduct.prohibitedWords?.join(', ') || ''}
                  onChange={(e) => handleFieldChange('prohibitedWords', e.target.value)}
                  placeholder="用逗号分隔违规词，如：震惊！, 第一名！, 根治过敏"
                  className="w-full px-3 py-2 rounded-lg bg-white border border-rose-200 text-slate-900 text-xs focus:outline-none focus:border-rose-400"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            当前工作台生效产品: <span className="text-blue-700 font-semibold bg-blue-50 px-2 py-0.5 rounded border border-blue-200/60">{products.find(p => p.id === activeProductId)?.name}</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-2xs cursor-pointer"
            >
              确定并返回工作台
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

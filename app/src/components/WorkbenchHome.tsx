/**
 * S2 结果导向起点：主 CTA 只保留「上传爆款视频」和「上传我的产品」，
 * 三档自主模式 + 独立付费授权（默认关闭，与自主模式解绑），次级入口为 Recipe/预设。
 */
import React, { useRef, useState } from 'react';
import { Clapperboard, Package, Sparkles, Upload } from 'lucide-react';
import { apiService } from '../services/api';
import type { ProductItem } from '../types';
import { AUTONOMY_MODE_LABELS, type AutonomyMode } from '../../shared/workbench-contract';
import { useWorkbench } from '../hooks/useWorkbench';

interface WorkbenchHomeProps {
  products: ProductItem[];
  activeProductId?: string;
  onSelectProduct: (id: string) => void;
  /** 爆款视频上传成功（mediaUrl 已写入 step1 inputs） */
  onViralUploaded: (material: { url: string; name: string }) => void;
  onOpenPresets: () => void;
  onOpenMaterials: () => void;
  onNotify: (message: string, type?: 'success' | 'error') => void;
}

export const WorkbenchHome: React.FC<WorkbenchHomeProps> = ({
  products,
  activeProductId,
  onSelectProduct,
  onViralUploaded,
  onOpenPresets,
  onOpenMaterials,
  onNotify,
}) => {
  const workbench = useWorkbench();
  const viralInputRef = useRef<HTMLInputElement>(null);
  const productInputRef = useRef<HTMLInputElement>(null);
  const [uploadingViral, setUploadingViral] = useState(false);
  const [uploadingProduct, setUploadingProduct] = useState(false);

  const handleViralFile = async (file: File) => {
    setUploadingViral(true);
    try {
      const material = await apiService.materials.uploadMaterial(file, () => {});
      if (material?.url) {
        onViralUploaded({ url: material.url, name: material.name || file.name });
        onNotify(`✅ 爆款视频已上传：${file.name}`);
      } else {
        onNotify('上传失败：未返回素材地址', 'error');
      }
    } catch (error: any) {
      onNotify(`上传失败：${error?.message || '未知错误'}`, 'error');
    } finally {
      setUploadingViral(false);
    }
  };

  const handleProductFile = async (file: File) => {
    setUploadingProduct(true);
    try {
      const productId = activeProductId || products[0]?.id;
      if (!productId) {
        onNotify('请先选择/创建产品（卖点库）', 'error');
        return;
      }
      const result = await apiService.products.addAsset(productId, { file, role: 'hero' });
      if (result?.success || result?.data) {
        onNotify(`✅ 产品图已上传到「${products.find((p) => p.id === productId)?.name || productId}」`);
      } else {
        onNotify('上传失败：未返回素材', 'error');
      }
    } catch (error: any) {
      onNotify(`上传失败：${error?.message || '未知错误'}`, 'error');
    } finally {
      setUploadingProduct(false);
    }
  };

  const modes: Array<{ id: AutonomyMode; description: string }> = [
    { id: 'managed', description: '自动完成拆解、分镜与提交前的确认，最快出稿' },
    { id: 'confirm_key_points', description: '仅在拆解结果、分镜计划、批量付费提交三处确认' },
    { id: 'step_by_step', description: '每一步由你显式触发，完全掌控' },
  ];

  return (
    <section
      className="rounded-3xl border border-slate-200 bg-gradient-to-br from-indigo-50/80 via-white to-white p-6 sm:p-8 shadow-sm"
      data-testid="workbench-home"
    >
      <div className="max-w-3xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold mb-4">
          <Sparkles className="w-3.5 h-3.5" />
          爆款复刻工作台
        </div>
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 leading-tight">
          上传爆款视频，生成你的专属复刻成片
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          看懂爆款结构 → 替换为你的产品 → 逐镜生成，付费前看到成本、素材与等待预估
        </p>
      </div>

      {/* 双主 CTA */}
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
        <label
          className="group relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-indigo-300 bg-indigo-50/60 hover:bg-indigo-50 hover:border-indigo-400 px-6 py-10 transition-all"
          data-testid="upload-viral-cta"
          aria-label="上传爆款视频"
        >
          <input
            ref={viralInputRef}
            type="file"
            accept="video/*,image/*"
            className="sr-only"
            aria-label="选择爆款视频文件"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleViralFile(file);
              e.target.value = '';
            }}
          />
          <span className="w-14 h-14 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-200 group-hover:scale-105 transition-transform">
            <Clapperboard className="w-7 h-7" />
          </span>
          <span className="text-base font-bold text-slate-800">上传爆款视频</span>
          <span className="text-xs text-slate-500">
            {uploadingViral ? '上传中…' : '拖拽或点击选择抖音/小红书爆款'}
          </span>
          <span className="inline-flex items-center gap-1 mt-1 text-xs font-semibold text-indigo-600">
            <Upload className="w-3.5 h-3.5" /> 选择文件
          </span>
        </label>

        <label
          className="group relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/60 hover:bg-emerald-50 hover:border-emerald-400 px-6 py-10 transition-all"
          data-testid="upload-product-cta"
          aria-label="上传我的产品"
        >
          <input
            ref={productInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="选择产品图片文件"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleProductFile(file);
              e.target.value = '';
            }}
          />
          <span className="w-14 h-14 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shadow-lg shadow-emerald-200 group-hover:scale-105 transition-transform">
            <Package className="w-7 h-7" />
          </span>
          <span className="text-base font-bold text-slate-800">上传我的产品</span>
          <span className="text-xs text-slate-500">
            {uploadingProduct ? '上传中…' : '产品图将作为替换主体的素材'}
          </span>
          <span className="inline-flex items-center gap-1 mt-1 text-xs font-semibold text-emerald-600">
            <Upload className="w-3.5 h-3.5" /> 选择文件
          </span>
        </label>
      </div>

      {/* 次级入口（不抢占主路径） */}
      <div className="mt-4 text-center text-xs text-slate-500">
        或
        <button onClick={onOpenPresets} className="mx-1 text-indigo-600 font-semibold hover:underline" data-testid="preset-secondary-entry">
          从 8 大黄金模板开始
        </button>
        · <button onClick={onOpenMaterials} className="text-indigo-600 font-semibold hover:underline">从素材库选择</button>
      </div>

      {/* 产品选择 + 自主模式 + 付费授权 */}
      <div className="mt-8 max-w-2xl mx-auto space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <label htmlFor="workbench-product-select" className="text-xs font-bold text-slate-700 block mb-2">
            当前产品（替换主体）
          </label>
          <select
            id="workbench-product-select"
            value={activeProductId || ''}
            onChange={(e) => e.target.value && onSelectProduct(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-white text-slate-800 border border-slate-300 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-300"
          >
            {products.map((p) => (
              <option key={p.id} value={p.id} className="bg-white text-slate-900">
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="rounded-2xl border border-slate-200 bg-white p-4">
          <legend className="text-xs font-bold text-slate-700 px-1">自主模式</legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="自主模式">
            {modes.map((mode) => {
              const selected = workbench.autonomyMode === mode.id;
              return (
                <label
                  key={mode.id}
                  className={`cursor-pointer rounded-xl border p-3 transition-all ${
                    selected ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="autonomy-mode"
                    value={mode.id}
                    checked={selected}
                    onChange={() => void workbench.setAutonomyMode(mode.id)}
                    className="sr-only"
                  />
                  <span className="block text-sm font-bold text-slate-800">{AUTONOMY_MODE_LABELS[mode.id]}</span>
                  <span className="block text-[11px] text-slate-600 mt-1 leading-snug">{mode.description}</span>
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            自主模式只决定「何时由你确认」，不影响下方的付费授权。
          </p>
        </fieldset>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-slate-800">允许 AI 自动提交付费生成</div>
            <p className="text-[11px] text-slate-600 mt-1">
              独立授权，默认关闭。开启后批量生成无需逐镜确认；关闭时每次付费提交都会要求你显式确认。
            </p>
          </div>
          <button
            role="switch"
            aria-checked={workbench.paidAuthEnabled}
            aria-label="允许 AI 自动提交付费生成"
            onClick={() => void workbench.togglePaidAuth(!workbench.paidAuthEnabled)}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
              workbench.paidAuthEnabled ? 'bg-indigo-600' : 'bg-slate-300'
            }`}
            data-testid="paid-auth-toggle"
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                workbench.paidAuthEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>
    </section>
  );
};

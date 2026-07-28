import React, { useState } from 'react';
import {
  X,
  ListTodo,
  CheckCircle2,
  Trash2,
  Sparkles,
  Eye,
  ArrowRight,
  Download,
} from 'lucide-react';
import { TaskItem } from '../types';
import { downloadJsonFile } from '../utils/format';

interface TaskManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: TaskItem[];
  onSelectTask: (task: TaskItem) => void;
  onDeleteTask: (id: string) => void;
  onReRunTask: (task: TaskItem) => void;
}

export const TaskManagerModal: React.FC<TaskManagerModalProps> = ({
  isOpen,
  onClose,
  tasks,
  onSelectTask,
  onDeleteTask,
}) => {
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'generating'>('all');

  if (!isOpen) return null;

  const filteredTasks = tasks.filter((t) => {
    if (statusFilter === 'completed') return t.status === 'completed';
    if (statusFilter === 'generating') return t.status === 'generating';
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white text-slate-900 border border-slate-200/90 rounded-2xl shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden transition-all">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/80">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600 border border-blue-200/60">
              <ListTodo className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                AI 生成任务中心 (AIGC Task Manager)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                查看、追溯与管理历史反推任务，支持一键重载工作流程、修改 Prompt 与打包导出
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filter Bar */}
        <div className="px-6 py-3 border-b border-slate-100 flex items-center justify-between bg-white">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                statusFilter === 'all'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              全部任务 ({tasks.length})
            </button>
            <button
              onClick={() => setStatusFilter('completed')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                statusFilter === 'completed'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              已完成 ({tasks.filter((t) => t.status === 'completed').length})
            </button>
          </div>

          <span className="text-xs text-slate-400 hidden sm:inline">
            点击任务可一键同步至主工作台直接进行第1-5步编辑与渲染
          </span>
        </div>

        {/* Main Body */}
        <div className="p-6 overflow-y-auto flex-1 bg-slate-50/50">
          {filteredTasks.length === 0 ? (
            <div className="py-16 text-center text-slate-400">
              <ListTodo className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p className="text-xs font-semibold">暂无历史反推任务记录</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTasks.map((task) => (
                <div
                  key={task.id}
                  className="p-4 rounded-xl border border-slate-200/80 bg-white shadow-2xs hover:border-slate-300 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3">
                    {task.thumbnailUrl ? (
                      <img
                        src={task.thumbnailUrl}
                        alt=""
                        className="w-16 h-16 rounded-lg object-cover border border-slate-200 shrink-0"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-lg bg-blue-50 border border-blue-200/60 flex items-center justify-center text-blue-600 shrink-0">
                        <Sparkles className="w-6 h-6" />
                      </div>
                    )}

                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-sm text-slate-900">
                          {task.title}
                        </h4>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          已完成 5 步流水线
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                        提示词: {task.pipelineData.step1.output?.static_image_prompt || '暂无静态图提示词'}
                      </p>
                      <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                        创建时间: {task.createdAt} · 任务ID: {task.id}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setSelectedTaskDetail(task)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 shadow-2xs transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>查看详情</span>
                    </button>

                    <button
                      onClick={() => {
                        onSelectTask(task);
                        onClose();
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs transition-all flex items-center gap-1 cursor-pointer"
                    >
                      <span>载入工作台</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => onDeleteTask(task.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                      title="删除任务"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between text-xs text-slate-500">
          <span>任务状态已实时持久化到后端服务</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-white border border-slate-200/80 text-slate-700 font-medium shadow-2xs hover:bg-slate-100 cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>

      {/* Task Detail Modal */}
      {selectedTaskDetail && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="bg-white text-slate-900 rounded-2xl border border-slate-200/90 shadow-xl max-w-3xl w-full p-6 overflow-hidden space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-bold text-base text-slate-900">{selectedTaskDetail.title} — 任务流产物全览</h3>
              <button
                onClick={() => setSelectedTaskDetail(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 space-y-4 text-xs pr-1">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 space-y-1">
                <span className="font-semibold text-slate-700 block">Step 1 静态图提示词 (Prompt):</span>
                <p className="text-slate-900 font-mono bg-white p-2.5 rounded-lg border border-slate-200">
                  {selectedTaskDetail.pipelineData.step1.output?.static_image_prompt}
                </p>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 space-y-1">
                <span className="font-semibold text-slate-700 block">Step 2 视频运镜 Prompt:</span>
                <p className="text-slate-900 font-mono bg-white p-2.5 rounded-lg border border-slate-200">
                  {selectedTaskDetail.pipelineData.step2.output?.video_prompt}
                </p>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 space-y-1">
                <span className="font-semibold text-slate-700 block">Step 3 爆款文案文案:</span>
                <div className="text-slate-900 bg-white p-2.5 rounded-lg border border-slate-200">
                  <strong className="font-semibold">{selectedTaskDetail.pipelineData.step3.output?.title}</strong>
                  <p className="mt-1">{selectedTaskDetail.pipelineData.step3.output?.hook}</p>
                  <p className="mt-1 text-slate-600">{selectedTaskDetail.pipelineData.step3.output?.body}</p>
                </div>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 space-y-1">
                <span className="font-semibold text-slate-700 block">Step 4 推荐 BGM 曲目:</span>
                <p className="text-slate-900 bg-white p-2.5 rounded-lg border border-slate-200">
                  {selectedTaskDetail.pipelineData.step4.output?.bgm_recommendation.track_name} — BPM {selectedTaskDetail.pipelineData.step4.output?.bgm_recommendation.bpm}
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
              <button
                onClick={() =>
                  downloadJsonFile(selectedTaskDetail.pipelineData, `${selectedTaskDetail.id}_bundle.json`)
                }
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-100 flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>导出全套 JSON 数据</span>
              </button>

              <button
                onClick={() => {
                  onSelectTask(selectedTaskDetail);
                  setSelectedTaskDetail(null);
                  onClose();
                }}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-2xs cursor-pointer"
              >
                在主工作台中载入并编辑
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

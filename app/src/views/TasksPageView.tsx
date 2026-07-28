import React, { useState } from 'react';
import {
  ListTodo,
  CheckCircle2,
  Eye,
  Trash2,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Download,
  X,
} from 'lucide-react';
import { TaskItem } from '../types';
import { downloadJsonFile } from '../utils/format';

interface TasksPageViewProps {
  tasks: TaskItem[];
  onSelectTask: (task: TaskItem) => void;
  onDeleteTask: (id: string) => void;
  onBackToPipeline: () => void;
}

export const TasksPageView: React.FC<TasksPageViewProps> = ({
  tasks,
  onSelectTask,
  onDeleteTask,
  onBackToPipeline,
}) => {
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed'>('all');

  const filteredTasks = tasks.filter((t) => {
    if (statusFilter === 'completed') return t.status === 'completed';
    return true;
  });

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header Banner */}
      <div className="p-6 rounded-3xl bg-white border border-slate-200/80 shadow-surface-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBackToPipeline}
            className="p-2.5 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors flex items-center gap-1.5 text-xs font-bold shrink-0"
            title="返回主流水线"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>返回流水线</span>
          </button>

          <div className="p-3 rounded-2xl bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 shrink-0">
            <ListTodo className="w-6 h-6" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-extrabold text-slate-900">后台渲染与反推任务中心</h1>
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold">
                TASK CENTER
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              追踪所有历史生成的短视频反推工程与镜头配置，支持随时重载并再次渲染。
            </p>
          </div>
        </div>

        <div className="text-right text-xs font-semibold text-slate-500 hidden sm:block">
          累计完成 <span className="text-emerald-600 font-bold text-sm">{tasks.length}</span> 个反推工程
        </div>
      </div>

      {/* Filter Bar */}
      <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-surface-sm flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              statusFilter === 'all'
                ? 'bg-slate-900 text-white shadow-md'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            全部任务 ({tasks.length})
          </button>
          <button
            onClick={() => setStatusFilter('completed')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              statusFilter === 'completed'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            已完成 ({tasks.filter((t) => t.status === 'completed').length})
          </button>
        </div>

        <span className="text-xs font-medium text-slate-500">
          点击【载入工作台】可直接在主界面对具体步骤进行细化调整
        </span>
      </div>

      {/* Tasks List */}
      <div className="p-6 rounded-3xl bg-white border border-slate-200/80 shadow-surface-sm">
        {filteredTasks.length === 0 ? (
          <div className="py-20 text-center text-slate-400 space-y-2">
            <ListTodo className="w-12 h-12 mx-auto opacity-40 text-emerald-600" />
            <p className="text-sm font-bold text-slate-600">暂无反推任务记录</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredTasks.map((task) => (
              <div
                key={task.id}
                className="p-5 rounded-2xl border border-slate-200/90 bg-white hover:border-emerald-500/80 shadow-surface-sm hover:shadow-surface-md transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="flex items-center gap-4">
                  {task.thumbnailUrl ? (
                    <img
                      src={task.thumbnailUrl}
                      alt=""
                      className="w-16 h-16 rounded-xl object-cover border border-slate-200 shrink-0"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 shrink-0">
                      <Sparkles className="w-6 h-6" />
                    </div>
                  )}

                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-extrabold text-sm text-slate-900">{task.title}</h3>
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        5步流水线完毕
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                      首帧提示词: {task.pipelineData.step1.output?.static_image_prompt || '暂无静态图提示词'}
                    </p>
                    <p className="text-[11px] text-slate-400 font-mono mt-1">
                      创建时间: {task.createdAt} · ID: {task.id}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    onClick={() => setSelectedTaskDetail(task)}
                    className="px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors flex items-center gap-1.5"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>查看结构全览</span>
                  </button>

                  <button
                    onClick={() => {
                      onSelectTask(task);
                      onBackToPipeline();
                    }}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white transition-all shadow-md flex items-center gap-1.5"
                  >
                    <span>载入工作台</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => onDeleteTask(task.id)}
                    className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
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

      {/* Task Detail Modal */}
      {selectedTaskDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-white rounded-3xl max-w-3xl w-full p-6 overflow-hidden space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="font-extrabold text-base text-slate-900">
                {selectedTaskDetail.title} — 产物解析
              </h3>
              <button
                onClick={() => setSelectedTaskDetail(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 space-y-4 text-xs pr-1">
              <div className="p-3 bg-slate-50 rounded-2xl space-y-1 border border-slate-200">
                <span className="font-bold text-emerald-700">Step 1 静态图 Prompt:</span>
                <p className="text-slate-800 font-mono bg-white p-2.5 rounded-xl border border-slate-200">
                  {selectedTaskDetail.pipelineData.step1.output?.static_image_prompt}
                </p>
              </div>

              <div className="p-3 bg-slate-50 rounded-2xl space-y-1 border border-slate-200">
                <span className="font-bold text-teal-700">Step 2 视频运镜 Prompt:</span>
                <p className="text-slate-800 font-mono bg-white p-2.5 rounded-xl border border-slate-200">
                  {selectedTaskDetail.pipelineData.step2.output?.video_prompt}
                </p>
              </div>

              <div className="p-3 bg-slate-50 rounded-2xl space-y-1 border border-slate-200">
                <span className="font-bold text-cyan-700">Step 3 爆款文案脚本:</span>
                <p className="text-slate-800 bg-white p-2.5 rounded-xl border border-slate-200">
                  <strong>{selectedTaskDetail.pipelineData.step3.output?.title}</strong>
                  <br />
                  {selectedTaskDetail.pipelineData.step3.output?.hook}
                  <br />
                  {selectedTaskDetail.pipelineData.step3.output?.body}
                </p>
              </div>

              <div className="p-3 bg-slate-50 rounded-2xl space-y-1 border border-slate-200">
                <span className="font-bold text-indigo-700">Step 4 BGM 曲目卡点:</span>
                <p className="text-slate-800 bg-white p-2.5 rounded-xl border border-slate-200">
                  {selectedTaskDetail.pipelineData.step4.output?.bgm_recommendation.track_name} — BPM{' '}
                  {selectedTaskDetail.pipelineData.step4.output?.bgm_recommendation.bpm}
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-200 flex items-center justify-between">
              <button
                onClick={() =>
                  downloadJsonFile(
                    selectedTaskDetail.pipelineData,
                    `${selectedTaskDetail.id}_bundle.json`
                  )
                }
                className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center gap-1.5"
              >
                <Download className="w-4 h-4" />
                <span>导出数据 JSON</span>
              </button>

              <button
                onClick={() => {
                  onSelectTask(selectedTaskDetail);
                  setSelectedTaskDetail(null);
                  onBackToPipeline();
                }}
                className="px-5 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md"
              >
                在工作台中载入并编辑
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

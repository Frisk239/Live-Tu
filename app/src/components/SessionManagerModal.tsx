import React, { useState } from 'react';
import {
  X,
  ListTodo,
  CheckCircle2,
  Trash2,
  ArrowRight,
  Sparkles,
  Eye,
  Download,
  Search,
  Plus,
  AlertTriangle,
  Clock,
  FileText,
} from 'lucide-react';
import { WorkspaceSession } from '../types';
import { downloadJsonFile } from '../utils/format';

interface SessionManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: WorkspaceSession[];
  currentSessionId?: string;
  onSelectSession: (session: WorkspaceSession) => void;
  onDeleteSession: (id: string) => void;
  onCreateNewWorkspace: () => void;
}

export const SessionManagerModal: React.FC<SessionManagerModalProps> = ({
  isOpen,
  onClose,
  sessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onCreateNewWorkspace,
}) => {
  const [selectedSessionDetail, setSelectedSessionDetail] = useState<WorkspaceSession | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<WorkspaceSession | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'completed' | 'generating'>('all');

  if (!isOpen) return null;

  const filteredSessions = sessions.filter((s) => {
    const matchesSearch =
      s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;

    if (statusFilter === 'completed') return s.status === 'completed';
    if (statusFilter === 'draft') return s.status === 'draft';
    if (statusFilter === 'generating') return s.status === 'generating';
    return true;
  });

  const handleConfirmDelete = () => {
    if (sessionToDelete) {
      onDeleteSession(sessionToDelete.id);
      setSessionToDelete(null);
    }
  };

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
                工作台会话管理中心 (Workspace Sessions)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                管理历史工作区快照，支持新建工作区、草稿恢复、提示词复盘与 JSON 数据打包导出
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onClose();
                onCreateNewWorkspace();
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建工作区</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="px-6 py-3 border-b border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3 bg-white">
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                statusFilter === 'all'
                  ? 'bg-blue-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              全部 ({sessions.length})
            </button>
            <button
              onClick={() => setStatusFilter('draft')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                statusFilter === 'draft'
                  ? 'bg-amber-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              草稿 ({sessions.filter((s) => s.status === 'draft').length})
            </button>
            <button
              onClick={() => setStatusFilter('completed')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                statusFilter === 'completed'
                  ? 'bg-emerald-600 text-white shadow-2xs'
                  : 'bg-slate-100/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              已完成 ({sessions.filter((s) => s.status === 'completed').length})
            </button>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="搜索工作区标题或ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-hidden focus:border-blue-500 focus:bg-white transition-all"
            />
          </div>
        </div>

        {/* Main Body */}
        <div className="p-6 overflow-y-auto flex-1 bg-slate-50/50">
          {filteredSessions.length === 0 ? (
            <div className="py-16 text-center text-slate-400">
              <ListTodo className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p className="text-xs font-semibold">未找到匹配的工作区会话</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredSessions.map((session) => {
                const isCurrent = session.id === currentSessionId;
                return (
                  <div
                    key={session.id}
                    className={`p-4 rounded-xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                      isCurrent
                        ? 'border-blue-300 bg-blue-50/30 shadow-xs ring-1 ring-blue-500/20'
                        : 'border-slate-200/80 bg-white shadow-2xs hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {session.thumbnailUrl ? (
                        <img
                          src={session.thumbnailUrl}
                          alt=""
                          className="w-14 h-14 rounded-lg object-cover border border-slate-200 shrink-0"
                        />
                      ) : (
                        <div className="w-14 h-14 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500 shrink-0">
                          <FileText className="w-6 h-6" />
                        </div>
                      )}

                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-bold text-sm text-slate-900">
                            {session.title}
                          </h4>

                          {isCurrent && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700 border border-blue-200">
                              当前活动工作区
                            </span>
                          )}

                          {session.status === 'completed' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                              已完成 5 步
                            </span>
                          )}

                          {session.status === 'draft' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
                              <Clock className="w-3 h-3 text-amber-600" />
                              草稿 (Step {session.currentStep})
                            </span>
                          )}
                        </div>

                        <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                          静态图提示词: {session.pipelineData?.step1?.output?.static_image_prompt || '未进行拆解'}
                        </p>
                        <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                          最后更新: {session.updatedAt || session.createdAt} · ID: {session.id}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => setSelectedSessionDetail(session)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/80 shadow-2xs transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>查看细节</span>
                      </button>

                      <button
                        onClick={() => {
                          onSelectSession(session);
                          onClose();
                        }}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-2xs transition-all flex items-center gap-1 cursor-pointer ${
                          isCurrent
                            ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-200'
                            : 'bg-blue-600 hover:bg-blue-500 text-white'
                        }`}
                      >
                        <span>{isCurrent ? '继续当前工作' : '载入工作台'}</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => setSessionToDelete(session)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                        title="删除工作区"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between text-xs text-slate-500">
          <span>所有修改自动防丢备份在数据库 `tasks` 表</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-white border border-slate-200/80 text-slate-700 font-medium shadow-2xs hover:bg-slate-100 cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {sessionToDelete && (
        <div className="fixed inset-0 z-70 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-base text-slate-900">确定要删除该工作区吗？</h3>
                <p className="text-xs text-slate-500">此操作不可撤销</p>
              </div>
            </div>

            <p className="text-xs text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200 font-medium">
              工作区名称：<span className="text-slate-900 font-bold">「{sessionToDelete.title}」</span>
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setSessionToDelete(null)}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-2xs cursor-pointer"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session Detail Modal */}
      {selectedSessionDetail && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="bg-white text-slate-900 rounded-2xl border border-slate-200/90 shadow-xl max-w-3xl w-full p-6 overflow-hidden space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-bold text-base text-slate-900">{selectedSessionDetail.title} — 工作区产物细节</h3>
              <button
                onClick={() => setSelectedSessionDetail(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 space-y-4 text-xs pr-1">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 space-y-1">
                <span className="font-semibold text-slate-700 block">Step 1 静态图提示词:</span>
                <p className="text-slate-900 font-mono bg-white p-2.5 rounded-lg border border-slate-200">
                  {selectedSessionDetail.pipelineData?.step1?.output?.static_image_prompt || '暂无数据'}
                </p>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 space-y-1">
                <span className="font-semibold text-slate-700 block">Step 3 文案标题 & 口播:</span>
                <p className="text-slate-900 font-bold bg-white p-2.5 rounded-lg border border-slate-200">
                  {selectedSessionDetail.pipelineData?.step3?.output?.title || '暂无标题'}
                </p>
                <p className="text-slate-700 bg-white p-2.5 rounded-lg border border-slate-200">
                  {selectedSessionDetail.pipelineData?.step3?.output?.body || '暂无正文'}
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
              <button
                onClick={() =>
                  downloadJsonFile(selectedSessionDetail.pipelineData, `${selectedSessionDetail.id}_bundle.json`)
                }
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200/80 shadow-2xs hover:bg-slate-100 flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>导出全套 JSON 数据</span>
              </button>

              <button
                onClick={() => {
                  onSelectSession(selectedSessionDetail);
                  setSelectedSessionDetail(null);
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

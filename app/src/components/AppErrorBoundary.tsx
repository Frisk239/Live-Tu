import React from 'react';

type State = {
  error: Error | null;
};

export class AppErrorBoundary extends React.Component<React.PropsWithChildren<Record<string, never>>, State> {
  declare readonly props: React.PropsWithChildren<Record<string, never>>;
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ui-error-boundary]', error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <section
          role="alert"
          aria-labelledby="fatal-error-title"
          className="w-full max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-xl"
        >
          <p className="text-sm font-semibold text-red-600">工作台发生异常</p>
          <h1 id="fatal-error-title" className="mt-2 text-xl font-bold text-slate-900">
            当前页面无法继续显示
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            已保存在服务端的任务不会丢失。请重新载入页面；如果问题持续出现，请把发生时间提供给管理员查询日志。
          </p>
          <details className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <summary className="cursor-pointer font-medium">错误详情</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap">{this.state.error.message}</pre>
          </details>
          <button
            type="button"
            onClick={this.reload}
            className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            重新载入工作台
          </button>
        </section>
      </main>
    );
  }
}

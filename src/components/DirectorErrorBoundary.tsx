import React from 'react';

interface DirectorErrorBoundaryProps {
  children: React.ReactNode;
}

interface DirectorErrorBoundaryState {
  error: Error | null;
}

export class DirectorErrorBoundary extends React.Component<DirectorErrorBoundaryProps, DirectorErrorBoundaryState> {
  state: DirectorErrorBoundaryState = { error: null };
  private readonly childContent: React.ReactNode;

  constructor(props: DirectorErrorBoundaryProps) {
    super(props);
    this.childContent = props.children;
  }

  static getDerivedStateFromError(error: Error): DirectorErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Director Console] render error', error, info);
  }

  private reload = () => window.location.reload();

  private backToProjects = () => {
    window.history.replaceState({}, '', '/projects');
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.childContent;
    return (
      <div className="min-h-screen bg-zinc-950 px-6 py-16 text-zinc-100">
        <div className="mx-auto max-w-xl rounded-2xl border border-rose-500/30 bg-zinc-900 p-8 shadow-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-rose-300">Director Console Error</p>
          <h1 className="mt-3 text-2xl font-semibold text-white">工作台发生渲染错误</h1>
          <p className="mt-4 break-words rounded-xl bg-black/30 p-4 text-sm text-rose-200">
            {this.state.error.message || String(this.state.error)}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={this.reload} className="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400">Reload</button>
            <button type="button" onClick={this.backToProjects} className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500">Back To Projects</button>
          </div>
        </div>
      </div>
    );
  }
}

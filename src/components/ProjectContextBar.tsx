import React from 'react';
import { ChevronRight, FolderKanban, Sparkles } from 'lucide-react';

interface ProjectContextBarProps {
  projectName: string;
  episodeName: string;
  activeTab: string;
  onBack: () => void;
  onAiDirector: () => void;
}

export const ProjectContextBar: React.FC<ProjectContextBarProps> = ({ projectName, episodeName, activeTab, onBack, onAiDirector }) => (
  <div className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/95 px-5 py-3 backdrop-blur sm:px-8">
    <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"><FolderKanban size={16} /> 项目</button>
        <ChevronRight size={15} className="text-zinc-600" />
        <div className="min-w-0"><div className="truncate font-medium text-white">{projectName}</div><div className="truncate text-xs text-zinc-500">{episodeName || '未选择章节'} · {activeTab}</div></div>
      </div>
      <button type="button" onClick={onAiDirector} className="inline-flex items-center gap-2 rounded-xl border border-indigo-400/30 bg-indigo-500/10 px-3.5 py-2 text-sm font-medium text-indigo-200 transition hover:border-indigo-300/60 hover:bg-indigo-500/20"><Sparkles size={16} /> AI导演</button>
    </div>
  </div>
);

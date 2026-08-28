import React, { useState } from 'react';
import { ClipboardPaste, FileJson2, X } from 'lucide-react';
import {
  MANUAL_STORYBOARD_CHATGPT_INSTRUCTION,
  MANUAL_STORYBOARD_IMPORT_EXAMPLE,
  parseManualStoryboardImport,
} from '../../services/director/manualStoryboardImport';

const DRAFT_KEY = 'zaojing_director_v01_brief';
const STORYBOARD_KEY = 'zaojing_director_v02_storyboard';
const APPROVAL_KEY = 'zaojing_director_v021_storyboard_approval';

interface ManualStoryboardImportEntryProps {
  onImported: () => void;
}

export const ManualStoryboardImportEntry: React.FC<ManualStoryboardImportEntryProps> = ({ onImported }) => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const close = () => {
    setOpen(false);
    setError('');
  };

  const importStoryboard = () => {
    try {
      const existingRaw = window.localStorage.getItem(STORYBOARD_KEY);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw) as { shots?: unknown[] };
        if (
          Array.isArray(existing.shots) &&
          existing.shots.length > 0 &&
          !window.confirm('导入会覆盖当前 Shot List，包括已经完成的人工修改。确认继续吗？')
        ) {
          return;
        }
      }

      const parsed = parseManualStoryboardImport(input);
      const now = Date.now();
      window.localStorage.setItem(STORYBOARD_KEY, JSON.stringify({
        version: 'manual-storyboard-v0.2',
        shots: parsed.shots,
        savedAt: now,
        generatedAt: now,
        generationEngine: 'manual',
        generationModel: 'chatgpt-manual-import-v0.1',
      }));
      window.localStorage.removeItem(APPROVAL_KEY);

      if (parsed.projectTitle) {
        try {
          const draftRaw = window.localStorage.getItem(DRAFT_KEY);
          if (draftRaw) {
            const draft = JSON.parse(draftRaw) as Record<string, unknown>;
            window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
              ...draft,
              title: parsed.projectTitle,
              savedAt: now,
            }));
          }
        } catch {
          // Storyboard import must not fail because an older Step 1 draft is malformed.
        }
      }

      setInput('');
      setError('');
      setOpen(false);
      onImported();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '分镜导入失败。');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-2xl border border-cyan-400/30 bg-cyan-500 px-4 py-3 text-sm font-black text-slate-950 shadow-[0_12px_36px_rgba(6,182,212,0.28)] hover:bg-cyan-400"
      >
        <ClipboardPaste className="h-4 w-4" /> 手动录入分镜
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="manual-storyboard-import-title"
        >
          <div className="max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-[#303036] bg-[#111114] shadow-2xl">
            <div className="flex items-start justify-between border-b border-[#27272A] px-5 py-4 sm:px-6">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-400">
                  ENTRY B · MANUAL IMPORT
                </div>
                <h2 id="manual-storyboard-import-title" className="mt-1 text-xl font-black text-white">
                  手动录入分镜
                </h2>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  把 ChatGPT 中已经讨论完成的分镜整段粘贴进来，系统会自动拆成多个 Shot。
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭手动录入分镜"
                onClick={close}
                className="rounded-lg border border-[#34343A] p-2 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid max-h-[72vh] overflow-y-auto lg:grid-cols-[1.15fr_0.85fr]">
              <div className="space-y-3 p-5 sm:p-6">
                <label htmlFor="manual-storyboard-import-input" className="block text-sm font-black text-white">
                  粘贴完整分镜
                </label>
                <textarea
                  id="manual-storyboard-import-input"
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value);
                    setError('');
                  }}
                  rows={22}
                  placeholder="在这里粘贴 ChatGPT 输出的 JSON 分镜…"
                  className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 font-mono text-xs leading-5 text-slate-200 outline-none focus:border-cyan-400/70"
                />
                {error && (
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                    {error}
                  </div>
                )}
              </div>

              <aside className="space-y-4 border-t border-[#27272A] bg-[#0B0B0E] p-5 sm:p-6 lg:border-l lg:border-t-0">
                <div className="flex items-center gap-2 text-sm font-black text-cyan-200">
                  <FileJson2 className="h-4 w-4" /> 要求格式
                </div>
                <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs leading-5 text-cyan-100/80">
                  <div className="font-bold text-cyan-100">给 ChatGPT 的要求：</div>
                  <div className="mt-1">{MANUAL_STORYBOARD_CHATGPT_INSTRUCTION}</div>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-[#303036] bg-black/30 p-4 text-[11px] leading-5 text-slate-300">
                  {MANUAL_STORYBOARD_IMPORT_EXAMPLE}
                </pre>
                <div className="space-y-1 text-xs leading-5 text-slate-500">
                  <div>• Shot 数量不固定，按故事实际需要输出。</div>
                  <div>• durationSeconds：1–60 秒。</div>
                  <div>• title / scene / camera / action 必填。</div>
                  <div>• dialogue / notes 没有内容时用空字符串。</div>
                  <div>• 导入不会调用 Gemini，不产生模型费用。</div>
                </div>
              </aside>
            </div>

            <div className="flex flex-col gap-2 border-t border-[#27272A] px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button
                type="button"
                onClick={close}
                className="rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={importStoryboard}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-black text-slate-950 hover:bg-cyan-400"
              >
                <ClipboardPaste className="h-4 w-4" /> 导入并拆分 Shot
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clapperboard,
  FileText,
  LockKeyhole,
  RotateCcw,
  Save,
  ShieldCheck,
} from 'lucide-react';

const DRAFT_KEY = 'zaojing_director_v01_brief';

export interface DirectorBriefDraft {
  version: 'director-brief-v0.1';
  title: string;
  sourceType: 'idea' | 'outline' | 'script';
  targetFormat: 'story_short' | 'vlog' | 'cosplay' | 'other';
  targetDurationSeconds: number;
  aspectRatio: '9:16';
  creativeBrief: string;
  fullScript: string;
  productionNotes: string;
  savedAt?: number;
}

const EMPTY_DRAFT: DirectorBriefDraft = {
  version: 'director-brief-v0.1',
  title: '',
  sourceType: 'idea',
  targetFormat: 'story_short',
  targetDurationSeconds: 30,
  aspectRatio: '9:16',
  creativeBrief: '',
  fullScript: '',
  productionNotes: '',
};

function readSavedDraft(): DirectorBriefDraft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<DirectorBriefDraft>;
    return {
      ...EMPTY_DRAFT,
      ...parsed,
      version: 'director-brief-v0.1',
      aspectRatio: '9:16',
      targetDurationSeconds: Math.max(4, Number(parsed.targetDurationSeconds || 30)),
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function formatSavedAt(value?: number) {
  if (!value) return '尚未保存';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export const ScriptDirectorPage: React.FC = () => {
  const [draft, setDraft] = useState<DirectorBriefDraft>(() => readSavedDraft());
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const hasContent = useMemo(
    () => Boolean(draft.creativeBrief.trim() || draft.fullScript.trim()),
    [draft.creativeBrief, draft.fullScript],
  );

  const update = <K extends keyof DirectorBriefDraft>(key: K, value: DirectorBriefDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage('');
    setError('');
  };

  const saveDraft = () => {
    if (!draft.title.trim()) {
      setError('请先填写项目标题。');
      return;
    }
    if (!hasContent) {
      setError('创意描述或完整脚本至少填写一项。');
      return;
    }
    const next: DirectorBriefDraft = {
      ...draft,
      title: draft.title.trim(),
      creativeBrief: draft.creativeBrief.trim(),
      fullScript: draft.fullScript.trim(),
      productionNotes: draft.productionNotes.trim(),
      savedAt: Date.now(),
    };
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    setDraft(next);
    setMessage('草稿已保存到当前浏览器；刷新页面后仍可继续编辑。');
  };

  const resetDraft = () => {
    if ((draft.title || hasContent) && !window.confirm('确认新建空白草稿？当前浏览器中的未导出内容将被清空。')) {
      return;
    }
    window.localStorage.removeItem(DRAFT_KEY);
    setDraft(EMPTY_DRAFT);
    setMessage('已新建空白草稿。');
    setError('');
  };

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-purple-400">
            <Clapperboard className="h-4 w-4" />
            Director Console · Step 1 / Manual MVP
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">导演台｜创意与脚本录入</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
            第一环节只解决一件事：把你的创意、故事梗概或完整脚本稳定录入并保存。当前不做 AI 拆镜、不生成图片、不调用 Veo，也不自动创建 Episode。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300">STEP 1 · 可独立验收</span>
          <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-bold text-zinc-300">NO PROVIDER CALLS</span>
        </div>
      </header>

      <section className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
          <div>
            <div className="text-sm font-bold text-sky-100">V0.1 验收边界</div>
            <p className="mt-1 text-xs leading-5 text-sky-100/70">
              本阶段数据仅保存在当前浏览器 localStorage，用于验证“输入 → 保存 → 刷新恢复 → 继续编辑”的产品闭环。跨设备云端持久化与 AI 拆镜属于后续独立环节，不在本次验收范围内。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6 space-y-6">
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <label htmlFor="director-title" className="mb-2 block text-xs font-bold text-slate-300">项目标题 *</label>
            <input
              id="director-title"
              value={draft.title}
              onChange={(event) => update('title', event.target.value)}
              placeholder="例如：押金扣光的第七天，我在出租屋手搓法杖"
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none transition focus:border-purple-500/70"
            />
          </div>

          <div>
            <label htmlFor="director-source-type" className="mb-2 block text-xs font-bold text-slate-300">当前输入成熟度</label>
            <select
              id="director-source-type"
              value={draft.sourceType}
              onChange={(event) => update('sourceType', event.target.value as DirectorBriefDraft['sourceType'])}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            >
              <option value="idea">一句创意 / 核心想法</option>
              <option value="outline">故事梗概 / 大纲</option>
              <option value="script">已有完整脚本</option>
            </select>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          <div>
            <label htmlFor="director-format" className="mb-2 block text-xs font-bold text-slate-300">目标内容形式</label>
            <select
              id="director-format"
              value={draft.targetFormat}
              onChange={(event) => update('targetFormat', event.target.value as DirectorBriefDraft['targetFormat'])}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            >
              <option value="story_short">剧情短视频</option>
              <option value="vlog">Vlog</option>
              <option value="cosplay">AI Cosplay</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div>
            <label htmlFor="director-duration" className="mb-2 block text-xs font-bold text-slate-300">目标总时长（秒）</label>
            <input
              id="director-duration"
              type="number"
              min={4}
              max={600}
              value={draft.targetDurationSeconds}
              onChange={(event) => update('targetDurationSeconds', Math.max(4, Number(event.target.value || 4)))}
              className="w-full rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm text-white outline-none focus:border-purple-500/70"
            />
          </div>
          <div>
            <label className="mb-2 block text-xs font-bold text-slate-300">画幅</label>
            <div className="flex h-[46px] items-center justify-between rounded-xl border border-[#303036] bg-[#09090B] px-4 text-sm text-white">
              <span>9:16 竖屏</span>
              <LockKeyhole className="h-4 w-4 text-slate-500" />
            </div>
          </div>
        </div>

        <div>
          <label htmlFor="director-brief" className="mb-2 flex items-center gap-2 text-xs font-bold text-slate-300">
            <FileText className="h-4 w-4 text-purple-400" /> 创意 / 故事梗概 *
          </label>
          <textarea
            id="director-brief"
            value={draft.creativeBrief}
            onChange={(event) => update('creativeBrief', event.target.value)}
            placeholder="用自然语言描述你想拍什么、故事发生什么、希望观众感受到什么。可以只有几句话。"
            rows={7}
            className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-purple-500/70"
          />
        </div>

        <div>
          <label htmlFor="director-script" className="mb-2 block text-xs font-bold text-slate-300">完整脚本（可选）</label>
          <textarea
            id="director-script"
            value={draft.fullScript}
            onChange={(event) => update('fullScript', event.target.value)}
            placeholder="如果已经有完整脚本，可直接粘贴在这里。当前版本只保存原文，不做自动改写或拆解。"
            rows={10}
            className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 font-mono text-sm leading-6 text-white outline-none transition focus:border-purple-500/70"
          />
        </div>

        <div>
          <label htmlFor="director-notes" className="mb-2 block text-xs font-bold text-slate-300">生产备注（可选）</label>
          <textarea
            id="director-notes"
            value={draft.productionNotes}
            onChange={(event) => update('productionNotes', event.target.value)}
            placeholder="角色、风格、禁用内容、参考作品、必须保留的剧情节点等。"
            rows={4}
            className="w-full resize-y rounded-xl border border-[#303036] bg-[#09090B] px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-purple-500/70"
          />
        </div>

        {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
        {message && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}</div>}

        <div className="flex flex-col gap-3 border-t border-[#27272A] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-slate-500">
            最后保存：<span data-testid="saved-at" className="font-mono text-slate-300">{formatSavedAt(draft.savedAt)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={resetDraft}
              className="inline-flex items-center gap-2 rounded-xl border border-[#34343A] bg-[#1A1A1F] px-4 py-2.5 text-sm font-bold text-slate-200 transition hover:bg-[#232329]"
            >
              <RotateCcw className="h-4 w-4" /> 新建空白草稿
            </button>
            <button
              type="button"
              onClick={saveDraft}
              className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-black text-white shadow-[0_0_20px_rgba(124,58,237,0.25)] transition hover:bg-purple-500"
            >
              <Save className="h-4 w-4" /> 保存草稿
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-black text-emerald-200">
            <CheckCircle2 className="h-5 w-5" /> 本环节验收标准
          </div>
          <div className="mt-4 grid gap-2 text-xs leading-5 text-emerald-100/75 sm:grid-cols-2">
            <div>① 能输入项目标题与创意/脚本</div>
            <div>② 能手工设置形式与目标时长</div>
            <div>③ 点击保存后刷新页面内容仍在</div>
            <div>④ 保存过程不调用任何 AI / Provider</div>
            <div>⑤ 可继续修改并再次保存</div>
            <div>⑥ 原生产状态页独立保留为“生产监控”</div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 opacity-80">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">NEXT · NOT IN THIS STAGE</div>
          <div className="mt-2 text-base font-black text-white">Step 2｜人工分镜拆解</div>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            等 Step 1 由你实际验收通过后，下一阶段才增加 Shot List，并先支持人工新增、编辑、排序与保存；仍不做 AI 自动拆镜。
          </p>
        </div>
      </section>
    </div>
  );
};

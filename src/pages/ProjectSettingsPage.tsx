import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Settings2, ShieldCheck } from 'lucide-react';
import { FormatPolicyEditor } from '../components/FormatPolicyEditor';
import { useDirectorCloud } from '../components/DirectorCloudPersistenceProvider';
import { DIRECTOR_DRAFT_KEY } from '../services/director/keyframeBlueprint';
import {
  DEFAULT_FORMAT_POLICY,
  LEGACY_FORMAT_POLICY,
  hasFormatPolicy,
  normalizeFormatPolicy,
  type ProductionFormatPolicy,
} from '../services/formatPolicy/formatPolicy';

interface DirectorDraftLike {
  title?: string;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  formatPolicy?: ProductionFormatPolicy;
  [key: string]: unknown;
}

function readDraft(): DirectorDraftLike {
  try {
    const raw = window.localStorage.getItem(DIRECTOR_DRAFT_KEY);
    return raw ? JSON.parse(raw) as DirectorDraftLike : {};
  } catch {
    return {};
  }
}

function policyFromDraft(draft: DirectorDraftLike, cloudPolicy?: unknown): ProductionFormatPolicy {
  const policyValue = draft.formatPolicy || cloudPolicy;
  if (hasFormatPolicy(policyValue)) return normalizeFormatPolicy(policyValue, DEFAULT_FORMAT_POLICY);
  if (draft.aspectRatio) {
    return normalizeFormatPolicy({
      defaultAspectRatio: draft.aspectRatio,
      allowedAspectRatios: [draft.aspectRatio],
      allowShotOverride: true,
    }, LEGACY_FORMAT_POLICY);
  }
  return DEFAULT_FORMAT_POLICY;
}

export const ProjectSettingsPage: React.FC = () => {
  const { record } = useDirectorCloud();
  const initialDraft = useMemo(() => readDraft(), []);
  const [policy, setPolicy] = useState(() => policyFromDraft(initialDraft, record?.snapshot.formatPolicy));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (record?.snapshot.formatPolicy && !hasFormatPolicy(initialDraft.formatPolicy)) {
      setPolicy(policyFromDraft(initialDraft, record.snapshot.formatPolicy));
    }
  }, [initialDraft, record?.snapshot.formatPolicy]);

  const save = () => {
    const draft = readDraft();
    const nextPolicy = normalizeFormatPolicy(policy, DEFAULT_FORMAT_POLICY);
    window.localStorage.setItem(DIRECTOR_DRAFT_KEY, JSON.stringify({
      ...draft,
      formatPolicy: nextPolicy,
      // Preserve legacy consumers while policy becomes authoritative.
      aspectRatio: nextPolicy.defaultAspectRatio,
      savedAt: Date.now(),
    }));
    setPolicy(nextPolicy);
    setSavedAt(Date.now());
    setMessage('Production Format Policy 已保存，Director Cloud 将自动同步。');
  };

  const title = record?.snapshot.projectTitle || initialDraft.title || '当前 Director 项目';

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-indigo-400"><Settings2 className="h-4 w-4" /> Director Console · Production Policy</div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">项目设置｜Production Format Policy</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">画幅策略只新增项目生产规则，不删除旧的 aspectRatio，也不改变 Project Binding、Blueprint 或 GCS 存储结构。</p>
        </div>
        <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-bold text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" /> Firestore + GCS</span>
      </header>

      <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div><div className="text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-300">PROJECT</div><h2 className="mt-1 text-xl font-black text-white">{title}</h2></div>
          <div className="text-xs text-slate-500">{record?.snapshot.projectId ? `projectId · ${record.snapshot.projectId}` : '项目尚未完成首次 Cloud 同步'}</div>
        </div>
        <FormatPolicyEditor value={policy} onChange={(next) => { setPolicy(next); setMessage(''); }} idPrefix="project-settings" />
        <div className="mt-5 flex flex-col gap-3 border-t border-[#27272A] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-slate-500">只写入现有 Director 项目草稿并由 Cloud Persistence 同步。</div>
          <button type="button" onClick={save} className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-black text-white hover:bg-indigo-500"><CheckCircle2 className="h-4 w-4" /> 保存画幅策略</button>
        </div>
        {message && <div className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{message}{savedAt ? ` · ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</div>}
      </section>
    </div>
  );
};


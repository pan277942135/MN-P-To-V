import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, KeyRound, Loader2, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import { FormatPolicyEditor } from '../components/FormatPolicyEditor';
import { useDirectorCloud } from '../components/DirectorCloudPersistenceProvider';
import { useProjectSession } from '../context/ProjectSessionContext';
import { DIRECTOR_DRAFT_KEY } from '../services/director/keyframeBlueprint';
import {
  createAiToken,
  listAiTokens,
  revokeAiToken,
} from '../services/aiDirector/aiDirectorClient';
import type { AiDirectorScope, DirectorAiTokenPublic } from '../services/aiDirector/aiDirectorTypes';
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

const AI_SCOPE_OPTIONS: Array<{ value: AiDirectorScope; label: string; description: string }> = [
  { value: 'context', label: 'Context', description: '项目、Episode、Shot、Blueprint' },
  { value: 'preview', label: 'Preview', description: '图片、视频预览和帧的 Signed URL' },
  { value: 'review_package', label: 'Review Package', description: '导出 AI 审核材料包' },
];

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
  const {
    project: sessionProject,
    projectId: sessionProjectId,
    bindingCode,
    syncLocalChanges,
  } = useProjectSession();
  const initialDraft = useMemo(() => readDraft(), []);
  const [policy, setPolicy] = useState(() => policyFromDraft(initialDraft, record?.snapshot.formatPolicy || sessionProject?.formatPolicy));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const projectId = String(sessionProjectId || sessionProject?.projectId || record?.snapshot.projectId || '');
  const [tokenName, setTokenName] = useState('ChatGPT Director');
  const [selectedScopes, setSelectedScopes] = useState<AiDirectorScope[]>(['context', 'preview', 'review_package']);
  const [tokens, setTokens] = useState<DirectorAiTokenPublic[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [newToken, setNewToken] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const cloudPolicy = record?.snapshot.formatPolicy || sessionProject?.formatPolicy;
    if (cloudPolicy && !hasFormatPolicy(initialDraft.formatPolicy)) {
      setPolicy(policyFromDraft(initialDraft, cloudPolicy));
    }
  }, [initialDraft, record?.snapshot.formatPolicy, sessionProject?.formatPolicy]);

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
    void syncLocalChanges().catch(() => undefined);
  };

  const title = String(sessionProject?.projectTitle || record?.snapshot.projectTitle || initialDraft.title || '当前 Director 项目');

  useEffect(() => {
    if (!projectId || !bindingCode) {
      setTokens([]);
      return;
    }
    let cancelled = false;
    setTokensLoading(true);
    setTokenError('');
    void listAiTokens(projectId, bindingCode)
      .then((response) => {
        if (!cancelled) setTokens(response.tokens || []);
      })
      .catch((error) => {
        if (!cancelled) setTokenError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setTokensLoading(false);
      });
    return () => { cancelled = true; };
  }, [bindingCode, projectId]);

  const toggleScope = (scope: AiDirectorScope) => {
    setSelectedScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
    setTokenError('');
  };

  const createToken = async () => {
    if (!projectId || !bindingCode) {
      setTokenError('请先通过 Project Binding 打开项目。');
      return;
    }
    if (!selectedScopes.length) {
      setTokenError('至少选择一个 AI Token 权限。');
      return;
    }
    setTokenSaving(true);
    setTokenError('');
    setNewToken('');
    setCopied(false);
    try {
      const created = await createAiToken({ projectId, name: tokenName, scope: selectedScopes }, bindingCode);
      setTokens((current) => [created, ...current.filter((item) => item.tokenId !== created.tokenId)]);
      setNewToken(created.token);
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : String(error));
    } finally {
      setTokenSaving(false);
    }
  };

  const copyToken = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
    } catch {
      setTokenError('复制失败，请手动复制 Token。');
    }
  };

  const revokeToken = async (token: DirectorAiTokenPublic) => {
    if (!bindingCode || !window.confirm(`确定撤销「${token.name}」吗？撤销后外部 AI 将无法继续访问。`)) return;
    setTokenError('');
    try {
      await revokeAiToken(token.tokenId, bindingCode);
      setTokens((current) => current.map((item) => item.tokenId === token.tokenId ? { ...item, status: 'REVOKED' } : item));
      if (newToken && token.status === 'ACTIVE') setNewToken('');
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : String(error));
    }
  };

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

      <section className="rounded-2xl border border-[#27272A] bg-[#111114] p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-300"><KeyRound className="h-4 w-4" /> AI Director Gateway</div>
            <h2 className="text-xl font-black text-white">AI Director Access</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">为外部 AI 创建项目级只读访问 Token。网关只保存 SHA-256，不保存明文 Token；预览链接默认 15 分钟后失效。</p>
          </div>
          <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-indigo-500/25 bg-indigo-500/10 px-3 py-1.5 text-[11px] font-bold text-indigo-300"><ShieldCheck className="h-3.5 w-3.5" /> Read only</span>
        </div>

        {!projectId || !bindingCode ? (
          <div className="mt-5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-200">请先通过 Project Binding 打开项目，再管理 AI Director Token。Token 不会写入浏览器存储。</div>
        ) : (
          <>
            <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] lg:items-end">
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-400">Token Name</span>
                <input value={tokenName} onChange={(event) => setTokenName(event.target.value)} className="w-full rounded-xl border border-[#3F3F46] bg-[#18181B] px-3 py-2.5 text-sm text-white outline-none transition focus:border-indigo-400" placeholder="ChatGPT Director" />
              </label>
              <div>
                <span className="mb-2 block text-xs font-bold text-slate-400">Permission</span>
                <div className="grid gap-2 sm:grid-cols-3">
                  {AI_SCOPE_OPTIONS.map((option) => (
                    <label key={option.value} className={`cursor-pointer rounded-xl border px-3 py-2.5 transition ${selectedScopes.includes(option.value) ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-[#3F3F46] bg-[#18181B]'}`}>
                      <span className="flex items-center gap-2 text-sm font-bold text-white"><input type="checkbox" checked={selectedScopes.includes(option.value)} onChange={() => toggleScope(option.value)} className="accent-indigo-500" /> {option.label}</span>
                      <span className="mt-1 block text-[11px] leading-4 text-slate-500">{option.description}</span>
                    </label>
                  ))}
                </div>
              </div>
              <button type="button" disabled={tokenSaving || !selectedScopes.length} onClick={() => void createToken()} className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-black text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                {tokenSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} 创建 Token
              </button>
            </div>

            {newToken && <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
              <div className="text-xs font-bold text-emerald-300">Token 已创建，仅在这里显示一次</div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <code className="min-w-0 flex-1 break-all rounded-lg border border-emerald-500/20 bg-black/20 px-3 py-2 text-xs text-emerald-100">{newToken}</code>
                <button type="button" onClick={() => void copyToken()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-400/30 px-3 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-400/10"><Copy className="h-3.5 w-3.5" /> {copied ? '已复制' : '复制'}</button>
              </div>
            </div>}

            <div className="mt-6 border-t border-[#27272A] pt-5">
              <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-black text-white">Existing Tokens</h3>{tokensLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />}</div>
              {tokens.length === 0 && !tokensLoading ? <div className="rounded-xl border border-dashed border-[#3F3F46] px-4 py-5 text-sm text-slate-500">当前项目还没有 AI Token。</div> : <div className="space-y-2">
                {tokens.map((token) => <div key={token.tokenId} className="flex flex-col gap-3 rounded-xl border border-[#27272A] bg-[#18181B] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2 text-sm font-bold text-white"><span className="truncate">{token.name}</span><span className={`rounded-full px-2 py-0.5 text-[10px] ${token.status === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-slate-500/10 text-slate-400'}`}>{token.status}</span></div><div className="mt-1 text-[11px] text-slate-500">{token.scope.join(' · ')} · 创建于 {token.createdAt ? new Date(token.createdAt).toLocaleString('zh-CN') : '—'}</div></div>
                  {token.status === 'ACTIVE' && <button type="button" onClick={() => void revokeToken(token)} className="inline-flex items-center justify-center gap-1.5 self-start rounded-lg border border-rose-500/25 px-3 py-2 text-xs font-bold text-rose-300 hover:bg-rose-500/10 sm:self-auto"><Trash2 className="h-3.5 w-3.5" /> 撤销</button>}
                </div>)}
              </div>}
            </div>
            {tokenError && <div className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{tokenError}</div>}
          </>
        )}
      </section>
    </div>
  );
};

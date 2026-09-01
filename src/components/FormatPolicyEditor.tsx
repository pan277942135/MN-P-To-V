import React from 'react';
import { Check, Film, Smartphone, Square } from 'lucide-react';
import {
  SUPPORTED_ASPECT_RATIOS,
  type AspectRatio,
  type ProductionFormatPolicy,
} from '../services/formatPolicy/formatPolicy';

const RATIO_LABELS: Record<AspectRatio, { label: string; hint: string; icon: typeof Film }> = {
  '16:9': { label: '横屏 16:9', hint: '电影 / AI 漫剧', icon: Film },
  '9:16': { label: '竖屏 9:16', hint: '短视频', icon: Smartphone },
  '1:1': { label: '方形 1:1', hint: '海报 / 社交平台', icon: Square },
};

interface FormatPolicyEditorProps {
  value: ProductionFormatPolicy;
  onChange: (value: ProductionFormatPolicy) => void;
  idPrefix?: string;
  title?: string;
  compact?: boolean;
}

export const FormatPolicyEditor: React.FC<FormatPolicyEditorProps> = ({
  value,
  onChange,
  idPrefix = 'format-policy',
  title = 'Production Format Policy',
  compact = false,
}) => {
  const setDefault = (defaultAspectRatio: AspectRatio) => {
    onChange({
      ...value,
      defaultAspectRatio,
      allowedAspectRatios: value.allowedAspectRatios.includes(defaultAspectRatio)
        ? value.allowedAspectRatios
        : [defaultAspectRatio, ...value.allowedAspectRatios],
    });
  };

  const toggleAllowed = (aspectRatio: AspectRatio) => {
    const allowed = value.allowedAspectRatios.includes(aspectRatio)
      ? value.allowedAspectRatios.filter((item) => item !== aspectRatio)
      : [...value.allowedAspectRatios, aspectRatio];
    if (allowed.length === 0 || !allowed.includes(value.defaultAspectRatio)) return;
    onChange({ ...value, allowedAspectRatios: allowed });
  };

  return (
    <section className={`rounded-2xl border border-indigo-500/20 bg-indigo-500/5 ${compact ? 'p-4' : 'p-5 sm:p-6'}`}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-300">Production Policy</div>
          <h3 className="mt-1 text-base font-black text-white">{title}</h3>
        </div>
        <div className="text-xs text-indigo-200/65">策略优先于旧 aspectRatio 字段</div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-bold text-slate-300">默认画幅</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {SUPPORTED_ASPECT_RATIOS.map((aspectRatio) => {
              const option = RATIO_LABELS[aspectRatio];
              const Icon = option.icon;
              const selected = value.defaultAspectRatio === aspectRatio;
              return (
                <button
                  type="button"
                  key={aspectRatio}
                  aria-pressed={selected}
                  onClick={() => setDefault(aspectRatio)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition ${selected ? 'border-indigo-400/60 bg-indigo-500/20 text-white' : 'border-[#34343A] bg-[#09090B] text-slate-400 hover:border-indigo-400/40 hover:text-slate-200'}`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${selected ? 'text-indigo-300' : 'text-slate-600'}`} />
                  <span className="min-w-0">
                    <span className="block text-xs font-black">{option.label}</span>
                    <span className="block text-[10px] text-slate-500">{option.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-bold text-slate-300">允许进入项目的画幅</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {SUPPORTED_ASPECT_RATIOS.map((aspectRatio) => {
              const id = `${idPrefix}-allowed-${aspectRatio.replace(':', '-')}`;
              const checked = value.allowedAspectRatios.includes(aspectRatio);
              const isDefault = value.defaultAspectRatio === aspectRatio;
              return (
                <label key={aspectRatio} htmlFor={id} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-bold ${checked ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100' : 'border-[#34343A] bg-[#09090B] text-slate-500'}`}>
                  <input id={id} type="checkbox" checked={checked} disabled={isDefault} onChange={() => toggleAllowed(aspectRatio)} className="sr-only" />
                  <span className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? 'border-emerald-300 bg-emerald-400 text-zinc-950' : 'border-slate-600'}`}>
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  {aspectRatio}
                  {isDefault && <span className="ml-auto text-[10px] text-emerald-300/70">默认</span>}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <label htmlFor={`${idPrefix}-shot-override`} className="mt-4 flex cursor-pointer items-center gap-3 rounded-xl border border-[#34343A] bg-[#09090B] px-3 py-3 text-sm text-slate-200">
        <input
          id={`${idPrefix}-shot-override`}
          type="checkbox"
          checked={value.allowShotOverride}
          onChange={(event) => onChange({ ...value, allowShotOverride: event.target.checked })}
          className="h-4 w-4 accent-indigo-500"
        />
        <span>
          <span className="block font-bold">允许镜头单独覆盖</span>
          <span className="mt-0.5 block text-xs text-slate-500">开启后，Shot 可在允许集合内使用不同画幅。</span>
        </span>
        <span className={`ml-auto rounded-full px-2.5 py-1 text-[10px] font-black ${value.allowShotOverride ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-500'}`}>{value.allowShotOverride ? 'ON' : 'OFF'}</span>
      </label>
    </section>
  );
};


import React from 'react';
import { Clapperboard, Film, Users, History, Settings, Sparkles, ClipboardCheck } from 'lucide-react';

export type NavTab = 'director' | 'studio' | 'characters' | 'review' | 'history' | 'settings';

interface SidebarProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange }) => {
  const navItems = [
    { id: 'director' as NavTab, label: '导演台', icon: Clapperboard, desc: '整集 S01–S06 生产、门禁与进度控制' },
    { id: 'studio' as NavTab, label: '创作工作台', icon: Film, desc: '单镜头场景、首帧与视频生成' },
    { id: 'characters' as NavTab, label: '角色库', icon: Users, desc: '建立并长期复用角色身份包' },
    { id: 'review' as NavTab, label: '待我审核', icon: ClipboardCheck, desc: '集中处理 AI REVIEW 视频与边界验收' },
    { id: 'history' as NavTab, label: '任务记录', icon: History, desc: '查看历史任务与质检报告' },
    { id: 'settings' as NavTab, label: '算力设置', icon: Settings, desc: '配置 Google Cloud / Gemini 凭据' },
  ];

  return (
    <>
      <aside className="hidden md:flex w-64 border-r border-[#1F1F23] bg-[#0F0F12] p-4 flex-col justify-between shrink-0">
        <div className="space-y-1">
          <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-[#64748B] flex items-center">
            <span className="w-1.5 h-1.5 rounded-full bg-[#7C3AED] mr-2"></span>
            主要功能
          </div>

          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`w-full flex items-start space-x-3 px-3.5 py-3 rounded-xl text-left transition duration-150 group ${
                  isActive
                    ? 'bg-[#2D1B4D] text-[#A855F7] border border-[#7C3AED]/40 shadow-[0_0_15px_rgba(124,58,237,0.15)]'
                    : 'text-[#64748B] hover:bg-[#16161A] hover:text-[#CBD5E1] border border-transparent'
                }`}
              >
                <Icon
                  className={`w-5 h-5 shrink-0 mt-0.5 transition-colors ${
                    isActive ? 'text-[#A855F7]' : 'text-[#64748B] group-hover:text-[#CBD5E1]'
                  }`}
                />
                <div>
                  <div className={`text-sm font-semibold ${isActive ? 'text-white' : 'text-[#CBD5E1]'}`}>
                    {item.label}
                  </div>
                  <div className="text-xs text-[#64748B] font-normal leading-snug mt-0.5">
                    {item.desc}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="p-3.5 bg-[#16161A] border border-[#2D2D33] rounded-xl text-xs space-y-2 text-[#94A3B8]">
          <div className="flex items-center space-x-1.5 text-[#C084FC] font-semibold">
            <Sparkles className="w-3.5 h-3.5 text-[#A855F7]" />
            <span>成人角色与授权规范</span>
          </div>
          <p className="leading-relaxed text-[#64748B] text-[11px]">
            仅建立成年虚拟人物，锁定五官与肢体解剖结构，保障 8 秒连续镜头高一致性。
          </p>
        </div>
      </aside>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#0F0F12]/95 backdrop-blur-lg border-t border-[#1F1F23] flex items-center justify-around px-1 py-2.5 shadow-2xl overflow-x-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`min-w-[58px] flex flex-col items-center justify-center space-y-1 px-2 py-1 rounded-lg transition ${
                isActive ? 'text-[#A855F7]' : 'text-[#64748B] active:text-[#CBD5E1]'
              }`}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'text-[#A855F7]' : 'text-[#64748B]'}`} />
              <span className={`text-[9px] font-medium whitespace-nowrap ${isActive ? 'text-white font-semibold' : 'text-[#64748B]'}`}>
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
};

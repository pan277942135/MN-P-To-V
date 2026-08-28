import React, { useState, useRef, useEffect } from 'react';
import { ConnectionProvider } from './context/ConnectionContext';
import { Navbar } from './components/Navbar';
import { Sidebar, type NavTab } from './components/Sidebar';
import { GeminiStoryboardDirectorPage } from './pages/GeminiStoryboardDirectorPage';
import { KeyframeBlueprintPage } from './pages/KeyframeBlueprintPage';
import { KeyframeAssetPage } from './pages/KeyframeAssetPage';
import { DirectorConsolePage } from './pages/DirectorConsolePage';
import { StudioPage } from './pages/StudioPage';
import { CharacterLibraryPage } from './pages/CharacterLibraryPage';
import { TaskHistoryPage } from './pages/TaskHistoryPage';
import { HumanReviewQueuePage } from './pages/HumanReviewQueuePage';
import { ComputeSettingsPage } from './pages/ComputeSettingsPage';

export function AppContent() {
  const [activeTab, setActiveTab] = useState<NavTab>('director');
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [activeTab]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Navbar />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />

        <main ref={mainRef} className="flex-1 overflow-y-auto bg-zinc-950/50 pb-20 md:pb-0">
          <div className={activeTab === 'director' ? 'block' : 'hidden'}>
            <GeminiStoryboardDirectorPage />
          </div>

          <div className={activeTab === 'keyframes' ? 'block' : 'hidden'}>
            {activeTab === 'keyframes' && <KeyframeBlueprintPage />}
          </div>

          <div className={activeTab === 'keyframe-assets' ? 'block' : 'hidden'}>
            {activeTab === 'keyframe-assets' && <KeyframeAssetPage />}
          </div>

          <div className={activeTab === 'monitor' ? 'block' : 'hidden'}>
            <DirectorConsolePage />
          </div>

          <div className={activeTab === 'studio' ? 'block' : 'hidden'}>
            <StudioPage
              onNavigateToCharacters={() => setActiveTab('characters')}
              onNavigateToSettings={() => setActiveTab('settings')}
              onNavigateToHistory={() => setActiveTab('history')}
            />
          </div>

          <div className={activeTab === 'characters' ? 'block' : 'hidden'}>
            <CharacterLibraryPage />
          </div>

          <div className={activeTab === 'review' ? 'block' : 'hidden'}>
            <HumanReviewQueuePage onNavigateToStudio={() => setActiveTab('studio')} />
          </div>

          <div className={activeTab === 'history' ? 'block' : 'hidden'}>
            <TaskHistoryPage onNavigateToStudio={() => setActiveTab('studio')} />
          </div>

          <div className={activeTab === 'settings' ? 'block' : 'hidden'}>
            <ComputeSettingsPage />
          </div>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ConnectionProvider>
      <AppContent />
    </ConnectionProvider>
  );
}

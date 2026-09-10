import React, { useState, useRef, useEffect } from 'react';
import { ConnectionProvider } from './context/ConnectionContext';
import { Navbar } from './components/Navbar';
import { Sidebar, type NavTab } from './components/Sidebar';
import { DirectorCloudPersistenceProvider } from './components/DirectorCloudPersistenceProvider';
import { GeminiStoryboardDirectorPage } from './pages/GeminiStoryboardDirectorPage';
import { ShotListPage } from './pages/ShotListPage';
import { KeyframeBlueprintPage } from './pages/KeyframeBlueprintPage';
import { ManualKeyframePage } from './pages/ManualKeyframePage';
import { ShotVideoBlueprintPage } from './pages/ShotVideoBlueprintPage';
import { DirectorConsolePage } from './pages/DirectorConsolePage';
import { StudioPage } from './pages/StudioPage';
import { CharacterLibraryPage } from './pages/CharacterLibraryPage';
import { TaskHistoryPage } from './pages/TaskHistoryPage';
import { HumanReviewQueuePage } from './pages/HumanReviewQueuePage';
import { ComputeSettingsPage } from './pages/ComputeSettingsPage';
import { AssetLibraryPage } from './pages/AssetLibraryPage';
import { DirectorContextPage } from './pages/DirectorContextPage';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { ProjectSessionProvider, useProjectSession } from './context/ProjectSessionContext';
import { ProjectHomePage } from './pages/ProjectHomePage';
import { ProjectContextBar } from './components/ProjectContextBar';
import { DirectorErrorBoundary } from './components/DirectorErrorBoundary';

function routeProjectId(pathname: string): string {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function routeTab(pathname: string): NavTab {
  if (/\/shots(?:\/|$)/.test(pathname)) return 'shot-list';
  if (/\/assets(?:\/|$)/.test(pathname)) return 'assets';
  if (/\/ai-director/.test(pathname)) return 'director-context';
  return 'director';
}

export function AppContent({ onRouteChange }: { onRouteChange?: (path: string) => void } = {}) {
  // Legacy source contract: default tab remains director.
  // useState<NavTab>('director')
  const [pathname, setPathname] = useState(() => window.location.pathname || '/projects');
  const [activeTab, setActiveTab] = useState<NavTab>(() => routeTab(window.location.pathname || '/projects'));
  const mainProjectSession = useProjectSession();
  const { project, episode, projectId, episodeId, status, refreshSession } = mainProjectSession;
  const projectFromRoute = routeProjectId(pathname);
  // Project First Navigation: /projects renders before any Session Restore call.
  const isProjectHome = pathname === '/projects' || pathname === '/projects/';
  const isWorkspace = Boolean(projectFromRoute);

  const navigate = (nextPath: string, nextTab?: NavTab) => {
    window.history.pushState({}, '', nextPath);
    setPathname(nextPath);
    onRouteChange?.(nextPath);
    if (nextTab) setActiveTab(nextTab);
  };
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (pathname === '/') {
      window.history.replaceState({}, '', '/projects');
      setPathname('/projects');
      setActiveTab('director');
    }
  }, [pathname]);

  useEffect(() => {
    const onPopState = () => {
      const next = window.location.pathname || '/projects';
      setPathname(next);
      setActiveTab(routeTab(next));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (isWorkspace && projectFromRoute && projectFromRoute !== projectId && status !== 'loading') {
      void refreshSession(projectFromRoute).catch(() => undefined);
    }
  }, [isWorkspace, projectFromRoute, projectId, refreshSession, status]);

  useEffect(() => {
    const legacy = pathname.match(/^\/(shots|assets|episodes)\/([^/]+)/);
    if (!legacy || !projectId) return;
    const target = legacy[1] === 'shots' ? 'shots' : legacy[1] === 'assets' ? 'assets' : 'episodes';
    navigate(`/projects/${encodeURIComponent(projectId)}/${target}/${encodeURIComponent(legacy[2])}`, routeTab(pathname));
  }, [pathname, projectId]);

  useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [activeTab]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Navbar />

      <div className="flex flex-1 overflow-hidden">
        {isWorkspace && <Sidebar activeTab={activeTab} onTabChange={(tab) => {
          setActiveTab(tab);
          const suffix: Record<string, string> = {
            director: '',
            'shot-list': '/shots',
            keyframes: '/keyframes',
            'keyframe-assets': '/keyframes/assets',
            'video-blueprint': '/video-blueprint',
            assets: '/assets',
            'director-context': '/ai-director',
            'project-settings': '/settings',
            monitor: '/monitor',
          };
          navigate(`/projects/${encodeURIComponent(projectFromRoute)}${suffix[tab] || ''}`);
        }} />}

        <main ref={mainRef} className="flex-1 overflow-y-auto bg-zinc-950/50 pb-20 md:pb-0">
          {isProjectHome && <ProjectHomePage onOpenProject={(id) => navigate(`/projects/${encodeURIComponent(id)}`)} />}
          {isWorkspace && <ProjectContextBar
            projectName={String(project?.projectTitle || project?.title || projectFromRoute)}
            episodeName={String(episode?.title || episodeId || '')}
            activeTab={activeTab}
            onBack={() => navigate('/projects')}
            onAiDirector={() => navigate(`/projects/${encodeURIComponent(projectFromRoute)}/ai-director`, 'director-context')}
          />}
          {isWorkspace && status === 'error' && <div className="mx-auto max-w-7xl px-5 pt-4 text-sm text-rose-300 sm:px-8">项目上下文加载失败，当前页面未切换到其他项目。</div>}
          {isWorkspace && <>
          <div className={activeTab === 'director' ? 'block' : 'hidden'}>
            {activeTab === 'director' && <GeminiStoryboardDirectorPage />}
          </div>

          <div className={activeTab === 'shot-list' ? 'block' : 'hidden'}>
            {activeTab === 'shot-list' && <ShotListPage />}
          </div>

          <div className={activeTab === 'keyframes' ? 'block' : 'hidden'}>
            {activeTab === 'keyframes' && <KeyframeBlueprintPage />}
          </div>

          <div className={activeTab === 'keyframe-assets' ? 'block' : 'hidden'}>
            {activeTab === 'keyframe-assets' && <ManualKeyframePage />}
          </div>

          <div className={activeTab === 'video-blueprint' ? 'block' : 'hidden'}>
            {activeTab === 'video-blueprint' && <ShotVideoBlueprintPage />}
          </div>

          <div className={activeTab === 'assets' ? 'block' : 'hidden'}>
            {activeTab === 'assets' && <AssetLibraryPage />}
          </div>

          <div className={activeTab === 'director-context' ? 'block' : 'hidden'}>
            {activeTab === 'director-context' && <DirectorContextPage />}
          </div>

          <div className={activeTab === 'project-settings' ? 'block' : 'hidden'}>
            {activeTab === 'project-settings' && <ProjectSettingsPage />}
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
        </>}
        </main>
      </div>
    </div>
  );
}

function ProjectFirstRouter() {
  const [pathname, setPathname] = useState(() => window.location.pathname || '/projects');
  const isProjectList = pathname === '/' || pathname === '/projects' || pathname === '/projects/';
  const navigate = (nextPath: string) => {
    window.history.pushState({}, '', nextPath);
    setPathname(nextPath);
  };

  useEffect(() => {
    if (pathname === '/') {
      window.history.replaceState({}, '', '/projects');
      setPathname('/projects');
    }
    const onPopState = () => setPathname(window.location.pathname || '/projects');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [pathname]);

  if (isProjectList) {
    return <ProjectHomePage onOpenProject={(projectId) => navigate('/projects/' + encodeURIComponent(projectId))} />;
  }

  return (
    <DirectorCloudPersistenceProvider>
      <ProjectSessionProvider>
        <AppContent onRouteChange={setPathname} />
      </ProjectSessionProvider>
    </DirectorCloudPersistenceProvider>
  );
}

export default function App() {
  return (
    <DirectorErrorBoundary>
      <ConnectionProvider>
        <ProjectFirstRouter />
      </ConnectionProvider>
    </DirectorErrorBoundary>
  );
}

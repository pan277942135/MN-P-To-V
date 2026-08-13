from pathlib import Path

APP = Path('src/App.tsx')
SIDEBAR = Path('src/components/Sidebar.tsx')

app = APP.read_text()
sidebar = SIDEBAR.read_text()

changed = []

if "./pages/HumanReviewQueuePage" not in app:
    app = app.replace(
        "import { TaskHistoryPage } from './pages/TaskHistoryPage';\n",
        "import { TaskHistoryPage } from './pages/TaskHistoryPage';\nimport { HumanReviewQueuePage } from './pages/HumanReviewQueuePage';\n",
        1,
    )
    anchor = """          <div className={activeTab === 'history' ? 'block' : 'hidden'}>\n            <TaskHistoryPage onNavigateToStudio={() => setActiveTab('studio')} />\n          </div>\n"""
    review_block = """          <div className={activeTab === 'review' ? 'block' : 'hidden'}>\n            <HumanReviewQueuePage onNavigateToStudio={() => setActiveTab('studio')} />\n          </div>\n\n"""
    if anchor not in app:
        raise SystemExit('App review navigation anchor not found')
    app = app.replace(anchor, review_block + anchor, 1)
    APP.write_text(app)
    changed.append(str(APP))

if "'review'" not in sidebar.split('export type NavTab', 1)[1].split(';', 1)[0]:
    sidebar = sidebar.replace(
        "import { Film, Users, History, Settings, Sparkles } from 'lucide-react';",
        "import { Film, Users, History, Settings, Sparkles, ClipboardCheck } from 'lucide-react';",
        1,
    )
    sidebar = sidebar.replace(
        "export type NavTab = 'studio' | 'characters' | 'history' | 'settings';",
        "export type NavTab = 'studio' | 'characters' | 'review' | 'history' | 'settings';",
        1,
    )
    nav_anchor = "    { id: 'characters' as NavTab, label: '角色库', icon: Users, desc: '建立并长期复用角色身份包' },\n"
    nav_item = "    { id: 'review' as NavTab, label: '待我审核', icon: ClipboardCheck, desc: '集中处理 AI REVIEW 视频与边界验收' },\n"
    if nav_anchor not in sidebar:
        raise SystemExit('Sidebar navigation anchor not found')
    sidebar = sidebar.replace(nav_anchor, nav_anchor + nav_item, 1)
    SIDEBAR.write_text(sidebar)
    changed.append(str(SIDEBAR))

print('Applied M3-1 review queue navigation:' if changed else 'M3-1 navigation already applied', ', '.join(changed))

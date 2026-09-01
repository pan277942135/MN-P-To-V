// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROJECT_BINDING_HISTORY_KEY,
  clearProjectBindingHistory,
  readProjectBindingHistory,
  rememberProjectBinding,
  removeProjectBinding,
} from '../services/director/projectBindingHistory';

describe('Project Binding History', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('stores only shortcut metadata and sorts the most recently opened first', () => {
    rememberProjectBinding({
      bindingCode: 'ZJ-OLD-0001',
      projectId: 'project-old',
      projectTitle: '旧项目',
      lastOpenedAt: 100,
    });
    rememberProjectBinding({
      bindingCode: 'ZJ-NEW-0002',
      projectId: 'project-new',
      projectTitle: '新项目',
      lastOpenedAt: 200,
    });

    expect(readProjectBindingHistory().map((item) => item.projectId)).toEqual(['project-new', 'project-old']);
    const stored = JSON.parse(window.localStorage.getItem(PROJECT_BINDING_HISTORY_KEY) || '[]');
    expect(stored[0]).toEqual({
      bindingCode: 'ZJ-NEW-0002',
      projectId: 'project-new',
      projectTitle: '新项目',
      lastOpenedAt: 200,
    });
    expect(stored[0]).not.toHaveProperty('assets');
    expect(stored[0]).not.toHaveProperty('snapshot');
  });

  it('deduplicates a binding and supports deleting one or all entries', () => {
    rememberProjectBinding({
      bindingCode: 'zj-abcd-1234',
      projectId: 'project-a',
      projectTitle: '项目 A',
      lastOpenedAt: 100,
    });
    rememberProjectBinding({
      bindingCode: 'ZJ-ABCD-1234',
      projectId: 'project-a',
      projectTitle: '项目 A（最新）',
      lastOpenedAt: 300,
    });
    expect(readProjectBindingHistory()).toHaveLength(1);
    expect(readProjectBindingHistory()[0].projectTitle).toBe('项目 A（最新）');

    expect(removeProjectBinding('zj-abcd-1234')).toEqual([]);
    clearProjectBindingHistory();
    expect(readProjectBindingHistory()).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ProjectBindingService,
  generateProjectBindingCode,
  normalizeBindingCode,
} from '../server/services/projectBindingService';

function store() {
  const records = new Map<string, any>();
  return {
    records,
    isAvailable: () => true,
    reserveBinding: async (record: any) => {
      if (records.has(record.normalizedCode)) return false;
      records.set(record.normalizedCode, record);
      return true;
    },
    getBinding: async (normalizedCode: string) => records.get(normalizedCode) || null,
  };
}

describe('Project Binding Service', () => {
  it('generates a readable mixed-case code with separators and no project id', () => {
    const code = generateProjectBindingCode();
    expect(code).toMatch(/^ZJ-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
    expect(code.length).toBeGreaterThanOrEqual(8);
    expect(code).toMatch(/[A-Z]/);
    expect(code).toMatch(/[a-z]/);
    expect(code).toMatch(/[0-9]/);
    expect(code).not.toContain('project');
  });

  it('reserves a unique code and resolves it case-insensitively', async () => {
    const backing = store();
    const service = new ProjectBindingService({
      store: backing,
      now: () => 100,
      createCode: () => 'ZJ-Ab7K-x2M8',
    });

    const code = await service.createBinding('project-a');
    expect(code).toBe('ZJ-Ab7K-x2M8');
    expect(backing.records.get(normalizeBindingCode(code)).projectId).toBe('project-a');
    expect(await service.resolveBinding(' zj-ab7k-x2m8 ')).toBe('project-a');
  });

  it('retries a collision without returning a duplicate binding', async () => {
    const backing = store();
    backing.records.set('ZJ-AB7K-X2M8', { status: 'ACTIVE' });
    let call = 0;
    const service = new ProjectBindingService({
      store: backing,
      createCode: () => (++call === 1 ? 'ZJ-Ab7K-x2M8' : 'ZJ-Cd8N-y3P9'),
    });

    await expect(service.createBinding('project-a')).resolves.toBe('ZJ-Cd8N-y3P9');
  });

  it('fails closed for malformed and expired codes', async () => {
    const backing = store();
    backing.records.set('ZJ-AB7K-X2M8', {
      bindingCode: 'ZJ-Ab7K-x2M8',
      normalizedCode: 'ZJ-AB7K-X2M8',
      projectId: 'project-a',
      createdAt: 100,
      status: 'ACTIVE',
      expiresAt: 99,
    });
    const service = new ProjectBindingService({ store: backing, now: () => 100 });

    await expect(service.resolveBinding('not-a-binding')).rejects.toMatchObject({ code: 'BINDING_CODE_INVALID', statusCode: 400 });
    await expect(service.resolveBinding('ZJ-Ab7K-x2M8')).resolves.toBeNull();
  });
});

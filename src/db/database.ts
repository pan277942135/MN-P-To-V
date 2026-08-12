import Dexie, { type Table } from 'dexie';
import type { CharacterProfile, GenerationTask, SavedComputeConfig } from '../types';

export class ZaoJingDatabase extends Dexie {
  characters!: Table<CharacterProfile, string>;
  tasks!: Table<GenerationTask, string>;
  computeConfigs!: Table<SavedComputeConfig, string>;

  constructor() {
    super('ZaoJingWorkbenchDB');
    this.version(1).stores({
      characters: 'id, name, status, adultConfirmed, updatedAt',
      tasks: 'id, characterId, status, createdAt, updatedAt',
    });
    this.version(2).stores({
      characters: 'id, name, status, adultConfirmed, updatedAt',
      tasks: 'id, characterId, status, createdAt, updatedAt',
      computeConfigs: 'id, activeTab, updatedAt',
    });
  }
}

export const db = new ZaoJingDatabase();

import Dexie, { type Table } from 'dexie';
import type { CharacterProfile, GenerationTask, SavedComputeConfig } from '../types';

export interface KeyframeAssetBlobRecord {
  id: string;
  shotUid: string;
  blob: Blob;
  mimeType: string;
  updatedAt: number;
}

export class ZaoJingDatabase extends Dexie {
  characters!: Table<CharacterProfile, string>;
  tasks!: Table<GenerationTask, string>;
  computeConfigs!: Table<SavedComputeConfig, string>;
  keyframeAssets!: Table<KeyframeAssetBlobRecord, string>;

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
    this.version(3).stores({
      characters: 'id, name, status, adultConfirmed, updatedAt',
      tasks: 'id, characterId, status, createdAt, updatedAt',
      computeConfigs: 'id, activeTab, updatedAt',
      keyframeAssets: 'id, shotUid, updatedAt',
    });
  }
}

export const db = new ZaoJingDatabase();
import { getFirestoreInstance, markFirestoreUnavailable } from '../db/firestore';

export const DIRECTOR_PROJECT_COLLECTION = 'director_projects';
export const DIRECTOR_CLOUD_SCHEMA = 'zaojing.director.cloud.v1' as const;

export interface DirectorCloudSnapshot {
  schema: typeof DIRECTOR_CLOUD_SCHEMA;
  projectId: string;
  episodeId: string;
  seriesTitle: string;
  projectTitle: string;
  clientUpdatedAt: number;
  stages: Record<string, unknown>;
}

export interface DirectorCloudProjectRecord {
  snapshot: DirectorCloudSnapshot;
  serverUpdatedAt: number;
}

export interface DirectorCloudRestoreBundle {
  project: Record<string, unknown>;
  episode: Record<string, unknown>;
  shots: Array<Record<string, unknown>>;
  stages: Record<string, unknown>;
  assets: Array<Record<string, unknown>>;
  productionStatus: Record<string, unknown>;
  serverUpdatedAt: number;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

export function buildDirectorShotDocuments(snapshot: DirectorCloudSnapshot) {
  const stages = snapshot.stages || {};
  const storyboard = asObject(stages.storyboard);
  const blueprint = asObject(stages.keyframeBlueprint);
  const assets = asObject(stages.keyframeAssets);
  const qa = asObject(stages.keyframeQa);
  const video = asObject(stages.videoBlueprint);
  const cloudAssets = asObject(stages.keyframeCloudAssets);

  const storyboardShots = Array.isArray(storyboard?.shots) ? storyboard!.shots : [];
  const blueprintItems = Array.isArray(blueprint?.blueprints) ? blueprint!.blueprints : [];
  const assetItems = Array.isArray(assets?.assets) ? assets!.assets : [];
  const qaItems = Array.isArray(qa?.items) ? qa!.items : [];
  const videoItems = Array.isArray(video?.items) ? video!.items : [];
  const cloudItems = Array.isArray(cloudAssets?.items) ? cloudAssets!.items : [];

  const byShot = new Map<string, Record<string, unknown>>();
  const ensure = (shotUid: string) => {
    if (!byShot.has(shotUid)) byShot.set(shotUid, { shotUid });
    return byShot.get(shotUid)!;
  };

  storyboardShots.forEach((shot: any, index: number) => {
    const shotUid = clean(shot?.uid);
    if (!shotUid) return;
    Object.assign(ensure(shotUid), { order: index + 1, storyboard: jsonSafe(shot) });
  });
  blueprintItems.forEach((item: any) => {
    const shotUid = clean(item?.shotUid);
    if (shotUid) ensure(shotUid).keyframeBlueprint = jsonSafe(item);
  });
  assetItems.forEach((item: any) => {
    const shotUid = clean(item?.shotUid);
    if (shotUid) ensure(shotUid).keyframeAsset = jsonSafe(item);
  });
  qaItems.forEach((item: any) => {
    const shotUid = clean(item?.shotUid);
    if (shotUid) ensure(shotUid).keyframeQa = jsonSafe(item);
  });
  videoItems.forEach((item: any) => {
    const shotUid = clean(item?.shotUid);
    if (shotUid) ensure(shotUid).videoBlueprint = jsonSafe(item);
  });
  cloudItems.forEach((item: any) => {
    const shotUid = clean(item?.shotUid);
    if (shotUid) ensure(shotUid).keyframeCloudAsset = jsonSafe(item);
  });

  return [...byShot.values()].sort((left, right) => Number(left.order || 999) - Number(right.order || 999));
}

class FirestoreDirectorProjectRepository {
  isAvailable(): boolean {
    return Boolean(getFirestoreInstance());
  }

  async upsertSnapshot(snapshotInput: DirectorCloudSnapshot): Promise<DirectorCloudProjectRecord> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_FIRESTORE_UNAVAILABLE');

    const snapshot = jsonSafe(snapshotInput);
    const projectId = clean(snapshot.projectId);
    const episodeId = clean(snapshot.episodeId);
    if (!projectId || !episodeId) throw new Error('DIRECTOR_PROJECT_EPISODE_ID_REQUIRED');
    if (snapshot.schema !== DIRECTOR_CLOUD_SCHEMA) throw new Error('DIRECTOR_CLOUD_SCHEMA_INVALID');

    const now = Date.now();
    try {
      const projectRef = db.collection(DIRECTOR_PROJECT_COLLECTION).doc(projectId);
      const episodeRef = projectRef.collection('episodes').doc(episodeId);
      const batch = db.batch();

      batch.set(projectRef, {
        schema: DIRECTOR_CLOUD_SCHEMA,
        projectId,
        seriesTitle: clean(snapshot.seriesTitle),
        projectTitle: clean(snapshot.projectTitle),
        activeEpisodeId: episodeId,
        latestClientUpdatedAt: Number(snapshot.clientUpdatedAt || 0),
        updatedAt: now,
      }, { merge: true });

      batch.set(episodeRef, {
        schema: DIRECTOR_CLOUD_SCHEMA,
        projectId,
        episodeId,
        seriesTitle: clean(snapshot.seriesTitle),
        projectTitle: clean(snapshot.projectTitle),
        clientUpdatedAt: Number(snapshot.clientUpdatedAt || 0),
        snapshot,
        updatedAt: now,
      }, { merge: true });

      for (const [stageKey, stageValue] of Object.entries(snapshot.stages || {})) {
        if (!stageKey || stageValue === undefined) continue;
        batch.set(episodeRef.collection('stages').doc(stageKey), {
          stageKey,
          payload: jsonSafe(stageValue),
          clientUpdatedAt: Number(snapshot.clientUpdatedAt || 0),
          updatedAt: now,
        }, { merge: true });
      }

      for (const shot of buildDirectorShotDocuments(snapshot)) {
        const shotUid = clean(shot.shotUid);
        if (!shotUid) continue;
        batch.set(episodeRef.collection('shots').doc(shotUid), {
          ...jsonSafe(shot),
          projectId,
          episodeId,
          updatedAt: now,
        }, { merge: true });
      }

      await batch.commit();
      return { snapshot, serverUpdatedAt: now };
    } catch (error) {
      markFirestoreUnavailable(error);
      throw error;
    }
  }

  async getSnapshot(projectIdInput: string, episodeIdInput?: string): Promise<DirectorCloudProjectRecord | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_FIRESTORE_UNAVAILABLE');
    const projectId = clean(projectIdInput);
    if (!projectId) throw new Error('DIRECTOR_PROJECT_ID_REQUIRED');

    try {
      const projectRef = db.collection(DIRECTOR_PROJECT_COLLECTION).doc(projectId);
      const projectDoc = await projectRef.get();
      if (!projectDoc.exists) return null;
      const projectData = projectDoc.data() || {};
      const episodeId = clean(episodeIdInput) || clean(projectData.activeEpisodeId);
      if (!episodeId) return null;
      const episodeDoc = await projectRef.collection('episodes').doc(episodeId).get();
      if (!episodeDoc.exists) return null;
      const episodeData = episodeDoc.data() || {};
      const snapshot = episodeData.snapshot as DirectorCloudSnapshot | undefined;
      if (!snapshot || snapshot.schema !== DIRECTOR_CLOUD_SCHEMA) return null;
      return {
        snapshot: jsonSafe(snapshot),
        serverUpdatedAt: Number(episodeData.updatedAt || projectData.updatedAt || 0),
      };
    } catch (error) {
      markFirestoreUnavailable(error);
      throw error;
    }
  }

  async getRestoreBundle(projectIdInput: string, episodeIdInput?: string): Promise<DirectorCloudRestoreBundle | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_FIRESTORE_UNAVAILABLE');
    const projectId = clean(projectIdInput);
    if (!projectId) throw new Error('DIRECTOR_PROJECT_ID_REQUIRED');

    try {
      const projectRef = db.collection(DIRECTOR_PROJECT_COLLECTION).doc(projectId);
      const projectDoc = await projectRef.get();
      if (!projectDoc.exists) return null;

      const projectData = projectDoc.data() || {};
      const episodeId = clean(episodeIdInput) || clean(projectData.activeEpisodeId);
      if (!episodeId) return null;

      const episodeRef = projectRef.collection('episodes').doc(episodeId);
      const episodeDoc = await episodeRef.get();
      if (!episodeDoc.exists) return null;

      const episodeData = episodeDoc.data() || {};
      const storedSnapshot = episodeData.snapshot as DirectorCloudSnapshot | undefined;
      if (!storedSnapshot || storedSnapshot.schema !== DIRECTOR_CLOUD_SCHEMA) return null;

      const [stageQuery, shotQuery] = await Promise.all([
        episodeRef.collection('stages').get(),
        episodeRef.collection('shots').get(),
      ]);

      const stages: Record<string, unknown> = {
        ...jsonSafe(storedSnapshot.stages || {}),
      };
      for (const stageDoc of stageQuery.docs) {
        const data = stageDoc.data() || {};
        if (data.payload !== undefined) stages[stageDoc.id] = jsonSafe(data.payload);
      }

      const snapshotForShots: DirectorCloudSnapshot = {
        ...jsonSafe(storedSnapshot),
        stages,
      };
      const persistedShots = shotQuery.docs
        .map((shotDoc) => jsonSafe(shotDoc.data() || {}))
        .filter((shot) => clean(shot.shotUid));
      const snapshotShots = buildDirectorShotDocuments(snapshotForShots);
      // The episode snapshot is the current ordered Shot List. Per-shot documents
      // are still read and remain the fallback for older records that predate the
      // snapshot projection.
      const shots = (snapshotShots.length > 0 ? snapshotShots : persistedShots)
        .sort((left, right) => Number(left.order || 999) - Number(right.order || 999));

      const assetStage = asObject(stages.keyframeAssets);
      const cloudAssetStage = asObject(stages.keyframeCloudAssets);
      const manifestAssets = Array.isArray(assetStage?.assets) ? assetStage.assets : [];
      const cloudAssets = Array.isArray(cloudAssetStage?.items) ? cloudAssetStage.items : [];
      const cloudByShot = new Map(
        cloudAssets
          .filter((asset: any) => clean(asset?.shotUid))
          .map((asset: any) => [clean(asset.shotUid), jsonSafe(asset)]),
      );
      const assets = manifestAssets.map((asset: any) => ({
        ...jsonSafe(asset),
        cloudRef: cloudByShot.get(clean(asset?.shotUid)) || null,
      }));
      const knownAssetShots = new Set(assets.map((asset) => clean(asset.shotUid)));
      for (const cloudAsset of cloudAssets) {
        if (!knownAssetShots.has(clean((cloudAsset as any)?.shotUid))) {
          assets.push({ cloudRef: jsonSafe(cloudAsset) });
        }
      }

      const shotStatuses = shots.map((shot: any) => ({
        shotUid: clean(shot.shotUid),
        order: Number(shot.order || 0),
        keyframeStatus: clean(shot.keyframeAsset?.status) || 'EMPTY',
        keyframeQaStatus: clean(shot.keyframeQa?.autoStatus || shot.keyframeQa?.status) || 'NOT_REVIEWED',
        videoBlueprintStatus: clean(shot.videoBlueprint?.status) || 'NOT_STARTED',
      }));

      return {
        project: {
          projectId,
          seriesTitle: clean(projectData.seriesTitle || storedSnapshot.seriesTitle),
          projectTitle: clean(projectData.projectTitle || storedSnapshot.projectTitle),
          activeEpisodeId: episodeId,
          createdAt: Number(projectData.createdAt || 0),
          updatedAt: Number(projectData.updatedAt || episodeData.updatedAt || 0),
        },
        episode: {
          projectId,
          episodeId,
          seriesTitle: clean(episodeData.seriesTitle || storedSnapshot.seriesTitle),
          projectTitle: clean(episodeData.projectTitle || storedSnapshot.projectTitle),
          status: clean(episodeData.status) || 'DRAFT',
          clientUpdatedAt: Number(episodeData.clientUpdatedAt || storedSnapshot.clientUpdatedAt || 0),
          updatedAt: Number(episodeData.updatedAt || projectData.updatedAt || 0),
        },
        shots,
        stages,
        assets,
        productionStatus: {
          episodeStatus: clean(episodeData.status) || 'DRAFT',
          shotCount: shots.length,
          keyframeAssetCount: assets.length,
          keyframePassCount: assets.filter((asset: any) => asset.status === 'PASS').length,
          videoBlueprintPassCount: shots.filter((shot: any) => shot.videoBlueprint?.status === 'PASS').length,
          shots: shotStatuses,
        },
        serverUpdatedAt: Number(episodeData.updatedAt || projectData.updatedAt || 0),
      };
    } catch (error) {
      markFirestoreUnavailable(error);
      throw error;
    }
  }

  async getLatestSnapshot(): Promise<DirectorCloudProjectRecord | null> {
    const db = getFirestoreInstance();
    if (!db) throw new Error('DIRECTOR_FIRESTORE_UNAVAILABLE');

    try {
      const query = await db.collection(DIRECTOR_PROJECT_COLLECTION)
        .orderBy('updatedAt', 'desc')
        .limit(1)
        .get();
      const first = query.docs[0];
      if (!first) return null;
      return this.getSnapshot(first.id, clean(first.data()?.activeEpisodeId));
    } catch (error) {
      markFirestoreUnavailable(error);
      throw error;
    }
  }
}

export const firestoreDirectorProjectRepository = new FirestoreDirectorProjectRepository();

import type { GeneratedStoryboardShot } from './localStoryboardGenerator';

export type ShotInsertPosition = 'before' | 'after';

export function insertStoryboardShot(
  shots: GeneratedStoryboardShot[],
  anchorUid: string,
  position: ShotInsertPosition,
  newShot: GeneratedStoryboardShot,
): GeneratedStoryboardShot[] {
  const anchorIndex = shots.findIndex((shot) => shot.uid === anchorUid);
  if (anchorIndex < 0) return [...shots, newShot];

  const insertIndex = position === 'before' ? anchorIndex : anchorIndex + 1;
  const next = [...shots];
  next.splice(insertIndex, 0, newShot);
  return next;
}

export function moveStoryboardShotToOrder(
  shots: GeneratedStoryboardShot[],
  uid: string,
  requestedOrder: number,
): GeneratedStoryboardShot[] {
  if (shots.length <= 1) return [...shots];

  const sourceIndex = shots.findIndex((shot) => shot.uid === uid);
  if (sourceIndex < 0) return [...shots];

  const normalizedOrder = Number.isFinite(requestedOrder)
    ? Math.round(requestedOrder)
    : sourceIndex + 1;
  const targetIndex = Math.max(0, Math.min(shots.length - 1, normalizedOrder - 1));
  if (sourceIndex === targetIndex) return [...shots];

  const next = [...shots];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function moveStoryboardShotBy(
  shots: GeneratedStoryboardShot[],
  uid: string,
  delta: -1 | 1,
): GeneratedStoryboardShot[] {
  const currentIndex = shots.findIndex((shot) => shot.uid === uid);
  if (currentIndex < 0) return [...shots];
  return moveStoryboardShotToOrder(shots, uid, currentIndex + 1 + delta);
}

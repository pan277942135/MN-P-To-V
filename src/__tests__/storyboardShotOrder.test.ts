import { describe, expect, it } from 'vitest';
import type { GeneratedStoryboardShot } from '../services/director/localStoryboardGenerator';
import {
  insertStoryboardShot,
  moveStoryboardShotBy,
  moveStoryboardShotToOrder,
} from '../services/director/storyboardShotOrder';

function shot(uid: string): GeneratedStoryboardShot {
  return {
    uid,
    title: uid,
    durationSeconds: 4,
    scene: '教室',
    action: uid,
    camera: '中景',
    dialogue: '',
    notes: '',
  };
}

describe('storyboardShotOrder', () => {
  it('inserts before/after without changing existing stable uids', () => {
    const base = [shot('a'), shot('b'), shot('c')];
    const before = insertStoryboardShot(base, 'b', 'before', shot('x'));
    expect(before.map((item) => item.uid)).toEqual(['a', 'x', 'b', 'c']);
    const after = insertStoryboardShot(base, 'b', 'after', shot('y'));
    expect(after.map((item) => item.uid)).toEqual(['a', 'b', 'y', 'c']);
    expect(base.map((item) => item.uid)).toEqual(['a', 'b', 'c']);
  });

  it('moves by explicit 1-based order and clamps out-of-range values', () => {
    const base = [shot('a'), shot('b'), shot('c')];
    expect(moveStoryboardShotToOrder(base, 'c', 1).map((item) => item.uid)).toEqual(['c', 'a', 'b']);
    expect(moveStoryboardShotToOrder(base, 'a', 99).map((item) => item.uid)).toEqual(['b', 'c', 'a']);
    expect(moveStoryboardShotBy(base, 'b', -1).map((item) => item.uid)).toEqual(['b', 'a', 'c']);
  });
});

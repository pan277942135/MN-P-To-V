import { afterEach, describe, expect, it } from 'vitest';
import {
  isFirestoreAvailable,
  markFirestoreUnavailable,
  setFirestoreInstanceForTesting,
} from '../server/db/firestore';

describe('Firestore runtime availability boundary', () => {
  afterEach(() => {
    setFirestoreInstanceForTesting(null);
  });

  it('does not globally disable Firestore for an invalid document ID', () => {
    setFirestoreInstanceForTesting({} as any);

    markFirestoreUnavailable(Object.assign(
      new Error('3 INVALID_ARGUMENT: Resource id "__step_4_0_3_c_missing__" is invalid because it is reserved.'),
      { code: 3 },
    ));

    expect(isFirestoreAvailable()).toBe(true);
  });

  it('still fails closed for permission errors', () => {
    setFirestoreInstanceForTesting({} as any);

    markFirestoreUnavailable(Object.assign(new Error('7 PERMISSION_DENIED: Access denied'), { code: 7 }));

    expect(isFirestoreAvailable()).toBe(false);
  });
});

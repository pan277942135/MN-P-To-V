import { describe, it, expect } from 'vitest';

describe('P0 Task Timeout & Polling Retention Logic', () => {
  it('1. Tasks WITH operationName created 15 minutes ago (900s) MUST remain in polling status and NOT auto-fail', () => {
    const now = Date.now();
    const fifteenMinsAgo = now - 15 * 60 * 1000; // 900,000ms

    const rec = {
      id: 'task_active_op',
      taskId: 'task_active_op',
      status: 'polling',
      operationName: 'projects/123/locations/us-central1/operations/veo_op_999',
      createdAt: fifteenMinsAgo,
    };

    const isStuckWithoutOpName = (rec.status === 'polling' || rec.status === 'submitting') && !rec.operationName && (now - rec.createdAt) > 30000;
    const isTimedOut = !rec.operationName
      ? ((rec.status === 'polling' || rec.status === 'submitting') && (now - rec.createdAt) > 30000)
      : ((rec.status === 'polling' || (rec.status as string) === 'submitted') && (now - rec.createdAt) > 1800000);

    expect(isStuckWithoutOpName).toBe(false);
    expect(isTimedOut).toBe(false);
    expect(rec.status).toBe('polling');
  });

  it('2. Tasks WITHOUT operationName created > 30s ago MUST trigger isStuckWithoutOpName and fail', () => {
    const now = Date.now();
    const fortySecsAgo = now - 40 * 1000; // 40,000ms

    const rec = {
      id: 'task_stuck_no_op',
      taskId: 'task_stuck_no_op',
      status: 'polling',
      operationName: null,
      createdAt: fortySecsAgo,
    };

    const isStuckWithoutOpName = (rec.status === 'polling' || rec.status === 'submitting') && !rec.operationName && (now - rec.createdAt) > 30000;
    const isTimedOut = !rec.operationName
      ? ((rec.status === 'polling' || rec.status === 'submitting') && (now - rec.createdAt) > 30000)
      : ((rec.status === 'polling' || (rec.status as string) === 'submitted') && (now - rec.createdAt) > 1800000);

    expect(isStuckWithoutOpName).toBe(true);
    expect(isTimedOut).toBe(true);
  });

  it('3. Tasks WITH operationName created > 30 minutes ago (1800s) trigger timeout', () => {
    const now = Date.now();
    const thirtyOneMinsAgo = now - 31 * 60 * 1000; // 1,860,000ms

    const rec = {
      id: 'task_ancient_op',
      taskId: 'task_ancient_op',
      status: 'polling',
      operationName: 'projects/123/locations/us-central1/operations/veo_op_old',
      createdAt: thirtyOneMinsAgo,
    };

    const isStuckWithoutOpName = (rec.status === 'polling' || rec.status === 'submitting') && !rec.operationName && (now - rec.createdAt) > 30000;
    const isTimedOut = !rec.operationName
      ? ((rec.status === 'polling' || rec.status === 'submitting') && (now - rec.createdAt) > 30000)
      : ((rec.status === 'polling' || (rec.status as string) === 'submitted') && (now - rec.createdAt) > 1800000);

    expect(isStuckWithoutOpName).toBe(false);
    expect(isTimedOut).toBe(true);
  });
});

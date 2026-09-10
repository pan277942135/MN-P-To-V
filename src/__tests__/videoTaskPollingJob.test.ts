import { describe, expect, it, vi } from 'vitest';
import { VideoTaskPollingJob } from '../server/services/videoTaskPollingJob';

describe('VideoTaskPollingJob', () => {
  it('runs polling attempts in the background until completion', async () => {
    const attempts: number[] = [];
    const logger = { log: vi.fn(), error: vi.fn() };
    const job = new VideoTaskPollingJob({
      intervalMs: 0,
      sleep: async () => undefined,
      logger,
    });

    const queued = job.enqueue(
      {
        taskId: 'vtask_test',
        operationName: 'projects/test/locations/us-central1/operations/123',
      },
      async ({ pollAttempt }) => {
        attempts.push(pollAttempt);
        return pollAttempt === 1 ? { state: 'RUNNING' } : { state: 'SUCCESS' };
      }
    );

    expect(queued).toBe(true);

    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }

    expect(attempts).toEqual([1, 2]);
    expect(job.isActive('vtask_test')).toBe(false);
    expect(logger.log).toHaveBeenCalledWith(
      '[VEO_POLL_STARTED]',
      expect.stringContaining('"pollAttempt":1')
    );
    expect(logger.log).toHaveBeenCalledWith(
      '[VEO_COMPLETED]',
      expect.stringContaining('"pollAttempt":2')
    );
  });

  it('does not enqueue a duplicate job for the same task', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = new VideoTaskPollingJob({
      intervalMs: 0,
      sleep: async () => undefined,
    });

    const first = job.enqueue(
      { taskId: 'vtask_duplicate', operationName: 'operations/1' },
      async () => {
        await blocked;
        return { state: 'SUCCESS' };
      }
    );
    const second = job.enqueue(
      { taskId: 'vtask_duplicate', operationName: 'operations/1' },
      async () => ({ state: 'SUCCESS' })
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    release();

    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(job.isActive('vtask_duplicate')).toBe(false);
  });
});

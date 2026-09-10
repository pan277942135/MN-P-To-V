import crypto from 'crypto';

export type VideoTaskPollingState = 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface VideoTaskPollingContext {
  taskId: string;
  operationName: string;
  pollAttempt: number;
}

export interface VideoTaskPollingResult {
  state: VideoTaskPollingState;
  error?: string;
}

export type VideoTaskPollingExecutor = (
  context: VideoTaskPollingContext
) => Promise<VideoTaskPollingResult>;

export interface VideoTaskPollingJobOptions {
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'error'>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VideoTaskPollingJob {
  private readonly activeTaskIds = new Set<string>();
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Console, 'log' | 'error'>;

  constructor(options: VideoTaskPollingJobOptions = {}) {
    this.intervalMs = options.intervalMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 72;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? console;
  }

  enqueue(
    context: Omit<VideoTaskPollingContext, 'pollAttempt'> & { initialPollAttempt?: number },
    executor: VideoTaskPollingExecutor
  ): boolean {
    if (this.activeTaskIds.has(context.taskId)) {
      this.logger.log(
        '[VEO_POLL_ALREADY_ACTIVE]',
        JSON.stringify({ taskId: context.taskId, operationName: context.operationName })
      );
      return false;
    }

    this.activeTaskIds.add(context.taskId);
    this.logger.log(
      '[VEO_POLL_ENQUEUED]',
      JSON.stringify({
        taskId: context.taskId,
        operationName: context.operationName,
        initialPollAttempt: context.initialPollAttempt ?? 0,
      })
    );

    void this.run(context, executor).catch((error) => {
      this.logger.error(
        '[VEO_FAILED]',
        JSON.stringify({
          taskId: context.taskId,
          operationName: context.operationName,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    });

    return true;
  }

  isActive(taskId: string): boolean {
    return this.activeTaskIds.has(taskId);
  }

  activeTaskCount(): number {
    return this.activeTaskIds.size;
  }

  private async run(
    context: Omit<VideoTaskPollingContext, 'pollAttempt'> & { initialPollAttempt?: number },
    executor: VideoTaskPollingExecutor
  ): Promise<void> {
    const workerId = `poll_${crypto.randomUUID()}`;
    const initialAttempt = Math.max(0, context.initialPollAttempt ?? 0);

    try {
      for (let pollAttempt = initialAttempt + 1; pollAttempt <= this.maxAttempts; pollAttempt++) {
        await this.sleep(this.intervalMs);

        this.logger.log(
          '[VEO_POLL_STARTED]',
          JSON.stringify({
            taskId: context.taskId,
            operationName: context.operationName,
            pollAttempt,
            workerId,
          })
        );

        try {
          const result = await executor({
            taskId: context.taskId,
            operationName: context.operationName,
            pollAttempt,
          });

          if (result.state === 'RUNNING') {
            this.logger.log(
              '[VEO_POLL_STATUS]',
              JSON.stringify({
                taskId: context.taskId,
                operationName: context.operationName,
                state: 'RUNNING',
                pollAttempt,
                workerId,
              })
            );
            continue;
          }

          if (result.state === 'SUCCESS') {
            this.logger.log(
              '[VEO_COMPLETED]',
              JSON.stringify({
                taskId: context.taskId,
                operationName: context.operationName,
                pollAttempt,
                workerId,
              })
            );
          } else {
            this.logger.error(
              '[VEO_FAILED]',
              JSON.stringify({
                taskId: context.taskId,
                operationName: context.operationName,
                pollAttempt,
                workerId,
                error: result.error || 'polling executor returned FAILED',
              })
            );
          }
          return;
        } catch (error) {
          this.logger.error(
            '[VEO_FAILED]',
            JSON.stringify({
              taskId: context.taskId,
              operationName: context.operationName,
              pollAttempt,
              workerId,
              error: error instanceof Error ? error.message : String(error),
            })
          );
          return;
        }
      }

      this.logger.error(
        '[VEO_FAILED]',
        JSON.stringify({
          taskId: context.taskId,
          operationName: context.operationName,
          error: `polling timeout after ${this.maxAttempts} attempts`,
          workerId,
        })
      );
    } finally {
      this.activeTaskIds.delete(context.taskId);
    }
  }
}

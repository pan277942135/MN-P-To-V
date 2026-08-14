import { describe, expect, it } from 'vitest';
import { evaluateProviderOperationLinkage } from '../server/services/providerOperationRecoveryPolicy';

const expected = 'gs://ai-studio-bucket-89614354864-asia-south1/veo/task_123/';

describe('provider operation recovery linkage policy', () => {
  it('accepts only a completed operation whose output is under the exact task storage prefix', () => {
    expect(evaluateProviderOperationLinkage({
      taskId: 'task_123',
      operationDone: true,
      videoUri: `${expected}1700000000000/sample_0.mp4`,
      expectedStoragePrefix: expected,
    })).toEqual({ proven: true, reason: 'task_linked_output' });
  });

  it('keeps a still-running operation fail-closed even when the operation itself is valid', () => {
    expect(evaluateProviderOperationLinkage({
      taskId: 'task_123',
      operationDone: false,
      expectedStoragePrefix: expected,
    })).toEqual({ proven: false, reason: 'operation_still_running' });
  });

  it('does not accept a completed operation without task-linked output evidence', () => {
    expect(evaluateProviderOperationLinkage({
      taskId: 'task_123',
      operationDone: true,
      videoUri: null,
      expectedStoragePrefix: expected,
    })).toEqual({ proven: false, reason: 'output_missing' });
  });

  it('rejects another valid operation whose output belongs to a different task', () => {
    expect(evaluateProviderOperationLinkage({
      taskId: 'task_123',
      operationDone: true,
      videoUri: 'gs://ai-studio-bucket-89614354864-asia-south1/veo/task_OTHER/1700000000000/sample_0.mp4',
      expectedStoragePrefix: expected,
    })).toEqual({ proven: false, reason: 'output_task_mismatch' });
  });
});

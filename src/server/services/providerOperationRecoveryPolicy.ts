export interface ProviderOperationLinkageInput {
  taskId: string;
  operationDone: boolean;
  videoUri?: string | null;
  expectedStoragePrefix: string;
}

export interface ProviderOperationLinkageResult {
  proven: boolean;
  reason: 'task_linked_output' | 'operation_still_running' | 'output_missing' | 'output_task_mismatch';
}

/**
 * Merely proving that an operation exists is insufficient: a user could accidentally
 * provide another valid operation from the same project and thereby release the wrong
 * unknown task. Zaojing submits every Vertex Veo task with a task-specific storageUri
 * (`.../veo/<taskId>/`). We therefore release the fail-closed slot only when the
 * completed provider operation returns a video URI under that exact durable prefix.
 */
export function evaluateProviderOperationLinkage(
  input: ProviderOperationLinkageInput
): ProviderOperationLinkageResult {
  if (!input.operationDone) {
    return { proven: false, reason: 'operation_still_running' };
  }

  const videoUri = String(input.videoUri || '').trim();
  if (!videoUri) {
    return { proven: false, reason: 'output_missing' };
  }

  const prefix = String(input.expectedStoragePrefix || '').trim();
  if (!prefix || !videoUri.startsWith(prefix)) {
    return { proven: false, reason: 'output_task_mismatch' };
  }

  return { proven: true, reason: 'task_linked_output' };
}

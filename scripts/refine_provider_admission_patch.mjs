import fs from 'node:fs';

const file = 'src/server/repositories/firestoreTaskRepository.ts';
let source = fs.readFileSync(file, 'utf8');

const before = `        const admissionSnap = await transaction.get(admissionRef);
        const admissionData = admissionSnap.exists ? (admissionSnap.data() as any) : null;
        const incumbentTaskId = String(admissionData?.taskId || '');

        if (incumbentTaskId && incumbentTaskId !== taskId) {
          const incumbentRef = db.collection(this.collectionName).doc(incumbentTaskId);
          const incumbentSnap = await transaction.get(incumbentRef);
          if (incumbentSnap.exists) {
            const incumbentTask = {
              ...(incumbentSnap.data() as ServerVideoTaskRecord),
              taskId: (incumbentSnap.data() as ServerVideoTaskRecord).taskId || incumbentTaskId,
              evidenceSource: 'firestore' as const,
            } as ServerVideoTaskRecord;
            if (isProviderAdmissionBlockingTask(incumbentTask)) {
              throw new ProviderAdmissionBusyError({
                blockingTaskId: incumbentTask.taskId || incumbentTaskId,
                blockingStatus: incumbentTask.status,
                scopeKey,
              });
            }
          }
        }

        transaction.set(docRef, payload);
        transaction.set(admissionRef, sanitizeForFirestore({
          scopeKey,
          taskId,
          projectId: record.projectId || '',
          acquiredAt: now,
          updatedAt: now,
          authority: 'firestore',
        }));`;

const after = `        const incomingNeedsProviderAdmission = isProviderAdmissionBlockingTask(record);
        if (incomingNeedsProviderAdmission) {
          const admissionSnap = await transaction.get(admissionRef);
          const admissionData = admissionSnap.exists ? (admissionSnap.data() as any) : null;
          const incumbentTaskId = String(admissionData?.taskId || '');

          if (incumbentTaskId && incumbentTaskId !== taskId) {
            const incumbentRef = db.collection(this.collectionName).doc(incumbentTaskId);
            const incumbentSnap = await transaction.get(incumbentRef);
            if (incumbentSnap.exists) {
              const incumbentTask = {
                ...(incumbentSnap.data() as ServerVideoTaskRecord),
                taskId: (incumbentSnap.data() as ServerVideoTaskRecord).taskId || incumbentTaskId,
                evidenceSource: 'firestore' as const,
              } as ServerVideoTaskRecord;
              if (isProviderAdmissionBlockingTask(incumbentTask)) {
                throw new ProviderAdmissionBusyError({
                  blockingTaskId: incumbentTask.taskId || incumbentTaskId,
                  blockingStatus: incumbentTask.status,
                  scopeKey,
                });
              }
            }
          }
        }

        transaction.set(docRef, payload);
        if (incomingNeedsProviderAdmission) {
          transaction.set(admissionRef, sanitizeForFirestore({
            scopeKey,
            taskId,
            projectId: record.projectId || '',
            acquiredAt: now,
            updatedAt: now,
            authority: 'firestore',
          }));
        }`;

if (source.includes(after)) {
  console.log('[provider-admission-refine] already applied');
} else if (source.includes(before)) {
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
  console.log('[provider-admission-refine] applied');
} else {
  throw new Error('[provider-admission-refine] expected generated createTask block not found');
}

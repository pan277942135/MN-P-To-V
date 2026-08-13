from pathlib import Path

path = Path('server.ts')
src = path.read_text(encoding='utf-8')

recover_start = src.find('  // Recover Video Artifact Endpoint (Does NOT resubmit Veo generation)')
stream_marker = '  // Physical Video Streaming & Download Endpoint'
recover_end = src.find(stream_marker, recover_start)
if recover_start < 0 or recover_end < 0:
    raise RuntimeError('recover route markers not found')

recover_route = '''  // Recover Video Artifact Endpoint (Does NOT resubmit Veo generation)
  app.post('/api/videos/recover/:taskId', async (req, res) => {
    const { taskId } = req.params;
    console.log(`[Video Recover] Requesting artifact recovery for task ${taskId}...`);
    try {
      if (!firestoreTaskRepository.isAvailable()) {
        return res.status(503).json({
          success: false,
          storageAuthority: 'unavailable',
          error: 'Firestore unavailable; artifact recovery cannot proceed safely.',
        });
      }

      const rec = await firestoreTaskRepository.getTask(taskId);
      if (!rec) {
        return res.status(404).json({ error: '任务不存在，无法恢复视频产物', storageAuthority: 'firestore' });
      }

      // A completed task is allowed to stream only its authoritative owned GCS artifact.
      // If that object vanished, do not silently repair a ghost-completed task from an
      // external URI or stale process state; surface the integrity failure explicitly.
      if (rec.status === 'completed') {
        if (!rec.outputBucket || !rec.outputObjectPath || rec.artifactPersisted !== true) {
          return res.status(409).json({
            error: 'completed_invariant_violation',
            storageAuthority: 'firestore',
          });
        }
        const existing = await gcsArtifactStore.checkArtifactExists(rec.outputBucket, rec.outputObjectPath);
        if (!existing.exists || (existing.sizeBytes || 0) <= 0) {
          return res.status(404).json({
            error: 'artifact_not_found',
            storageAuthority: 'gcs',
            outputBucket: rec.outputBucket,
            outputObjectPath: rec.outputObjectPath,
          });
        }
        return res.json({
          success: true,
          status: 'completed',
          message: '视频产物已在 Cloud Storage 中确认就绪',
          videoDataUrl: `/api/videos/stream/${taskId}`,
          storageAuthority: 'gcs',
        });
      }

      // 1. Reconcile an already-owned GCS object without resubmitting the provider.
      if (rec.outputBucket && rec.outputObjectPath) {
        const existing = await gcsArtifactStore.checkArtifactExists(rec.outputBucket, rec.outputObjectPath);
        if (existing.exists && (existing.sizeBytes || rec.sizeBytes || 0) > 0) {
          const completedTask = await taskStateMachineService.completeWithPersistedArtifact({
            taskId,
            outputBucket: rec.outputBucket,
            outputObjectPath: rec.outputObjectPath,
            videoUri: rec.videoUri || `gs://${rec.outputBucket}/${rec.outputObjectPath}`,
            sizeBytes: existing.sizeBytes || rec.sizeBytes,
            contentType: rec.contentType || 'video/mp4',
            artifactPersistedAt: rec.artifactPersistedAt || Date.now(),
          });
          serverVideoTaskStore.set(taskId, completedTask);
          return res.json({
            success: true,
            status: 'completed',
            message: '已根据现有 Cloud Storage 产物完成任务状态对账',
            videoDataUrl: `/api/videos/stream/${taskId}`,
            storageAuthority: 'gcs',
          });
        }
      }

      // 2. Migrate a provider URI into owned GCS. CredentialService.getSession can
      // reconstruct an ADC-backed Vertex session after a Cloud Run process restart.
      if (rec.videoUri && !rec.videoUri.startsWith('gs://')) {
        const session = CredentialService.getSession(rec.connectionId) || CredentialService.getSession();
        let accessToken: string | undefined;
        if (session?.type === 'vertex_ai') {
          accessToken = await VertexClient.getAccessToken(session);
        }
        const apiKey = session?.apiKey || process.env.GEMINI_API_KEY;
        const artifactMeta = await gcsArtifactStore.migrateArtifactToGcs({
          taskId,
          videoUri: rec.videoUri,
          accessToken,
          apiKey,
        });
        const completedTask = await taskStateMachineService.completeWithPersistedArtifact({
          taskId,
          outputBucket: artifactMeta.outputBucket,
          outputObjectPath: artifactMeta.outputObjectPath,
          videoUri: artifactMeta.videoUri,
          sizeBytes: artifactMeta.sizeBytes,
          contentType: artifactMeta.contentType,
          artifactPersistedAt: artifactMeta.artifactPersistedAt,
        });
        serverVideoTaskStore.set(taskId, completedTask);
        return res.json({
          success: true,
          status: 'completed',
          message: '已成功从 Provider Uri 迁移视频产物至 Cloud Storage',
          videoDataUrl: `/api/videos/stream/${taskId}`,
          storageAuthority: 'gcs',
        });
      }

      // 3. Resume a durable provider operation and migrate its result. No new generation
      // is created here; this only polls the operationName already stored in Firestore.
      if (rec.operationName) {
        const session = CredentialService.getSession(rec.connectionId) || CredentialService.getSession();
        if (!session || session.type !== 'vertex_ai') {
          return res.status(503).json({
            error: 'provider_session_unavailable',
            storageAuthority: 'firestore',
          });
        }
        const pollRes = await VertexClient.pollOperation(session, rec.operationName);
        if (!pollRes.done) {
          return res.status(202).json({
            success: true,
            status: rec.status,
            operationName: rec.operationName,
            message: 'Provider operation is still running; no resubmission was performed.',
          });
        }
        if (pollRes.error) {
          return res.status(502).json({ error: pollRes.error, status: 'failed' });
        }
        const extracted = pollRes.response ? VideoGenerator.extractVideoData(pollRes.response) : {} as any;
        if (extracted.uri) {
          const accessToken = await VertexClient.getAccessToken(session);
          const artifactMeta = await gcsArtifactStore.migrateArtifactToGcs({
            taskId,
            videoUri: extracted.uri,
            accessToken,
            apiKey: session.apiKey || process.env.GEMINI_API_KEY,
          });
          const completedTask = await taskStateMachineService.completeWithPersistedArtifact({
            taskId,
            outputBucket: artifactMeta.outputBucket,
            outputObjectPath: artifactMeta.outputObjectPath,
            videoUri: artifactMeta.videoUri,
            sizeBytes: artifactMeta.sizeBytes,
            contentType: artifactMeta.contentType,
            artifactPersistedAt: artifactMeta.artifactPersistedAt,
          });
          serverVideoTaskStore.set(taskId, completedTask);
          return res.json({
            success: true,
            status: 'completed',
            message: '已从 durable Veo Operation 恢复并持久化视频产物至 Cloud Storage',
            videoDataUrl: `/api/videos/stream/${taskId}`,
            storageAuthority: 'gcs',
          });
        }
      }

      return res.status(400).json({
        error: '当前任务不存在可恢复的 GCS 产物、Provider URI 或 durable OperationName。',
        storageAuthority: 'firestore',
      });
    } catch (err: any) {
      console.error(`[Video Recover Error] Task ${taskId}:`, err);
      return res.status(500).json({
        error: `恢复视频产物失败: ${err?.message || err}`,
        storageAuthority: 'firestore',
      });
    }
  });

'''
src = src[:recover_start] + recover_route + src[recover_end:]

# Replace the whole stream endpoint with a read-only Firestore -> GCS -> ephemeral-cache path.
stream_start = src.find(stream_marker)
legacy_marker = '  // Video Generation & QA Endpoint (Legacy Synchronous Fallback)'
stream_end = src.find(legacy_marker, stream_start)
if stream_start < 0 or stream_end < 0:
    raise RuntimeError('stream endpoint markers not found')

stream_route = '''  // Physical Video Streaming & Download Endpoint
  app.get('/api/videos/stream/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const isDownload = req.query.download === 'true' || req.query.download === '1';

      if (!firestoreTaskRepository.isAvailable()) {
        return res.status(503).json({
          error: 'task_metadata_authority_unavailable',
          storageAuthority: 'unavailable',
        });
      }

      // Firestore must validate the task before an ephemeral cache hit can be served.
      const rec = await firestoreTaskRepository.getTask(taskId);
      if (!rec) {
        return res.status(404).json({ error: 'task_not_found', storageAuthority: 'firestore' });
      }
      if (!rec.outputBucket || !rec.outputObjectPath || rec.artifactPersisted !== true) {
        return res.status(404).json({
          error: 'artifact_not_persisted',
          storageAuthority: 'firestore',
        });
      }

      let videoBuffer: Buffer | null = ephemeralVideoStore.get(taskId) || null;
      if (!videoBuffer || videoBuffer.length < 1000) {
        try {
          videoBuffer = await gcsArtifactStore.fetchArtifactBuffer(rec.outputBucket, rec.outputObjectPath);
          console.log(`[Video Stream] GCS authority read gs://${rec.outputBucket}/${rec.outputObjectPath} (${videoBuffer.length} bytes)`);
        } catch (gcsErr) {
          console.error(`[Video Stream] Authoritative GCS artifact missing for ${taskId}:`, (gcsErr as any)?.message || gcsErr);
          return res.status(404).json({
            error: 'artifact_not_found',
            storageAuthority: 'gcs',
            outputBucket: rec.outputBucket,
            outputObjectPath: rec.outputObjectPath,
          });
        }

        if (!videoBuffer || videoBuffer.length < 1000) {
          return res.status(404).json({
            error: 'artifact_not_found',
            storageAuthority: 'gcs',
          });
        }
        ephemeralVideoStore.set(taskId, videoBuffer);
      }

      const fileSize = videoBuffer.length;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (!Number.isFinite(start) || start < 0 || end < start || end >= fileSize) {
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          return res.status(416).end();
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': rec.contentType || 'video/mp4',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(videoBuffer.subarray(start, end + 1));
      }

      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': rec.contentType || 'video/mp4',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
        ...(isDownload ? { 'Content-Disposition': `attachment; filename="zaojing_${taskId}.mp4"` } : {}),
      });
      return res.end(videoBuffer);
    } catch (err) {
      console.error('Error streaming video:', err);
      return res.status(500).json({ error: '读取视频流或下载失败' });
    }
  });

'''
src = src[:stream_start] + stream_route + src[stream_end:]
path.write_text(src, encoding='utf-8')
print('[p0-5 recovery/stream] explicit recovery and read-only stream authority applied')

from pathlib import Path

path = Path('server.ts')
text = path.read_text(encoding='utf-8')

start = text.index('export async function startServer() {')
end_marker = "\nif (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {"
end = text.index(end_marker, start)

replacement = r'''export async function startServer() {
  const app = await createApp();
  const configuredPort = Number(process.env.PORT || 3000);
  const PORT = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);

    // P0-5 Cloud Run rule: startup recovery must read durable Firestore state,
    // never enumerate process-local task memory and never write terminal state directly.
    void taskStateMachineService
      .recoverAbandonedTasks()
      .then(({ recoveredCount, evaluatedCount }) => {
        console.log(
          `[Recovery Engine] Durable startup scan complete: evaluated=${evaluatedCount}, recovered=${recoveredCount}.`
        );
      })
      .catch((err) => {
        // Recovery failure must not prevent the HTTP service from becoming healthy.
        // Firestore/status/recover routes remain fail-closed and can retry explicitly.
        console.error('[Recovery Engine Initialization Error]:', err);
      });
  });

  return server;
}
'''

new_text = text[:start] + replacement + text[end:]

if "const configuredPort = Number(process.env.PORT || 3000);" not in new_text:
    raise SystemExit('PORT hardening marker missing after patch')
if 'for (const [taskId, record] of serverVideoTaskStore.entries())' in new_text[new_text.index('export async function startServer()'):]:
    raise SystemExit('legacy memory-first startup recovery still present')

path.write_text(new_text, encoding='utf-8')
print('[p0-5 cloudrun runtime] PORT + durable startup recovery hardening applied')

from pathlib import Path

path = Path('server.ts')
text = path.read_text(encoding='utf-8')

route_start = text.index("app.post('/api/videos/start'")
route_end = text.index("app.get('/api/videos/status/:taskId'", route_start)
route = text[route_start:route_end]

gate_marker = "const requestedTaskId = req.body.taskId;"
ai_marker = "GeminiClientFactory.getClientForSession(session)"

# Idempotent fast path: once the durable reuse gate is already before ADC/Gemini
# construction, validation succeeds without rewriting server.ts again.
if gate_marker in route and ai_marker in route:
    reuse_pos = route.index(gate_marker)
    ai_pos = route.index(ai_marker)
    if reuse_pos < ai_pos and route.count(gate_marker) == 1:
        print('[p0-5 early idempotency] already hardened')
        raise SystemExit(0)

block_start = "      const requestedTaskId = req.body.taskId;\n\n      // P0-5: Firestore is the idempotency authority across Cloud Run instances."
start = text.index(block_start, route_start, route_end)
end_marker = "\n\n      const taskId = req.body.taskId || `vtask_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;"
end = text.index(end_marker, start, route_end)
block = text[start:end]

# Remove the late gate from immediately before task creation.
text = text[:start] + text[end:]

# The durable task lookup must run before GeminiClientFactory token resolution or any
# image/QA/model preparation. Multer has already populated req.body at this point.
route_start = text.index("app.post('/api/videos/start'")
insert_marker = "      const files = req.files as { [fieldname: string]: Express.Multer.File[] };"
insert_at = text.index(insert_marker, route_start)
text = text[:insert_at] + block + "\n\n" + text[insert_at:]

route_start = text.index("app.post('/api/videos/start'")
route_end = text.index("app.get('/api/videos/status/:taskId'", route_start)
route = text[route_start:route_end]
reuse_pos = route.index(gate_marker)
ai_pos = route.index(ai_marker)
if reuse_pos >= ai_pos:
    raise SystemExit('durable reuse gate still occurs after Gemini client creation')
if route.count(gate_marker) != 1:
    raise SystemExit('requestedTaskId gate must appear exactly once in /api/videos/start')

path.write_text(text, encoding='utf-8')
print('[p0-5 early idempotency] durable reuse gate moved before ADC client creation')

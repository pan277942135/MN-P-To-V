from pathlib import Path

path = Path('server.ts')
text = path.read_text(encoding='utf-8')

block_start = "      const requestedTaskId = req.body.taskId;\n\n      // P0-5: Firestore is the idempotency authority across Cloud Run instances."
start = text.index(block_start)
end_marker = "\n\n      const taskId = req.body.taskId || `vtask_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;"
end = text.index(end_marker, start)
block = text[start:end]

# Remove the late gate from immediately before task creation.
text = text[:start] + text[end:]

# The durable task lookup must run before GeminiClientFactory token resolution or any
# image/QA/model preparation. Multer has already populated req.body at this point.
insert_marker = "      const files = req.files as { [fieldname: string]: Express.Multer.File[] };"
insert_at = text.index(insert_marker, text.index("app.post('/api/videos/start'"))
text = text[:insert_at] + block + "\n\n" + text[insert_at:]

route_start = text.index("app.post('/api/videos/start'")
route_end = text.index("app.get('/api/videos/status/:taskId'", route_start)
route = text[route_start:route_end]
reuse_pos = route.index("const requestedTaskId = req.body.taskId;")
ai_pos = route.index("GeminiClientFactory.getClientForSession(session)")
if reuse_pos >= ai_pos:
    raise SystemExit('durable reuse gate still occurs after Gemini client creation')
if route.count("const requestedTaskId = req.body.taskId;") != 1:
    raise SystemExit('requestedTaskId gate must appear exactly once in /api/videos/start')

path.write_text(text, encoding='utf-8')
print('[p0-5 early idempotency] durable reuse gate moved before ADC client creation')

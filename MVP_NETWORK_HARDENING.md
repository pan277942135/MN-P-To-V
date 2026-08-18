# MVP Identity Safe v0.2.1 — Network/Deadline Hardening

Observed UAT failures addressed in this patch:

1. Browser `TypeError: Failed to fetch`
   - no longer maps to task `FAILED` in the client;
   - preserves one idempotency key per click;
   - performs read-only lookup of the durable task before replaying start;
   - if the server already created the task, the client resumes that same task;
   - if the server has not created a task, the same start request may be replayed with the exact same key;
   - polling network interruptions remain client-side recovery states and never mutate durable task state to failed.

2. Vertex generation `Deadline exceeded`
   - nested provider JSON message is unwrapped;
   - provider numeric code such as `1` is stored as `providerCode`, not `providerHttpStatus`;
   - a definitive provider deadline is normalized to `GENERATION_TIMEOUT` / `providerStatus=DEADLINE_EXCEEDED`;
   - the old Operation is not polled after definitive failure;
   - the UI tells the user that a new task can safely be created using the unchanged image and prompt.

The production generation path remains:

`Cloud Run → Runtime ADC → Vertex AI veo-3.1-fast-generate-001 → GCS → ffmpeg frames → Gemini identity QA`

No new automatic provider retry is introduced for deadline failures. The only automatic second Veo attempt remains the frozen one-time conservative identity-drift retry.

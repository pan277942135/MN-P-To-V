#!/usr/bin/env bash
set -Eeuo pipefail

: "${PROJECT_ID:?}"
: "${REGION:?}"
: "${SERVICE:?}"
: "${SOURCE_SHA:?}"
: "${CANONICAL_VEO_BUCKET:?}"
: "${FIRESTORE_DATABASE_ID:?}"
: "${RUNTIME_SA:?}"

# Product source on this temp branch must be byte-identical to the merged commit.
git fetch --no-tags --depth=1 origin "$SOURCE_SHA"
for p in server.ts src package.json firebase-applet-config.json; do
  git diff --exit-code "$SOURCE_SHA" HEAD -- "$p"
done

grep -Fq "EXPECTED_PRODUCTION_VEO_BUCKET = 'ai-studio-bucket-89614354864-asia-south1'" src/server/storage/gcsArtifactStore.ts
grep -Fq 'masterImageBuffers: masterBuffers' server.ts
grep -Fq 'scenePreservationScore: 100' src/services/character/identityLockService.ts
grep -Fq '...masterParts' src/services/qa/visualQaService.ts
grep -Fq '(pipelineError as any).startData = startData' src/pages/StudioPage.tsx
grep -Fq "legacyErrorText.includes('角色一致性质检未通过')" src/pages/TaskHistoryPage.tsx
grep -Fq '(task as any).firstFrameQaReport' src/utils/taskHelper.ts
if grep -Fq 'const masterBufForQa = masterBuffers[0]' server.ts; then
  echo 'Single-master QA wiring still present.' >&2
  exit 1
fi

echo '=== build ==='
npm install
npm run build
test -s dist/server.cjs
test -s dist/index.html
grep -R -Fq '该任务在提交 Veo 前被首帧角色质检拦截' dist/assets
grep -R -Fq '首帧角色/画面质检触发硬拦截' dist/assets

echo '=== local production-mode smoke ==='
PORT=3000 NODE_ENV=production P0_DISABLE_STARTUP_RECOVERY=1 \
  GOOGLE_CLOUD_PROJECT="$PROJECT_ID" GCP_PROJECT="$PROJECT_ID" \
  VEO_OUTPUT_BUCKET="$CANONICAL_VEO_BUCKET" FIRESTORE_DATABASE_ID="$FIRESTORE_DATABASE_ID" \
  node dist/server.cjs > /tmp/zaojing-smoke.log 2>&1 &
SMOKE_PID=$!
cleanup_smoke() { kill "$SMOKE_PID" 2>/dev/null || true; }
trap cleanup_smoke EXIT
SMOKE_OK=0
for _ in $(seq 1 30); do
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    cat /tmp/zaojing-smoke.log >&2 || true
    exit 1
  fi
  if curl -fsS http://127.0.0.1:3000/api/health -o /tmp/health-local.json; then
    SMOKE_OK=1
    break
  fi
  sleep 1
done
test "$SMOKE_OK" = 1
jq -e '.status == "ok"' /tmp/health-local.json >/dev/null
cleanup_smoke
trap - EXIT

echo '=== snapshot production ==='
gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=export > service-before.yaml
gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json > service-before.json
PREV_REVISION="$(jq -r '.status.latestReadyRevisionName' service-before.json)"
SOURCE_JSON="$(jq -r '.spec.template.metadata.annotations["run.googleapis.com/sources"]' service-before.json)"
BASE_JSON="$(jq -r '.spec.template.metadata.annotations["run.googleapis.com/base-images"]' service-before.json)"
PREV_SOURCE="$(printf '%s' "$SOURCE_JSON" | jq -r '.["app-container"]')"
PREV_SOURCE="${PREV_SOURCE%%#*}"
BASE_IMAGE="$(printf '%s' "$BASE_JSON" | jq -r '.["app-container"]')"
CURRENT_BUCKET="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name=="VEO_OUTPUT_BUCKET") | .value' service-before.json)"
test "$(jq -r '.spec.template.spec.containers[0].image' service-before.json)" = 'scratch'
[[ "$PREV_SOURCE" == gs://* ]]
test -n "$BASE_IMAGE"
test -n "$PREV_REVISION"
echo "PREV_REVISION=$PREV_REVISION"
echo "PREV_SOURCE=$PREV_SOURCE"
echo "CURRENT_BUCKET=$CURRENT_BUCKET"

echo '=== package artifact ==='
PATHS=()
for p in .env.example .gitignore CHANGELOG.md assets bun.lock data dist firebase-applet-config.json firestore.rules index.html metadata.json node_modules package.json server.ts src tsconfig.json vite.config.ts; do
  if [ -e "$p" ]; then PATHS+=("$p"); fi
done
tar -czf build_artifacts.tar.gz "${PATHS[@]}"
test -s build_artifacts.tar.gz
tar -tzf build_artifacts.tar.gz > artifact-list.txt
grep -Fxq 'dist/server.cjs' artifact-list.txt
grep -Fxq 'package.json' artifact-list.txt
grep -q '^node_modules/' artifact-list.txt
ARTIFACT_SHA256="$(sha256sum build_artifacts.tar.gz | awk '{print $1}')"
ARTIFACT_SIZE="$(stat -c '%s' build_artifacts.tar.gz)"
echo "ARTIFACT_SHA256=$ARTIFACT_SHA256"
echo "ARTIFACT_SIZE=$ARTIFACT_SIZE"

echo '=== validate existing runtime-SA impersonation permission ==='
gcloud auth print-access-token --impersonate-service-account="$RUNTIME_SA" >/dev/null
# Read the existing source through the same principal before attempting the new immutable write.
gcloud storage objects describe "$PREV_SOURCE" --impersonate-service-account="$RUNTIME_SA" --format='value(size)' >/dev/null

echo '=== upload immutable artifact through runtime SA ==='
SOURCE_BUCKET="$(printf '%s' "$PREV_SOURCE" | sed -E 's#^(gs://[^/]+).*$#\1#')"
NEW_SOURCE="$SOURCE_BUCKET/services/$SERVICE/github-$SOURCE_SHA/compiled/build_artifacts.tar.gz"
gcloud storage cp build_artifacts.tar.gz "$NEW_SOURCE" --impersonate-service-account="$RUNTIME_SA"
REMOTE_SIZE="$(gcloud storage objects describe "$NEW_SOURCE" --impersonate-service-account="$RUNTIME_SA" --format='value(size)')"
test "$REMOTE_SIZE" = "$ARTIFACT_SIZE"
echo "NEW_SOURCE=$NEW_SOURCE"

echo '=== prepare exact two-field service patch ==='
python3 - "$PREV_SOURCE" "$NEW_SOURCE" "$CURRENT_BUCKET" "$CANONICAL_VEO_BUCKET" <<'PY'
import sys
from pathlib import Path
old_source, new_source, old_bucket, new_bucket = sys.argv[1:]
original = Path('service-before.yaml').read_text()
if original.count(old_source) != 1:
    raise SystemExit(f'Expected one source URI occurrence, found {original.count(old_source)}')
patched = original.replace(old_source, new_source, 1)
lines = patched.splitlines(keepends=True)
old_value_line = None
value_index = None
seen = 0
for i, line in enumerate(lines):
    if line.strip() == '- name: VEO_OUTPUT_BUCKET':
        seen += 1
        for j in range(i + 1, min(i + 5, len(lines))):
            if lines[j].lstrip().startswith('value:'):
                value_index = j
                old_value_line = lines[j]
                break
if seen != 1 or value_index is None or old_value_line is None:
    raise SystemExit(f'Expected exactly one VEO_OUTPUT_BUCKET block, found {seen}')
current = old_value_line.split('value:', 1)[1].strip().strip("'\"")
if current != old_bucket:
    raise SystemExit(f'Bucket snapshot mismatch: yaml={current}, json={old_bucket}')
indent = old_value_line[:len(old_value_line)-len(old_value_line.lstrip())]
newline = '\n' if old_value_line.endswith('\n') else ''
lines[value_index] = f'{indent}value: {new_bucket}{newline}'
patched = ''.join(lines)
Path('service-patched.yaml').write_text(patched)
normalized = patched.replace(new_source, old_source, 1)
norm_lines = normalized.splitlines(keepends=True)
for i, line in enumerate(norm_lines):
    if line.strip() == '- name: VEO_OUTPUT_BUCKET':
        for j in range(i + 1, min(i + 5, len(norm_lines))):
            if norm_lines[j].lstrip().startswith('value:'):
                norm_lines[j] = old_value_line
                break
        break
if ''.join(norm_lines) != original:
    raise SystemExit('Patch scope exceeded source URI + VEO_OUTPUT_BUCKET')
print('PATCH_SCOPE_PASS=source_uri+VEO_OUTPUT_BUCKET_only')
PY
grep -Fq "$NEW_SOURCE" service-patched.yaml
grep -A3 -F -- '- name: VEO_OUTPUT_BUCKET' service-patched.yaml | grep -Fq "$CANONICAL_VEO_BUCKET"

echo '=== deploy with automatic rollback ==='
DEPLOYED=0
rollback() {
  rc=$?
  if [ "$DEPLOYED" = 1 ]; then
    echo 'Verification failed; restoring exact pre-deploy service export.' >&2
    gcloud run services replace service-before.yaml --project="$PROJECT_ID" --region="$REGION" --quiet || true
  fi
  exit "$rc"
}
trap rollback ERR

gcloud run services replace service-patched.yaml --project="$PROJECT_ID" --region="$REGION" --quiet
DEPLOYED=1

gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json > service-after.json
NEW_REVISION="$(jq -r '.status.latestReadyRevisionName' service-after.json)"
SERVICE_URL="$(jq -r '.status.url' service-after.json)"
SOURCE_JSON_AFTER="$(jq -r '.spec.template.metadata.annotations["run.googleapis.com/sources"]' service-after.json)"
BASE_JSON_AFTER="$(jq -r '.spec.template.metadata.annotations["run.googleapis.com/base-images"]' service-after.json)"
LIVE_SOURCE="$(printf '%s' "$SOURCE_JSON_AFTER" | jq -r '.["app-container"]')"
LIVE_SOURCE="${LIVE_SOURCE%%#*}"
LIVE_BASE="$(printf '%s' "$BASE_JSON_AFTER" | jq -r '.["app-container"]')"
LIVE_BUCKET="$(jq -r '.spec.template.spec.containers[0].env[] | select(.name=="VEO_OUTPUT_BUCKET") | .value' service-after.json)"

test "$NEW_REVISION" != "$PREV_REVISION"
test "$LIVE_SOURCE" = "$NEW_SOURCE"
test "$LIVE_BASE" = "$BASE_IMAGE"
test "$LIVE_BUCKET" = "$CANONICAL_VEO_BUCKET"
test "$(jq -r '.spec.template.spec.containers[0].image' service-after.json)" = 'scratch'

jq -S '{sqlDb:[.spec.template.spec.containers[0].env[]|select(.name=="SQL_DB_NAME")],appUrl:[.spec.template.spec.containers[0].env[]|select(.name=="APP_URL")],args:.spec.template.spec.containers[0].args,command:.spec.template.spec.containers[0].command,resources:.spec.template.spec.containers[0].resources,ports:.spec.template.spec.containers[0].ports,startupProbe:.spec.template.spec.containers[0].startupProbe,minScale:.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"],maxScale:.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"],sessionAffinity:.spec.template.metadata.annotations["run.googleapis.com/sessionAffinity"],baseImages:.spec.template.metadata.annotations["run.googleapis.com/base-images"]}' service-before.json > critical-before.json
jq -S '{sqlDb:[.spec.template.spec.containers[0].env[]|select(.name=="SQL_DB_NAME")],appUrl:[.spec.template.spec.containers[0].env[]|select(.name=="APP_URL")],args:.spec.template.spec.containers[0].args,command:.spec.template.spec.containers[0].command,resources:.spec.template.spec.containers[0].resources,ports:.spec.template.spec.containers[0].ports,startupProbe:.spec.template.spec.containers[0].startupProbe,minScale:.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"],maxScale:.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"],sessionAffinity:.spec.template.metadata.annotations["run.googleapis.com/sessionAffinity"],baseImages:.spec.template.metadata.annotations["run.googleapis.com/base-images"]}' service-after.json > critical-after.json
diff -u critical-before.json critical-after.json

echo '=== live verification ==='
curl -fsS "$SERVICE_URL/api/health" -o health-live.json
jq -e '.status == "ok"' health-live.json >/dev/null
curl -fsS "$SERVICE_URL/" -o index-live.html
ASSET_PATH="$(grep -oE 'src="/[^"]+\.js"' index-live.html | head -1 | cut -d'"' -f2)"
test -n "$ASSET_PATH"
curl -fsS "$SERVICE_URL$ASSET_PATH" -o app-live.js
grep -Fq '该任务在提交 Veo 前被首帧角色质检拦截' app-live.js
grep -Fq '首帧角色/画面质检触发硬拦截' app-live.js
grep -Fq '首帧 QA 详细分数未保留' app-live.js
grep -Fq 'Google 未返回具体过滤原因' app-live.js
curl -fsS "$SERVICE_URL/api/videos/audit" -o audit-live.json
jq -e '.storageAuthority == "firestore"' audit-live.json >/dev/null
jq -e '.storageConfigValid == true' audit-live.json >/dev/null
jq -e '.bucketDriftDetected == false' audit-live.json >/dev/null
jq -e --arg b "$CANONICAL_VEO_BUCKET" '.effectiveVeoOutputBucket == $b and .environmentVeoOutputBucket == $b and .expectedVeoOutputBucket == $b' audit-live.json >/dev/null

trap - ERR

echo "NEW_REVISION=$NEW_REVISION"
echo "SERVICE_URL=$SERVICE_URL"
echo "LIVE_SOURCE=$LIVE_SOURCE"
echo 'PRODUCTION_DEPLOYMENT_PASS=true'

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '## Production M2-1 identity false-negative hardening: PASS'
    echo "- Source commit: \`$SOURCE_SHA\`"
    echo "- Previous revision: \`$PREV_REVISION\`"
    echo "- New revision: \`$NEW_REVISION\`"
    echo "- New source artifact: \`$LIVE_SOURCE\`"
    echo "- Artifact SHA-256: \`$ARTIFACT_SHA256\`"
    echo "- VEO_OUTPUT_BUCKET: \`$CANONICAL_VEO_BUCKET\`"
    echo '- Deployment model preserved: scratch + source artifact + Node.js 22 base image'
    echo '- Other critical runtime configuration unchanged'
    echo '- Health / frontend / Firestore / storage config: PASS'
    echo '- No Veo generation invoked'
  } >> "$GITHUB_STEP_SUMMARY"
fi

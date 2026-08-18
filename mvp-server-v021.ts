import express from 'express';
import crypto from 'crypto';
import { getFirestoreInstance } from './src/server/db/firestore';
import { IDENTITY_SAFE_VERSION } from './src/mvp/identitySafe';
import type { MvpVideoTask } from './src/mvp/mvpContract';

const PORT = Number(process.env.PORT || 8080);
const TASK_COLLECTION = 'mvp_video_tasks';
const IDEMPOTENCY_COLLECTION = 'mvp_video_idempotency';
const CLIENT_VERSION = 'identity-safe-v0.2.1-network-hardening';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function isRetryQaPending(status: unknown, providerAttempt: unknown): boolean {
  return Number(providerAttempt || 1) > 1 && ['RETRYING', 'GENERATING', 'QUALITY_CHECKING'].includes(String(status || ''));
}

function isSafeToClearPersistedRetryQa(status: unknown, providerAttempt: unknown): boolean {
  return Number(providerAttempt || 1) > 1 && ['RETRYING', 'GENERATING'].includes(String(status || ''));
}

function sanitizeTaskBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  let sanitized = body;
  if (body.taskId && isRetryQaPending(body.status, body.providerAttempt)) {
    sanitized = { ...sanitized, identityReport: null };
  }
  if (sanitized.error?.code === 'IDENTITY_INPUT_UNSAFE') {
    sanitized = {
      ...sanitized,
      error: {
        ...sanitized.error,
        recommendedAction: '按具体校验提示修正输入图尺寸或比例；动作风险由 Identity Safe 自动收敛，不需要因为转头、遮挡或运镜提示重新上传图片。',
      },
    };
  }
  return sanitized;
}

async function clearPersistedStaleRetryQa(taskId: string): Promise<void> {
  const db = getFirestoreInstance();
  if (!db) return;
  const ref = db.collection(TASK_COLLECTION).doc(taskId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const current = snap.data() as MvpVideoTask;
    if (!isSafeToClearPersistedRetryQa(current.status, current.providerAttempt) || !current.identityReport) return;
    tx.update(ref, { identityReport: null, updatedAt: Date.now() });
  });
}

function publicTask(task: MvpVideoTask) {
  const currentIdentityReport = isRetryQaPending(task.status, task.providerAttempt) ? null : task.identityReport || null;
  return sanitizeTaskBody({
    taskId: task.taskId,
    status: task.status,
    stage: task.stage,
    provider: task.provider,
    model: task.model,
    projectId: task.projectId,
    region: task.region,
    durationSeconds: task.durationSeconds,
    identitySafeMode: task.identitySafeMode === true,
    identitySafeVersion: IDENTITY_SAFE_VERSION,
    clientVersion: CLIENT_VERSION,
    identityQaModel: task.identityQaModel || null,
    providerAttempt: task.providerAttempt || 1,
    identityRetryCount: task.identityRetryCount || 0,
    retryReason: task.retryReason || null,
    operationNamePresent: Boolean(task.operationName),
    pollAttempt: task.pollAttempt,
    identityReport: currentIdentityReport,
    firstAttemptIdentityReport: task.firstAttemptIdentityReport || null,
    artifactPersisted: task.artifactPersisted,
    artifactVerified: task.artifactVerified,
    sizeBytes: task.sizeBytes || null,
    videoUri: task.videoUri || null,
    videoUrl: task.status === 'COMPLETED' ? `/api/mvp/videos/${task.taskId}/stream` : null,
    error: task.error || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
  });
}

function renderMvpPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>造境 Identity Safe v0.2.1</title><style>
body{font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#fafafa;margin:0;padding:24px}main{max-width:820px;margin:auto}section{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:20px;margin:16px 0}input,textarea,select,button{font:inherit}textarea,select,input[type=file]{width:100%;box-sizing:border-box;margin:8px 0 16px;background:#09090b;color:#fafafa;border:1px solid #3f3f46;border-radius:10px;padding:10px}textarea{min-height:150px}button{background:#7c3aed;color:white;border:0;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer;margin-right:8px;margin-top:6px}button.secondary{background:#27272a;color:#e4e4e7}button:disabled{opacity:.45;cursor:not-allowed}pre{white-space:pre-wrap;word-break:break-word;background:#09090b;padding:12px;border-radius:10px;border:1px solid #27272a;max-height:560px;overflow:auto}video{width:100%;border-radius:12px;background:black}.ok{color:#34d399}.bad{color:#fb7185}.warn{color:#fbbf24}.info{color:#93c5fd}.muted{color:#a1a1aa;font-size:13px}.badge{display:inline-block;padding:4px 8px;border-radius:99px;background:#312e81;color:#c7d2fe;font-size:12px}.hint{padding:10px 12px;border:1px solid #3f3f46;border-radius:10px;margin:10px 0;background:#111113}.hidden{display:none}
</style></head><body><main>
<h1>造境 <span class="badge">Identity Safe v0.2.1</span></h1><p class="muted">新增：手机网络/IAP 断线恢复、同 idempotency key 找回原任务、轮询断线不误报 FAILED、Vertex Deadline 独立错误分类。</p>
<section><label>已人工确认的梅凝图片（Identity Safe 要求清晰、短边≥512px）</label><input id="image" type="file" accept="image/jpeg,image/png,image/webp"/>
<label>场景 / 动作 Prompt</label><textarea id="prompt" placeholder="建议轻微呼吸、自然眨眼、微弱环境动态；避免大幅转头、遮脸、镜头环绕。"></textarea>
<label>时长</label><select id="duration"><option value="4">4s（优先）</option><option value="6">6s</option><option value="8">8s（压力测试）</option></select>
<button id="go">Identity Safe 生成</button><button id="resume" class="secondary hidden">恢复最近任务</button></section>
<section><div id="headline">尚未开始</div><div id="hint" class="hint hidden"></div><pre id="status">{}</pre><button id="recover" class="secondary hidden">恢复当前 Attempt 产物（不重新提交 Veo）</button></section>
<section id="videoBox" class="hidden"><video id="video" controls></video><p><a id="download" style="color:#c4b5fd" download>下载通过身份 QA 的视频</a></p></section>
<script>
const $=id=>document.getElementById(id);
const STORE_KEY='zaojing.mvp.v021.idempotencyKey';
const STORE_TASK='zaojing.mvp.v021.taskId';
let taskId=sessionStorage.getItem(STORE_TASK)||null;
let idempotencyKey=sessionStorage.getItem(STORE_KEY)||null;
let timer=null;
let pollFailures=0;
let pollCount=0;
const terminal=new Set(['COMPLETED','FAILED','SUBMISSION_OUTCOME_UNKNOWN']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function setHint(text,kind='info'){$('hint').textContent=text;$('hint').className='hint '+kind;$('hint').classList.remove('hidden');}
function clearHint(){$('hint').classList.add('hidden');$('hint').textContent='';}
function show(d){
  $('status').textContent=JSON.stringify(d,null,2);
  let title=d.status?('状态：'+d.status):'状态未知';
  if(d.error?.code==='GENERATION_TIMEOUT') title='状态：生成超时（Vertex）';
  if(d.identityReport) title+=' | 身份QA：'+d.identityReport.gateStatus;
  $('headline').textContent=title;
  $('headline').className=d.status==='COMPLETED'?'ok':(d.status==='FAILED'?'bad':(['RETRYING','QUALITY_CHECKING','NETWORK_RECOVERING','NETWORK_UNCERTAIN'].includes(d.status)?'warn':'info'));
  $('recover').classList.toggle('hidden',d.status!=='SUBMISSION_OUTCOME_UNKNOWN');
  if(d.videoUrl){$('videoBox').classList.remove('hidden');$('video').src=d.videoUrl;$('download').href=d.videoUrl+'?download=1';}
  if(d.error?.code==='GENERATION_TIMEOUT') setHint('Vertex 已明确结束这次 Operation，当前任务不会再产出视频。保留原图和 Prompt，直接再次点击【Identity Safe 生成】即可创建一个新任务。','warn');
  if(d.error?.recommendedAction&&!d.error?.code?.includes('TIMEOUT')) setHint(d.error.recommendedAction,d.status==='FAILED'?'warn':'info');
}
function showClient(status,message,detail){show({status,stage:'client_transport',error:{code:'CLIENT_NETWORK_INTERRUPTED',message,retryable:true,recommendedAction:'不要重复点击生成；页面正在用同一个 idempotency key 找回原任务。',technicalMessage:detail||null}})}

async function responseJson(response){
  const text=await response.text();
  let data=null;
  try{data=JSON.parse(text)}catch{}
  if(!data){
    const ct=response.headers.get('content-type')||'';
    throw new Error('NON_JSON_RESPONSE http='+response.status+' contentType='+ct);
  }
  return data;
}

async function lookup(key){
  const response=await fetch('/api/mvp/videos/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:key}),cache:'no-store'});
  if(response.status===404)return null;
  const data=await responseJson(response);
  if(!response.ok)throw new Error(data?.error?.message||data?.error||('lookup HTTP '+response.status));
  return data;
}

function persistTask(data,key){
  if(key){idempotencyKey=key;sessionStorage.setItem(STORE_KEY,key);$('resume').classList.remove('hidden');}
  if(data?.taskId){taskId=data.taskId;sessionStorage.setItem(STORE_TASK,taskId);}
}
function clearPending(){sessionStorage.removeItem(STORE_KEY);sessionStorage.removeItem(STORE_TASK);idempotencyKey=null;taskId=null;$('resume').classList.add('hidden');}

function schedulePoll(delay){if(timer)clearTimeout(timer);timer=setTimeout(poll,delay);}
async function poll(){
  if(!taskId)return;
  try{
    const r=await fetch('/api/mvp/videos/'+encodeURIComponent(taskId),{cache:'no-store'});
    const d=await responseJson(r);
    pollFailures=0;pollCount++;show(d);
    if(terminal.has(d.status)){$('go').disabled=false;if(d.status==='COMPLETED')clearPending();return;}
    const next=pollCount<8?4000:6000;schedulePoll(next);
  }catch(e){
    pollFailures++;
    setHint('网络/IAP 连接暂时中断，但任务不会被标记失败。正在继续查询同一个 taskId：'+taskId,'warn');
    showClient('NETWORK_RECOVERING','状态查询连接中断，正在自动恢复。',String(e));
    schedulePoll(Math.min(12000,5000+pollFailures*2000));
  }
}

async function monitorLookupUntilOperation(key,initial){
  let current=initial||null;
  const started=Date.now();
  while(Date.now()-started<135000){
    if(current){persistTask(current,key);show(current);if(terminal.has(current.status)||current.operationNamePresent){if(current.operationNamePresent&&!terminal.has(current.status))schedulePoll(1000);$('go').disabled=terminal.has(current.status)?false:true;return current;}}
    setHint('请求响应丢失，但服务端可能仍在提交 Veo。正在按原 idempotency key 找回任务；此过程不会重复提交。','warn');
    await sleep(2500);
    try{current=await lookup(key)}catch(e){showClient('NETWORK_RECOVERING','恢复查询也遇到网络波动，继续重试。',String(e));await sleep(2500);}
  }
  showClient('NETWORK_UNCERTAIN','超过 135 秒仍无法确认服务端提交状态。请使用【恢复最近任务】，不要连续点击生成。');
  $('resume').classList.remove('hidden');$('go').disabled=false;
  return current;
}

function buildForm(image,prompt,duration){const fd=new FormData();fd.append('image',image);fd.append('prompt',prompt);fd.append('durationSeconds',duration);fd.append('identitySafeMode','true');return fd;}
async function startWithRecovery(image,prompt,duration,key){
  persistTask(null,key);
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r=await fetch('/api/mvp/videos/start',{method:'POST',headers:{'x-idempotency-key':key},body:buildForm(image,prompt,duration)});
      const d=await responseJson(r);persistTask(d,key);show(d);
      if(d.taskId){if(!terminal.has(d.status)){if(d.operationNamePresent)schedulePoll(1000);else await monitorLookupUntilOperation(key,d);}else $('go').disabled=false;return d;}
      if(!r.ok){$('go').disabled=false;return d;}
    }catch(e){
      showClient('NETWORK_RECOVERING','生成请求连接中断。正在先查找服务端是否已经创建任务，再决定是否安全重放同一请求。',String(e));
      try{
        const found=await lookup(key);
        if(found){persistTask(found,key);return await monitorLookupUntilOperation(key,found);}
      }catch(lookupError){setHint('暂时无法完成恢复查询，将继续使用同一个 idempotency key 重试；不会产生重复 Provider 提交。','warn');}
      if(attempt<2)await sleep(1500*(attempt+1));
    }
  }
  showClient('NETWORK_UNCERTAIN','多次网络恢复仍未得到确定响应。任务可能已在服务端存在，请点击【恢复最近任务】继续查询，暂不要重新生成。');
  $('resume').classList.remove('hidden');$('go').disabled=false;
  return null;
}

$('go').onclick=async()=>{
  const image=$('image').files[0],prompt=$('prompt').value.trim(),duration=$('duration').value;
  if(!image||!prompt){alert('请选择图片并填写 Prompt');return}
  if(timer)clearTimeout(timer);clearHint();$('go').disabled=true;$('videoBox').classList.add('hidden');
  const key=crypto.randomUUID();taskId=null;sessionStorage.removeItem(STORE_TASK);
  await startWithRecovery(image,prompt,duration,key);
};

$('resume').onclick=async()=>{
  const key=idempotencyKey||sessionStorage.getItem(STORE_KEY);if(!key){setHint('没有可恢复的最近任务。','info');return}
  $('resume').disabled=true;try{const found=await lookup(key);if(!found){showClient('NETWORK_UNCERTAIN','服务端尚未找到这个 idempotency key。若此前从未成功提交，可重新点击生成。');$('go').disabled=false;return}persistTask(found,key);show(found);if(!terminal.has(found.status)){if(found.operationNamePresent)schedulePoll(500);else await monitorLookupUntilOperation(key,found)}else $('go').disabled=false;}catch(e){showClient('NETWORK_RECOVERING','恢复最近任务时网络仍不可用。',String(e))}finally{$('resume').disabled=false}
};

$('recover').onclick=async()=>{if(!taskId)return;$('recover').disabled=true;try{const r=await fetch('/api/mvp/videos/'+encodeURIComponent(taskId)+'/recover',{method:'POST'});const d=await responseJson(r);show(d)}catch(e){setHint('产物恢复请求连接中断，请稍后重试；不会重新提交 Veo。','warn')}finally{$('recover').disabled=false}};

(async()=>{if(idempotencyKey){$('resume').classList.remove('hidden');try{const found=await lookup(idempotencyKey);if(found){persistTask(found,idempotencyKey);show(found);if(!terminal.has(found.status)){if(found.operationNamePresent)schedulePoll(700);else monitorLookupUntilOperation(idempotencyKey,found)}}}catch{}}})();
</script></main></body></html>`;
}

export async function createMvpAppV021() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      if (body?.taskId && body.identityReport && isSafeToClearPersistedRetryQa(body.status, body.providerAttempt)) {
        void clearPersistedStaleRetryQa(String(body.taskId)).catch((error) => {
          console.warn('[MVP_IDENTITY_SAFE_V021] stale retry QA cleanup failed:', String((error as any)?.message || error));
        });
      }
      return originalJson(sanitizeTaskBody(body));
    }) as typeof res.json;
    next();
  });

  app.get('/', (_req, res) => res.type('html').send(renderMvpPage()));
  app.get('/api/mvp/client-health', (_req, res) => res.json({
    status: 'ok',
    clientVersion: CLIENT_VERSION,
    identitySafeVersion: IDENTITY_SAFE_VERSION,
    networkRecovery: true,
    idempotencyLookup: true,
  }));

  app.post('/api/mvp/videos/lookup', async (req, res) => {
    try {
      const key = String(req.body?.idempotencyKey || '').trim();
      if (!key || key.length < 16 || key.length > 200) {
        return res.status(400).json({ error: { code: 'IDEMPOTENCY_KEY_INVALID', message: 'Invalid idempotency key.' } });
      }
      const db = getFirestoreInstance();
      if (!db) return res.status(503).json({ error: { code: 'FIRESTORE_UNAVAILABLE', message: 'Firestore unavailable.' } });
      const idemSnap = await db.collection(IDEMPOTENCY_COLLECTION).doc(sha256(key)).get();
      if (!idemSnap.exists) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'No task exists for this idempotency key yet.' } });
      const taskId = String(idemSnap.data()?.taskId || '');
      if (!taskId) return res.status(500).json({ error: { code: 'IDEMPOTENCY_RECORD_INVALID', message: 'Idempotency record has no taskId.' } });
      const taskSnap = await db.collection(TASK_COLLECTION).doc(taskId).get();
      if (!taskSnap.exists) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task record is missing.' } });
      return res.json(publicTask(taskSnap.data() as MvpVideoTask));
    } catch (error: any) {
      return res.status(500).json({ error: { code: 'LOOKUP_FAILED', message: String(error?.message || error) } });
    }
  });

  const previousVitest = process.env.VITEST;
  process.env.VITEST = 'mvp-v021-wrapper';
  const legacyModule = await import('./mvp-server-v02');
  if (previousVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = previousVitest;
  const legacyApp = await legacyModule.createMvpAppV02();
  app.use(legacyApp);
  return app;
}

export async function startMvpServerV021() {
  const app = await createMvpAppV021();
  return app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MVP_IDENTITY_SAFE_V021] listening on :${PORT}; client=${CLIENT_VERSION}`);
  });
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) void startMvpServerV021();
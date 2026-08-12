import { z } from 'zod';

export type ComputeConnectionType = 'vertex_ai' | 'gemini_api_key' | 'server_env_secret';

export interface SavedComputeConfig {
  id: string;
  activeTab: ComputeConnectionType;
  projectId?: string;
  location?: string;
  serviceAccountJson?: string;
  apiKey?: string;
  analysisModel?: string;
  imageModel?: string;
  videoModel?: string;
  updatedAt: number;
  autoConnect?: boolean;
}

export type CredentialSourceType = 'SERVICE_ACCOUNT' | 'ADC' | 'GEMINI_API_KEY' | 'SERVER_ENV_SECRET';

export interface ComputeConnectionInfo {
  connectionId: string;
  type: ComputeConnectionType;
  credentialSource: CredentialSourceType;
  projectId?: string;
  location?: string;
  region?: string;
  requestedModel: string;
  actualModel: string;
  analysisModel: string;
  imageModel: string;
  videoModel: string;
  serviceAccountEmail?: string;
  apiKeyMasked?: string;
  hasServerSecret: boolean;
  createdAt: number;
  expiresAt: number;
}

export type AngleTag =
  | 'front'
  | 'left_45'
  | 'right_45'
  | 'profile'
  | 'half_body'
  | 'full_body'
  | 'expression'
  | 'other';

export interface LockedTrait {
  traitName: string;
  expectedValue: string;
  sourceText: string;
}

export interface CharacterReference {
  id: string;
  blob: Blob;
  originalBlob?: Blob;
  thumbnailUrl?: string;
  dataUrl?: string; // transient for UI
  mimeType: string;
  width: number;
  height: number;
  angle?: AngleTag | string;
  qualityScore?: number;
  qualityIssues?: string[];
  sortOrder?: number;
}

export interface IdentitySpec {
  lockedTraits: LockedTrait[];
  adultStatus?: 'confirmed_adult' | 'unconfirmed';
  faceShape?: string;
  facialFeatures?: string;
  eyeShapeAndColor?: string;
  skinToneAndTexture?: string;
  hairColorLengthStyle?: string;
  bodyProportions?: string;
  signatureAccessories?: string;
  defaultTemperament?: string;
  immutableTraits?: string[];
  forbiddenChanges?: string[];
  identityLockPromptEnglish?: string;
  identityLockPromptChinese?: string;
}

export type CharacterStatus = 'draft' | 'analyzing' | 'ready' | 'error';

export interface CharacterProfile {
  id: string;
  name: string;
  description: string;
  adultConfirmed?: boolean;
  rightsConfirmed?: boolean;
  status: CharacterStatus;
  identitySpec: IdentitySpec;
  referenceImages: CharacterReference[];
  selectedImageReferenceIds?: string[]; // up to 4
  selectedVideoReferenceIds?: string[]; // up to 3
  createdAt?: number;
  updatedAt: string | number;
  analysisError?: string;
}

export type SceneMode =
  | 'replace_primary_person'
  | 'animate_existing_character'
  | 'add_character_to_empty_scene';

export interface SceneCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
}

export interface StructuredSceneAnalysis {
  hasPerson: boolean;
  personCount: number;
  primaryPersonLocation: string;
  headAngleAndGaze: string;
  poseAndLimbOcclusion: string;
  outfitAndAccessories: string;
  props: string;
  background: string;
  lightingAndColorTemp: string;
  cameraSettings: string;
  suitableFor8sMotion: boolean;
  motionRisks: string[];
  recommendedSceneMode: SceneMode;
}

export interface StructuredPromptScript {
  subjectAction: string;
  facialExpression: string;
  gaze: string;
  handAction: string;
  bodyMotion: string;
  cameraMotion: string;
  environmentMotion: string;
  lighting: string;
  audio: string;
  timeline: Array<{ timeRange: string; description: string }>;
  negativeConstraints: string[];
  primaryVisualStyle: string;
  secondaryVisualStyle: string;
  styleStrength: number;
}

export type FailureReason =
  | 'input_safety_blocked'
  | 'output_rai_filtered'
  | 'upstream_empty_response'
  | 'artifact_missing'
  | 'artifact_fetch_failed'
  | 'artifact_persist_failed'
  | 'artifact_invalid'
  | 'legacy_invalid_artifact'
  | 'network_fetch_failed'
  | 'polling_timeout'
  | 'authentication_failed'
  | 'quota_or_rate_limited'
  | 'upstream_failed'
  | 'unknown';

export type RetryMode =
  | 'NO_RETRY'
  | 'RETRY_POLL'
  | 'RETRY_DOWNLOAD'
  | 'REWRITE_INPUT_THEN_REGENERATE'
  | 'SAFE_TO_REGENERATE';

export type TaskStatus =
  | 'draft'
  | 'local_draft'
  | 'submitting'
  | 'submitted'
  | 'polling'
  | 'polling_timeout'
  | 'validating'
  | 'analyzing_scene'
  | 'normalizing_prompt'
  | 'generating_first_frame'
  | 'qa_first_frame'
  | 'waiting_first_frame_approval'
  | 'starting_video'
  | 'polling_video'
  | 'downloading_video'
  | 'validating_video'
  | 'extracting_frames'
  | 'qa_video'
  | 'repairing'
  | 'completed'
  | 'completed_with_warning'
  | 'failed'
  | 'canceled'
  | 'cancelled'
  | 'orphaned_local_task'
  | 'submit_failed_safe_to_retry'
  | 'submission_outcome_unknown'
  | 'artifact_persist_failed'
  | 'artifact_missing'
  | 'artifact_fetch_failed';

export type AuditTaskStatus =
  | 'validating'
  | 'submitting'
  | 'polling'
  | 'polling_timeout'
  | 'completed'
  | 'failed'
  | 'submission_outcome_unknown'
  | 'orphaned_local_task';

export type TaskSubmissionState =
  | 'reserved'
  | 'submitting'
  | 'submitted'
  | 'outcome_unknown'
  | 'not_submitted';

export interface GenerationConfig {
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  sampleCount: number;
  generateAudio: boolean;
  modelId: string;
}

export interface ServerVideoTaskRecord {
  id: string;
  taskId: string;
  operationName?: string;
  status: TaskStatus;
  statusVersion?: number;
  modelId: string;
  projectId: string;
  region: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  generateAudio: boolean;
  firstFrameHash?: string;
  promptHash?: string;
  submitHttpStatus?: number | null;
  pollHttpStatus?: number | null;
  pollAttempt: number;
  lastPolledAt?: number | null;
  lastSubmitAttemptAt?: number | null;
  submitTimedOutAt?: number | null;
  outputUri?: string;
  videoUri?: string;
  videoBase64?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  idempotencyKey?: string;
  rawUserPrompt?: string;
  compiledPrompt?: string;
  veoSafePrompt?: string;
  promptCompilerVersion?: string;
  failureReason?: FailureReason;
  retryMode?: RetryMode;
  motionIntensity?: string;
  visualStyle?: string;
  cameraPreset?: string;
  schemaVersion?: string;

  connectionId?: string;
  characterId?: string;
  characterName?: string;
  identitySpec?: any;
  sceneImageUrl?: string;
  videoDataUrl?: string;
  sizeBytes?: number;
  outputBucket?: string;
  outputObjectPath?: string;
  contentType?: string;
  artifactPersisted?: boolean;
  artifactPersistedAt?: number;
  sceneMode?: string;
  retryCount?: number;
  attempts?: AttemptRecord[];
  diagnostics?: any;
  qaReport?: any;
  structuredError?: any;

  upstreamEndpoint?: string | null;
  upstreamHttpStatus?: number | null;
  upstreamErrorCode?: string | null;
  upstreamErrorMessage?: string | null;
  raiMediaFilteredCount?: number | null;
  raiMediaFilteredReasons?: string[] | null;
  raiStatus?: 'unknown' | 'passed' | 'filtered' | 'flagged' | 'not_filtered';
  evidenceSource?: 'firestore' | 'server_memory' | 'indexeddb' | 'test_fixture' | 'mock_data' | 'non_production';
}

export interface FirstFrameCandidate {
  id: string;
  blob: Blob;
  dataUrl?: string;
  width: number;
  height: number;
  mimeType: string;
  createdAt: number;
  qaReport?: FirstFrameQaReport;
}

export interface FirstFrameQaReport {
  pass: boolean;
  identityScore: number;
  sourcePersonResidualScore: number;
  scenePreservationScore: number;
  posePreservationScore: number;
  outfitPreservationScore: number;
  anatomyScore: number;
  faceDetails: string;
  hairDetails: string;
  bodyDetails: string;
  issues: Array<{
    code: string;
    severity: 'critical' | 'major' | 'minor';
    description: string;
    repairInstruction: string;
  }>;
  summary: string;
}

export interface VideoFrameQaItem {
  timestampSec: number;
  frameIndex: number;
  blob?: Blob;
  dataUrl?: string;
  identityScore: number;
  qualityScore: number;
  notes: string;
}

export interface VideoQaReport {
  pass: boolean;
  averageIdentityScore: number;
  minimumIdentityScore: number;
  temporalConsistencyScore: number;
  motionNaturalnessScore: number;
  anatomyScore: number;
  sceneContinuityScore: number;
  promptComplianceScore: number;
  frameReports: VideoFrameQaItem[];
  criticalIssues: string[];
  repairInstruction: string;
  summary: string;
}

export interface ImageDiagnosticInfo {
  role: string;
  hash: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  mimeType: string;
}

export interface VideoGenerationDiagnostics {
  firstFrame: ImageDiagnosticInfo;
  masterImages: ImageDiagnosticInfo[];
  inputImages: ImageDiagnosticInfo[];
  fullPrompt: string;
  videoModel: string;
  useReferenceImages: boolean;
  engine: 'omni_flash' | 'veo_31';
  timestamp: number;
}

export interface AttemptRecord {
  attemptIndex: number;
  actionType: 'first_frame' | 'first_frame_repair' | 'video_start' | 'video_repair';
  model: string;
  startTime: number;
  endTime: number;
  success: boolean;
  errorCodeRedacted?: string;
  qaScore?: number;
  triggeredRetry: boolean;
  notes: string;
}

export interface VideoResult {
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  frameDataUrls?: string[];
  diagnostics?: VideoGenerationDiagnostics;
}

export interface TaskSettings {
  aspectRatio: '9:16'; // default 9:16
  durationSeconds: number; // default 6
  resolution: '720p' | '1080p'; // default 1080p
  fps: 24;            // default 24
  pauseForFirstFrameApproval: boolean;
  primaryStyle: string;
  secondaryStyle: string;
  styleStrength: number;
  advancedModelConfig?: {
    analysisModel?: string;
    imageModel?: string;
    videoModel?: string;
  };
}

export interface GenerationTask {
  id: string;
  characterId: string;
  characterName?: string;
  sceneImageBlob: Blob;
  sceneImageDataUrl?: string;
  sceneCrop: SceneCrop;
  sceneMode: SceneMode;
  sceneAnalysis?: StructuredSceneAnalysis;
  userPromptChinese: string;
  normalizedPromptEnglish: string;
  veoSafePrompt?: string;
  failureReason?: FailureReason;
  retryMode?: RetryMode;
  raiMediaFilteredCount?: number | null;
  raiMediaFilteredReasons?: string[] | null;
  raiStatus?: 'unknown' | 'passed' | 'filtered' | 'flagged' | 'not_filtered';
  promptScript?: StructuredPromptScript;
  settings: TaskSettings;
  status: TaskStatus;
  progressStage: string;
  progressPercent: number;
  firstFrameCandidates: FirstFrameCandidate[];
  selectedFirstFrameId?: string;
  externalOperationName?: string;
  previousInteractionId?: string;
  videoResult?: VideoResult;
  resultVideoUrl?: string;
  videoUri?: string;
  outputUri?: string;
  projectId?: string;
  region?: string;
  sceneImageUrl?: string;
  qaReport?: VideoQaReport;
  retryCount: number;
  attempts: AttemptRecord[];
  error?: UnifiedError;
  createdAt: number;
  updatedAt: number;
}

export type ErrorSource =
  | 'vertex_submit'
  | 'vertex_polling'
  | 'output_download'
  | 'artifact_persist'
  | 'character_api'
  | 'internal_api'
  | 'authentication'
  | 'unknown';

export type ErrorFailureStage =
  | 'submit'
  | 'polling'
  | 'output_download'
  | 'artifact_persist'
  | 'internal_api';

export interface StructuredErrorResponse {
  errorId: string;
  source: ErrorSource;
  failureStage: ErrorFailureStage;
  failureReason?: FailureReason;
  retryMode?: RetryMode;
  httpStatus: number | null;
  appHttpStatus?: number | null;
  upstreamHttpStatus?: number | null;
  googleStatus: string | null;
  googleReason: string | null;
  technicalMessageRedacted: string;
  userMessage: string;
  endpointHost: string | null;
  endpointPathRedacted: string | null;
  requestId: string | null;
  traceId: string | null;
  taskId: string | null;
  revision: string | null;
  buildVersion?: string;
  actualModel?: string;
  projectId?: string;
  region?: string;
  error?: string;
}

export interface UnifiedError {
  errorId?: string;
  code: string;
  stage: string;
  messageChinese: string;
  technicalMessageRedacted: string;
  httpStatus: number | null;
  appHttpStatus?: number | null;
  upstreamHttpStatus?: number | null;
  providerStatus?: string;
  googleStatus?: string | null;
  googleReason?: string | null;
  retryable: boolean;
  recommendedAction: string;
  supportCode?: string;
  source?: ErrorSource;
  failureStage?: ErrorFailureStage;
  failureReason?: FailureReason;
  retryMode?: RetryMode;
  userMessage?: string;
  endpointHost?: string | null;
  endpointPathRedacted?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  taskId?: string | null;
  revision?: string | null;
  buildVersion?: string;
  actualModel?: string;
  projectId?: string;
  region?: string;
}

// Zod Schemas for API Input Validation
export const ServiceAccountJsonSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  private_key_id: z.string().optional(),
  private_key: z.string().min(1),
  client_email: z.string().email(),
  client_id: z.string().optional(),
  auth_uri: z.string().optional(),
  token_uri: z.string().url(),
  auth_provider_x509_cert_url: z.string().optional(),
  client_x509_cert_url: z.string().optional(),
});

export const ConnectApiKeySchema = z.object({
  apiKey: z.string().min(10),
  analysisModel: z.string().default('gemini-3.6-flash'),
  imageModel: z.string().default('gemini-3.1-flash-image'),
  videoModel: z.string().default('gemini-omni-flash-preview'),
});

export const ConnectServiceAccountSchema = z.object({
  projectId: z.string().min(1),
  location: z.string().default('global'),
  analysisModel: z.string().default('gemini-3.6-flash'),
  imageModel: z.string().default('gemini-3.1-flash-image'),
  videoModel: z.string().default('gemini-omni-flash-preview'),
  serviceAccountJson: z.string().min(1),
});

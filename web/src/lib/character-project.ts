import type { StoredWorkflow } from "@/lib/workflow-contract";

export const CHARACTER_PROJECT_TARGETS = ["sd15", "sdxl", "flux_rank64", "flux_rank128"] as const;
export type CharacterProjectTarget = (typeof CHARACTER_PROJECT_TARGETS)[number];

export interface CharacterViewPreset {
  id: string;
  label: string;
  description: string;
  horizontalAngle: number;
  verticalAngle: number;
  zoom: number;
  bucket: "close" | "half" | "full" | "side";
  defaultSelected?: boolean;
}

export const CHARACTER_VIEW_PRESETS: CharacterViewPreset[] = [
  { id: "front-close", label: "正面特写", description: "补充清晰面部细节", horizontalAngle: 0, verticalAngle: 0, zoom: 8, bucket: "close" },
  { id: "front-medium", label: "正面半身", description: "稳定的正面中景", horizontalAngle: 0, verticalAngle: 0, zoom: 4, bucket: "half" },
  { id: "right-front", label: "右前侧", description: "右侧四分之三视角", horizontalAngle: 45, verticalAngle: 0, zoom: 4, bucket: "half", defaultSelected: true },
  { id: "right-side", label: "右侧面", description: "标准右侧轮廓", horizontalAngle: 90, verticalAngle: 0, zoom: 4, bucket: "side", defaultSelected: true },
  { id: "left-side", label: "左侧面", description: "标准左侧轮廓", horizontalAngle: 270, verticalAngle: 0, zoom: 4, bucket: "side", defaultSelected: true },
  { id: "left-front", label: "左前侧", description: "左侧四分之三视角", horizontalAngle: 315, verticalAngle: 0, zoom: 4, bucket: "half", defaultSelected: true },
  { id: "front-wide", label: "正面远景", description: "补充全身与服装信息", horizontalAngle: 0, verticalAngle: 0, zoom: 1, bucket: "full" },
  { id: "front-high", label: "正面俯拍", description: "补充高位镜头变化", horizontalAngle: 0, verticalAngle: 60, zoom: 4, bucket: "half" },
];

export type CharacterViewStatus = "queued" | "processing" | "succeeded" | "failed";
export type CandidateReviewStatus = "pending" | "accepted" | "rejected";
export type CharacterAnalysisStatus = "idle" | "waiting-agent" | "queued" | "running" | "succeeded" | "failed";

export interface CharacterCandidateQuality {
  kept?: boolean;
  reasons?: string[];
  sharpness?: number;
  brightness?: number;
  faceRatio?: number;
  similarity?: number | null;
  yaw?: number | null;
  bucket?: string;
}

export interface CharacterCandidate {
  id: string;
  batchId: string;
  viewId: string;
  viewLabel: string;
  relativePath: string;
  filename: string;
  mediaType: string;
  bytes: number;
  horizontalAngle: number;
  verticalAngle: number;
  zoom: number;
  modalJobId: string;
  workflowId: string;
  workflowRevisionId: string;
  reviewStatus: CandidateReviewStatus;
  quality?: CharacterCandidateQuality;
  createdAt: number;
}

export interface CharacterGenerationView extends CharacterViewPreset {
  status: CharacterViewStatus;
  modalJobId?: string;
  message?: string;
  candidateIds: string[];
}

export interface CharacterBatchAnalysis {
  status: CharacterAnalysisStatus;
  jobId?: string;
  message?: string;
  progress?: number;
  lastAttemptAt?: number;
  report?: Record<string, unknown>;
}

export interface CharacterGenerationBatch {
  id: string;
  workflowId: string;
  workflowRevisionId: string;
  workflowName: string;
  status: "queued" | "generating" | "analyzing" | "succeeded" | "partial" | "failed";
  views: CharacterGenerationView[];
  analysis: CharacterBatchAnalysis;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterProject {
  id: string;
  name: string;
  triggerWord: string;
  target: CharacterProjectTarget;
  referenceFilename: string;
  referenceMediaType: string;
  referenceBytes: number;
  batches: CharacterGenerationBatch[];
  candidates: CharacterCandidate[];
  createdAt: number;
  updatedAt: number;
}

export function characterWorkflowCompatible(workflow: StoredWorkflow) {
  const controls = new Set(workflow.parameterInputs.map((item) => item.inputName));
  return workflow.status === "ready"
    && workflow.imageInputs.length === 1
    && controls.has("horizontal_angle")
    && controls.has("vertical_angle")
    && controls.has("zoom");
}

export function selectedViewPresets(ids: string[]) {
  const requested = new Set(ids);
  return CHARACTER_VIEW_PRESETS.filter((preset) => requested.has(preset.id));
}

export function defaultCharacterViewIds() {
  return CHARACTER_VIEW_PRESETS.filter((preset) => preset.defaultSelected).map((preset) => preset.id);
}

export function characterProjectActive(project?: CharacterProject) {
  return project?.batches.some((batch) => ["queued", "generating", "analyzing"].includes(batch.status)) ?? false;
}

export function nextCharacterGenerationProjectId(projects: CharacterProject[]) {
  const batches = projects.flatMap((project) => project.batches
    .filter((batch) => ["queued", "generating", "analyzing"].includes(batch.status))
    .map((batch) => ({ projectId: project.id, batch })));
  const processing = batches
    .filter(({ batch }) => batch.views.some((view) => view.status === "processing"))
    .sort((left, right) => left.batch.createdAt - right.batch.createdAt);
  if (processing[0]) return processing[0].projectId;
  return batches
    .filter(({ batch }) => batch.views.some((view) => view.status === "queued"))
    .sort((left, right) => left.batch.createdAt - right.batch.createdAt)[0]?.projectId;
}

export function characterBatchStatus(batch: CharacterGenerationBatch): CharacterGenerationBatch["status"] {
  const completed = batch.views.filter((view) => view.status === "succeeded").length;
  const failed = batch.views.filter((view) => view.status === "failed").length;
  const active = batch.views.some((view) => view.status === "processing");
  const queued = batch.views.some((view) => view.status === "queued");

  if (active || queued) return active ? "generating" : "queued";
  if (!completed) return "failed";
  if (batch.analysis.status === "succeeded") return failed ? "partial" : "succeeded";
  if (batch.analysis.status === "failed") return "partial";
  return "analyzing";
}

export function cameraParameterValues(workflow: StoredWorkflow, view: CharacterViewPreset) {
  const overrides: Record<string, number> = {
    horizontal_angle: view.horizontalAngle,
    vertical_angle: view.verticalAngle,
    zoom: view.zoom,
  };
  return Object.fromEntries(
    workflow.parameterInputs.map((item) => [item.fieldName, String(overrides[item.inputName] ?? item.currentValue)]),
  );
}

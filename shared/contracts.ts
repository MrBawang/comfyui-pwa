export type ChatMode = "chat" | "prompt";
export type ProviderId = "workers-ai" | "modal-qwen36";

export interface SystemPromptPreset {
  id: string;
  name: string;
  scope: "chat" | "prompt" | "workflow";
  workflowId?: string;
  content: string;
  version: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChatThread {
  id: string;
  title: string;
  mode: ChatMode;
  providerId: ProviderId;
  workflowId?: string;
  workflowRevisionId?: string;
  targetFieldName?: string;
  systemPromptPresetId?: string;
  systemPromptVersion?: number;
  systemPromptOverride?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  providerId?: ProviderId;
  createdAt: number;
}

export type ChatOperationStatus =
  | "queued"
  | "submitting"
  | "warming"
  | "generating"
  | "completed"
  | "failed"
  | "needs-human"
  | "cancelled";

export interface ChatOperation {
  id: string;
  threadId: string;
  status: ChatOperationStatus;
  message?: string;
  assistantMessage?: ChatMessage;
  createdAt: number;
  updatedAt: number;
}

export interface RunSummary {
  id: string;
  kind: "workflow" | "character" | "image";
  status: "queued" | "uploading" | "processing" | "succeeded" | "failed" | "cancelled";
  workflowId: string;
  workflowRevisionId?: string;
  workflowName?: string;
  message?: string;
  modalJobId?: string;
  outputs?: RunOutput[];
  createdAt: number;
  updatedAt: number;
}

export interface RunOutput {
  id: string;
  runId: string;
  objectKey: string;
  filename: string;
  mediaType: string;
  bytes: number;
  url: string;
}

export interface AgentTaskManifest {
  taskId: string;
  leaseToken: string;
  leaseExpiresAt: number;
  project: {
    id: string;
    name: string;
    triggerWord: string;
    target: string;
    referenceUrl: string;
  };
  batchId: string;
  candidates: Array<{
    id: string;
    filename: string;
    url: string;
  }>;
  settings: {
    size: number;
    identityThreshold: number;
    curateCrops: boolean;
    pack: boolean;
  };
}

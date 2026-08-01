export interface WorkflowModel {
  category: string;
  filename: string;
  status: "present" | "missing" | "unknown";
  nodes: Array<{ nodeId: string; input: string }>;
  source?: {
    kind: "huggingface";
    repoId: string;
    repoFile: string;
    revision: string;
    origin: "workflow-metadata";
  };
}

export interface ModelBinding {
  category: string;
  expectedFilename: string;
  actualFilename: string;
}

export interface ModelAsset {
  category: string;
  filename: string;
  bytes: number;
  modifiedAt: number;
  source?: {
    sourceKind?: "huggingface" | "url" | "unknown";
    repoId?: string;
    repoFile?: string;
    sourceUrl?: string;
    sha256?: string;
  };
}

export interface WorkflowImageInput {
  nodeId: string;
  classType: string;
  inputName: string;
  currentFilename: string;
  fieldName: string;
  folder: "input" | "output" | "temp";
}

export interface WorkflowTextInput {
  nodeId: string;
  classType: string;
  inputName: string;
  fieldName: string;
  label: string;
  currentValue: string;
  multiline: boolean;
}

export interface WorkflowParameterInput {
  nodeId: string;
  classType: string;
  inputName: string;
  fieldName: string;
  label: string;
  kind: "integer" | "number" | "boolean";
  currentValue: number | boolean;
  minimum?: number;
  maximum?: number;
  step?: number;
  semantic?: "video-duration";
  unit?: string;
  framesPerSecond?: number;
  frameStep?: number;
  frameOffset?: number;
  minimumFrames?: number;
  maximumFrames?: number;
}

export interface WorkflowUnsupportedInput {
  nodeId: string;
  classType: string;
  inputName: string;
  value: unknown;
  availableValues: unknown[];
  availableValueCount: number;
}

export interface WorkflowCompatibilityAdjustment {
  code: string;
  nodeId: string;
  classType: string;
  message: string;
}

export interface WorkflowVariant {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  imageInputs: WorkflowImageInput[];
  textInputs: WorkflowTextInput[];
  parameterInputs: WorkflowParameterInput[];
  outputNodes: string[];
}

export type MissingNodePackage = {
  kind: "registry";
  registryId: string;
  name: string;
  repository: string;
  version?: string;
  sourceRevision?: string;
  nodeTypes: string[];
} | {
  kind: "core";
  name: string;
  repository: string;
  nodeTypes: string[];
};

export interface MissingPythonRuntimePackage {
  kind: "python";
  packageId: string;
  name: string;
  version: string;
  nodeTypes: string[];
}

export type MissingRuntimePackage = MissingNodePackage | MissingPythonRuntimePackage;

export interface SuggestedNodePackage {
  kind: "registry";
  registryId: string;
  name: string;
  repository: string;
  version?: string;
  sourceRevision?: string;
  nodeTypes: string[];
  confidence: "low";
  source: "node-name-heuristic" | "ambiguous-manager-map" | "workflow-metadata-conflict";
}

export interface WorkflowAnalysis {
  format: "comfyui-api" | "comfyui-canvas";
  conversionStatus?: "ready" | "blocked";
  convertedFromCanvas?: boolean;
  nodeCount: number;
  nodeTypes: string[];
  missingNodes: string[];
  missingNodePackages?: MissingNodePackage[];
  suggestedNodePackages?: SuggestedNodePackage[];
  unresolvedNodes?: string[];
  unsupportedInputs?: WorkflowUnsupportedInput[];
  missingRuntimePackages?: MissingRuntimePackage[];
  nodePackageLookupStatus?: "ready" | "failed";
  nodePackageLookupMessage?: string;
  models: WorkflowModel[];
  imageInputs: WorkflowImageInput[];
  textInputs: WorkflowTextInput[];
  parameterInputs: WorkflowParameterInput[];
  outputNodes: string[];
  compatibilityAdjustments?: WorkflowCompatibilityAdjustment[];
  variants?: WorkflowVariant[];
  issues: string[];
  runnable: boolean;
  assetVersion: string;
  runtimeRevision?: string;
  schemaSource?: "cache" | "comfyui-cpu";
  canRollbackRuntime?: boolean;
}

export type StoredWorkflowStatus = "ready" | "stale" | "archived";

export interface StoredWorkflow {
  id: string;
  revisionId: string;
  name: string;
  status: StoredWorkflowStatus;
  statusMessage?: string;
  sourceFilename: string;
  sourceFormat: "comfyui-api" | "comfyui-canvas";
  nodeCount: number;
  nodeTypes: string[];
  models: WorkflowModel[];
  imageInputs: WorkflowImageInput[];
  textInputs: WorkflowTextInput[];
  parameterInputs: WorkflowParameterInput[];
  outputNodes: string[];
  variants: WorkflowVariant[];
  compatibilityAdjustments: WorkflowCompatibilityAdjustment[];
  runtimeRevision: string;
  assetVersion: string;
  validationVersion?: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobOutput {
  index: number;
  filename: string;
  mediaType: string;
  bytes: number;
  url: string;
}

export type JobStatus = "uploading" | "processing" | "succeeded" | "failed" | "cancelled";

export interface JobResponse {
  jobId: string;
  status: JobStatus;
  message?: string;
  resultUrl?: string;
  outputs?: JobOutput[];
  assetVersion?: string;
  workflowId?: string;
  workflowRevisionId?: string;
  workflowName?: string;
  workflowVariantId?: string;
  workflowVariantName?: string;
}

export interface ResourceJobResponse {
  jobId: string;
  status: "processing" | "succeeded" | "failed";
  message?: string;
  assetVersion?: string;
}

const modelInputs: Record<string, string> = {
  ckpt_name: "checkpoints",
  control_net_name: "controlnet",
  vae_name: "vae",
  lora_name: "loras",
  unet_name: "diffusion_models",
  clip_name: "clip",
  clip_name1: "clip",
  clip_name2: "clip",
  clip_name3: "clip",
  style_model_name: "style_models",
  gligen_name: "gligen",
  upscale_model: "upscale_models",
};

export function analyzeWorkflowLocally(raw: unknown): WorkflowAnalysis {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("工作流必须是 JSON 对象");
  }
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.nodes)) {
    throw new Error("普通 Canvas Workflow 需要连接 Modal 才能转换");
  }

  const nodeTypes = new Set<string>();
  const models = new Map<string, WorkflowModel>();
  const imageInputs: WorkflowImageInput[] = [];
  const textInputs: WorkflowTextInput[] = [];
  const outputNodes: string[] = [];

  for (const [nodeId, value] of Object.entries(record)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`节点 ${nodeId} 格式不正确`);
    }
    const node = value as Record<string, unknown>;
    const classType = node.class_type;
    const inputs = node.inputs;
    if (typeof classType !== "string" || !inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      throw new Error(`节点 ${nodeId} 缺少 class_type 或 inputs`);
    }
    nodeTypes.add(classType);
    const inputRecord = inputs as Record<string, unknown>;

    if ((classType === "LoadImage" || classType === "LoadImageMask") && typeof inputRecord.image === "string") {
      imageInputs.push({
        nodeId,
        classType,
        inputName: "image",
        currentFilename: inputRecord.image,
        fieldName: `asset_${nodeId}_image`,
        folder: "input",
      });
    }
    if (classType === "SaveImage") outputNodes.push(nodeId);
    if (
      classType.toLowerCase().includes("clip")
      && typeof inputRecord.text === "string"
    ) {
      textInputs.push({
        nodeId,
        classType,
        inputName: "text",
        fieldName: `param_${nodeId}_text`,
        label: "提示词",
        currentValue: inputRecord.text,
        multiline: true,
      });
    }

    for (const [input, category] of Object.entries(modelInputs)) {
      const filename = inputRecord[input];
      if (typeof filename !== "string") continue;
      const key = `${category}\0${filename}`;
      const item = models.get(key) ?? { category, filename, status: "unknown" as const, nodes: [] };
      item.nodes.push({ nodeId, input });
      models.set(key, item);
    }
  }

  const issues = outputNodes.length ? [] : ["工作流没有可执行的文件输出节点"];
  return {
    format: "comfyui-api",
    nodeCount: Object.keys(record).length,
    nodeTypes: [...nodeTypes].sort(),
    missingNodes: [],
    models: [...models.values()],
    imageInputs,
    textInputs,
    parameterInputs: [],
    outputNodes,
    variants: [],
    issues,
    runnable: issues.length === 0,
    assetVersion: "local-demo",
  };
}

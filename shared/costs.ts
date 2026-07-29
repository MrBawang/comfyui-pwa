export const COST_ACTIONS = [
  "workflow-analyze",
  "workflow-convert",
  "workflow-import",
  "workflow-sync",
  "workflow-run",
  "character-batch",
  "model-download",
  "node-package-install",
  "python-package-install",
  "runtime-rollback",
  "modal-chat",
  "llm-model-download",
  "llm-benchmark",
  "wisart-image",
] as const;

export type CostAction = (typeof COST_ACTIONS)[number];

export interface CostDescriptor {
  action: CostAction;
  target: string;
  fileBytes: number;
  batchCount: number;
}

export interface CostQuote extends CostDescriptor {
  id: string;
  label: string;
  description: string;
  maxDurationSeconds: number;
  estimatedMaxUsd: number;
  quoteExpiresAt: number;
  status: "pending" | "approved" | "consumed" | "expired";
}

function parts(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim() || "default").join(":");
}

export const costTargets = {
  workflowFile(filename: string) {
    return parts("file", filename);
  },
  storedWorkflow(workflowId: string) {
    return parts("workflow", workflowId);
  },
  workflowCatalog() {
    return "workflow:catalog";
  },
  workflowRun(workflowId: string, variantId?: string) {
    return parts("workflow", workflowId, variantId);
  },
  characterBatch(projectId: string, workflowId: string) {
    return parts("project", projectId, "workflow", workflowId);
  },
  model(repoId: string, repoFile: string, revision: string, category: string, filename: string) {
    return parts("model", repoId, repoFile, revision, category, filename);
  },
  nodePackage(registryId?: string, sourceRepository?: string, sourceRevision?: string) {
    return parts("node", registryId || sourceRepository, sourceRevision);
  },
  pythonPackage(packageId: string) {
    return parts("python", packageId);
  },
  runtimeRollback() {
    return "runtime:previous";
  },
  modalChat(threadId: string) {
    return parts("chat", threadId);
  },
  wisartImage(mode: "generate" | "edit", model: string, size: string, quality: string, n: number) {
    return parts("wisart", mode, model, size, quality, String(n));
  },
};

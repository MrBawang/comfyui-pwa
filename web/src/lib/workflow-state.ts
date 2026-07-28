export function createLatestRequestGuard() {
  let latestRequestId = 0;

  return {
    begin() {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent(requestId: number) {
      return requestId === latestRequestId;
    },
  };
}

export function reconcileWorkflowImageFiles<T>(
  files: Record<string, T>,
  currentFieldNames: readonly string[],
) {
  const currentFields = new Set(currentFieldNames);
  const entries = Object.entries(files).filter(([fieldName]) => currentFields.has(fieldName));
  return entries.length === Object.keys(files).length ? files : Object.fromEntries(entries);
}

export function isTerminalJobStatus(status: string) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export interface ActiveRunJob {
  jobId: string;
  workflowId?: string;
  variantId?: string;
  textValues: Record<string, string>;
  parameterValues: Record<string, string>;
}

export function serializeActiveRunJob(job: ActiveRunJob) {
  return JSON.stringify(job);
}

export function parseActiveRunJob(raw: string | null): ActiveRunJob | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("{")) {
    return { jobId: raw, textValues: {}, parameterValues: {} };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.jobId !== "string" || !record.jobId) return undefined;
    const rawTextValues = record.textValues;
    const textValues = rawTextValues && typeof rawTextValues === "object" && !Array.isArray(rawTextValues)
      ? Object.fromEntries(
        Object.entries(rawTextValues).filter(
          ([fieldName, fieldValue]) => fieldName.startsWith("param_") && typeof fieldValue === "string",
        ),
      )
      : {};
    const rawParameterValues = record.parameterValues;
    const parameterValues = rawParameterValues && typeof rawParameterValues === "object" && !Array.isArray(rawParameterValues)
      ? Object.fromEntries(
        Object.entries(rawParameterValues).filter(
          ([fieldName, fieldValue]) => fieldName.startsWith("control_") && typeof fieldValue === "string",
        ),
      )
      : {};
    return {
      jobId: record.jobId,
      workflowId: typeof record.workflowId === "string" ? record.workflowId : undefined,
      variantId: typeof record.variantId === "string" ? record.variantId : undefined,
      textValues,
      parameterValues,
    };
  } catch {
    return undefined;
  }
}

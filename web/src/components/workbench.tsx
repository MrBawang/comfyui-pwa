import { Link } from "react-router-dom";
import { Check as CheckIcon, Download as DownloadIcon, RefreshCw, Upload as UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { costTargets } from "@shared/costs";
import { AppHeader } from "@/components/app-header";
import { costHeaders, useCostApproval } from "@/lib/cost-approval";
import type {
  MissingNodePackage,
  MissingPythonRuntimePackage,
  ResourceJobResponse,
  SuggestedNodePackage,
  StoredWorkflow,
  WorkflowAnalysis,
  WorkflowModel,
  WorkflowUnsupportedInput,
} from "@/lib/workflow-contract";
import { createLatestRequestGuard } from "@/lib/workflow-state";

const RESOURCE_JOB_STORAGE_KEY = "comfy-desk.pending-resource-job";
const RESOURCE_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1_000 + 10 * 60 * 1_000;
const ANALYSIS_TIMEOUT_MS = 6 * 60 * 1_000;

function availableValuesSummary(item: WorkflowUnsupportedInput) {
  const values = item.availableValues.slice(0, 5).map(String).join("、");
  const remaining = Math.max(0, item.availableValueCount - item.availableValues.slice(0, 5).length);
  return `${values}${remaining ? `，另有 ${remaining} 项` : ""}`;
}

interface PendingResourceJob {
  jobId: string;
  key: string;
  workflowId?: string;
  workflowName?: string;
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("资源任务轮询已取消", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("资源任务轮询已取消", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function WorkflowDrop({ file, busy, busyLabel, onFile }: { file?: File; busy: boolean; busyLabel?: string; onFile: (file: File) => void }) {
  return (
    <label
      className={`workflow-drop ${file ? "workflow-drop--ready" : ""} ${busy ? "workflow-drop--busy" : ""}`}
      aria-disabled={busy}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (busy) return;
        const dropped = event.dataTransfer.files[0];
        if (dropped) onFile(dropped);
      }}
    >
      <input type="file" accept="application/json,image/png,image/webp,.json,.png,.webp" disabled={busy} onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])} />
      <span className="workflow-drop__icon">{busy ? <span className="mini-spinner" /> : file ? <CheckIcon size={15} /> : <UploadIcon size={18} />}</span>
      <span className="workflow-drop__copy">
        <strong>{file ? file.name : "上传 ComfyUI Workflow"}</strong>
        <span>{busy ? busyLabel ?? "正在处理" : file ? `${(file.size / 1024).toFixed(1)} KB · 点击替换` : "拖放 Canvas / API JSON、PNG 或 WebP"}</span>
      </span>
    </label>
  );
}

function ModelRow({ model, installing, disabled, onInstall }: { model: WorkflowModel; installing: boolean; disabled: boolean; onInstall: (repoId: string, repoFile: string, revision: string) => Promise<void> }) {
  const [repoId, setRepoId] = useState(model.source?.repoId ?? "");
  const [repoFile, setRepoFile] = useState(model.source?.repoFile ?? model.filename);
  const [revision, setRevision] = useState(model.source?.revision ?? "main");
  const missing = model.status === "missing";

  return (
    <div className={`resource-row ${missing ? "resource-row--missing" : ""}`}>
      <div className="resource-row__summary">
        <span className={`resource-state resource-state--${model.status}`}>{model.status === "present" ? <CheckIcon /> : "!"}</span>
        <span>
          <strong title={model.filename}>{model.filename}</strong>
          <small>{model.category} · {model.nodes.length} 个节点引用</small>
          {model.source && <small className="package-repository">工作流已提供 Hugging Face 来源</small>}
        </span>
      </div>
      {missing && (
        <form className="install-form" onSubmit={(event) => { event.preventDefault(); void onInstall(repoId, repoFile, revision); }}>
          <label>Hugging Face 仓库<input value={repoId} onChange={(event) => setRepoId(event.target.value)} placeholder="owner/repository" required /></label>
          <label>仓库内文件<input value={repoFile} onChange={(event) => setRepoFile(event.target.value)} placeholder="model.safetensors" required /></label>
          <label>版本或提交<input value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="main 或 commit SHA" required /></label>
          <button type="submit" disabled={disabled}>{installing ? <span className="mini-spinner" /> : <DownloadIcon size={16} />}{model.source ? "按工作流来源下载" : "云端下载"}</button>
        </form>
      )}
    </div>
  );
}

function NodePackageRow({ item, installing, disabled, onInstall, usage = "nodes" }: { item: MissingNodePackage; installing: boolean; disabled: boolean; onInstall: () => Promise<void>; usage?: "nodes" | "runtime" }) {
  const registryReference = item.kind === "registry" ? item.version ? `${item.registryId}@${item.version}` : item.registryId : undefined;
  return (
    <div className="resource-row resource-row--missing">
      <div className="resource-row__summary">
        <span className="resource-state resource-state--missing">!</span>
        <span>
          <strong>{item.name}</strong>
          <small>{item.kind === "core" ? `${item.nodeTypes.length} 个 ComfyUI 核心节点` : usage === "runtime" ? `${registryReference} · 运行选项扩展` : `${registryReference} · ${item.nodeTypes.length} 个缺失节点`}</small>
          {item.kind === "registry" && item.sourceRevision && <small className="package-repository">工作流固定源码：{item.sourceRevision.slice(0, 12)}…</small>}
        </span>
      </div>
      <div className="package-node-list"><span>{usage === "runtime" ? "验证节点" : "包含"}</span><p>{item.nodeTypes.join("、")}</p></div>
      {item.kind === "registry" ? (
        <div className="install-form install-form--package">
          <small>{usage === "runtime" ? "将安装固定源码并验证扩展可以被云端加载" : "将安装并验证此节点包提供的全部缺失类型"}</small>
          <button type="button" disabled={disabled} onClick={() => void onInstall()}>{installing ? <span className="mini-spinner" /> : <DownloadIcon size={16} />}{usage === "runtime" ? "安装运行扩展" : "安装节点包"}</button>
        </div>
      ) : (
        <div className="package-core-note"><strong>需要升级云端 ComfyUI</strong><span>这不是第三方节点包，安装 Registry 包无法解决。</span></div>
      )}
    </div>
  );
}

function PythonRuntimePackageRow({ item, installing, disabled, onInstall }: { item: MissingPythonRuntimePackage; installing: boolean; disabled: boolean; onInstall: () => Promise<void> }) {
  return (
    <div className="resource-row resource-row--missing">
      <div className="resource-row__summary">
        <span className="resource-state resource-state--missing">!</span>
        <span><strong>{item.name}</strong><small>{item.packageId}=={item.version} · Python 运行扩展</small></span>
      </div>
      <div className="package-node-list"><span>用于</span><p>{item.nodeTypes.join("、")}</p></div>
      <div className="install-form install-form--package">
        <small>将在临时目录验证固定版本，只写入缺失包；不会复制模型或启动 GPU。</small>
        <button type="button" disabled={disabled} onClick={() => void onInstall()}>{installing ? <span className="mini-spinner" /> : <DownloadIcon size={16} />}安装运行扩展</button>
      </div>
    </div>
  );
}

function SuggestedNodePackageRow({ item, installing, disabled, onInstall }: { item: SuggestedNodePackage; installing: boolean; disabled: boolean; onInstall: (registryId: string) => Promise<void> }) {
  const registryReference = item.version ? `${item.registryId}@${item.version}` : item.registryId;
  const [registryId, setRegistryId] = useState(registryReference);
  const suggestionMessage = item.source === "ambiguous-manager-map"
    ? "公共节点映射指向多个仓库，请根据工作流来源核对后选择。"
    : item.source === "workflow-metadata-conflict"
      ? "工作流包含冲突的节点包元数据，请核对后选择。"
      : "仅根据节点名称启发式推断，安装前请核对 Registry 包名。";
  return (
    <div className="resource-row resource-row--missing">
      <div className="resource-row__summary">
        <span className="resource-state resource-state--missing">?</span>
        <span>
          <strong>{item.name}</strong>
          <small>低置信度建议 · {registryReference} · {item.nodeTypes.length} 个缺失节点</small>
          <small className="package-repository">仓库来源：{item.repository || "Registry 未提供"}</small>
        </span>
      </div>
      <div className="package-node-list"><span>可能包含</span><p>{item.nodeTypes.join("、")}</p></div>
      <form className="install-form install-form--suggestion" onSubmit={(event) => { event.preventDefault(); void onInstall(registryId); }}>
        <small>{suggestionMessage}</small>
        <label>核对 Registry 节点包<input value={registryId} onChange={(event) => setRegistryId(event.target.value)} required /></label>
        <button type="submit" disabled={disabled}>{installing ? <span className="mini-spinner" /> : <DownloadIcon size={16} />}确认并安装</button>
      </form>
    </div>
  );
}

function UnresolvedNodeRow({ nodeType, installing, disabled, onInstall }: { nodeType: string; installing: boolean; disabled: boolean; onInstall: (registryId: string) => Promise<void> }) {
  const [registryId, setRegistryId] = useState("");
  return (
    <div className="resource-row resource-row--missing">
      <div className="resource-row__summary">
        <span className="resource-state resource-state--missing">!</span>
        <span><strong>{nodeType}</strong><small>未能自动确定所属节点包</small></span>
      </div>
      <form className="install-form install-form--node" onSubmit={(event) => { event.preventDefault(); void onInstall(registryId); }}>
        <label>ComfyUI Registry 节点包<input value={registryId} onChange={(event) => setRegistryId(event.target.value)} placeholder="package-name@version" required /></label>
        <button type="submit" disabled={disabled}>{installing ? <span className="mini-spinner" /> : <DownloadIcon size={16} />}安装节点包</button>
      </form>
    </div>
  );
}

export function Workbench({ isMock }: { isMock: boolean }) {
  const confirmCost = useCostApproval();
  const [workflowFile, setWorkflowFile] = useState<File>();
  const [workflowName, setWorkflowName] = useState("");
  const [analysis, setAnalysis] = useState<WorkflowAnalysis>();
  const [storedWorkflows, setStoredWorkflows] = useState<StoredWorkflow[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [syncingLibrary, setSyncingLibrary] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [assetVersion, setAssetVersion] = useState("base");
  const [analyzing, setAnalyzing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [installingKey, setInstallingKey] = useState<string>();
  const [pendingResourceJobId, setPendingResourceJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const [resourceNotice, setResourceNotice] = useState<string>();
  const [canRollbackRuntime, setCanRollbackRuntime] = useState(false);
  const [reviewingWorkflow, setReviewingWorkflow] = useState<Pick<StoredWorkflow, "id" | "name">>();
  const [recheckingId, setRecheckingId] = useState<string>();
  const resourcePollAbort = useRef<AbortController | null>(null);
  const analysisRequests = useRef(createLatestRequestGuard());

  const missingNodePackages = analysis?.missingNodePackages ?? [];
  const suggestedNodePackages = analysis?.suggestedNodePackages ?? [];
  const unresolvedNodes = analysis?.unresolvedNodes ?? analysis?.missingNodes ?? [];
  const missingRuntimePackages = analysis?.missingRuntimePackages ?? [];
  const parameterInputs = analysis?.parameterInputs ?? [];
  const compatibilityAdjustments = analysis?.compatibilityAdjustments ?? [];

  async function refreshStoredWorkflows() {
    setLoadingLibrary(true);
    try {
      const response = await fetch("/api/workflows", { cache: "no-store" });
      const body = await response.json() as { workflows?: StoredWorkflow[]; message?: string };
      if (!response.ok) throw new Error(body.message ?? "工作流库读取失败");
      setStoredWorkflows(body.workflows ?? []);
    } catch (libraryError) {
      setError(libraryError instanceof Error ? libraryError.message : "工作流库读取失败");
    } finally {
      setLoadingLibrary(false);
    }
  }

  async function syncStoredWorkflows() {
    if (syncingLibrary) return;
    setSyncingLibrary(true);
    setError(undefined);
    try {
      const approval = await confirmCost({
        action: "workflow-sync",
        target: costTargets.workflowCatalog(),
        fileBytes: 0,
        batchCount: 1,
      });
      if (!approval) return;
      const response = await fetch("/api/workflows/sync", { method: "POST", headers: costHeaders(approval) });
      const body = await response.json() as { workflows?: StoredWorkflow[]; message?: string };
      if (!response.ok) throw new Error(body.message ?? "云端工作流同步失败");
      setStoredWorkflows(body.workflows ?? []);
      setResourceNotice(`已同步 ${body.workflows?.length ?? 0} 个云端工作流，后续浏览不会唤醒 Modal。`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "云端工作流同步失败");
    } finally {
      setSyncingLibrary(false);
    }
  }

  async function recheckStoredWorkflow(workflowId: string, workflowName?: string) {
    const requestId = analysisRequests.current.begin();
    setRecheckingId(workflowId);
    setError(undefined);
    setAnalysis(undefined);
    setResourceNotice(`正在复查“${workflowName ?? "已保存工作流"}”…`);
    try {
      const approval = await confirmCost({
        action: "workflow-analyze",
        target: costTargets.storedWorkflow(workflowId),
        fileBytes: 0,
        batchCount: 1,
      });
      if (!approval) return false;
      const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/recheck`, {
        method: "POST",
        headers: costHeaders(approval),
      });
      const body = await response.json() as StoredWorkflow & {
        detail?: string;
        message?: string;
        analysis?: WorkflowAnalysis;
      };
      if (!analysisRequests.current.isCurrent(requestId)) return false;
      if (response.status === 409 && body.analysis) {
        setWorkflowFile(undefined);
        setWorkflowName(workflowName ?? "已保存工作流");
        setReviewingWorkflow({ id: workflowId, name: workflowName ?? "已保存工作流" });
        setAnalysis(body.analysis);
        setCanRollbackRuntime(Boolean(body.analysis.canRollbackRuntime));
        setAssetVersion(body.analysis.assetVersion ?? "base");
        setResourceNotice(body.message ?? "复查未通过，请补齐缺失资源。");
        return false;
      }
      if (!response.ok) throw new Error(body.detail ?? body.message ?? "工作流复查失败");
      setReviewingWorkflow(undefined);
      setAnalysis(undefined);
      setResourceNotice(`“${body.name ?? workflowName ?? "工作流"}”已通过复查并更新版本。`);
      await refreshStoredWorkflows();
      return true;
    } catch (reviewError) {
      if (analysisRequests.current.isCurrent(requestId)) {
        setResourceNotice(undefined);
        setError(reviewError instanceof Error ? reviewError.message : "工作流复查失败");
      }
      return false;
    } finally {
      if (analysisRequests.current.isCurrent(requestId)) setRecheckingId(undefined);
    }
  }

  useEffect(() => {
    void refreshStoredWorkflows();
  }, []);

  useEffect(() => {
    if (isMock) return;
    const controller = new AbortController();
    void fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Modal readiness 检查失败");
        const body = await response.json() as { canRollbackRuntime?: boolean };
        setCanRollbackRuntime(Boolean(body.canRollbackRuntime));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [isMock]);

  function rememberResourceJob(pending: PendingResourceJob) {
    localStorage.setItem(RESOURCE_JOB_STORAGE_KEY, JSON.stringify(pending));
    setPendingResourceJobId(pending.jobId);
  }

  function forgetResourceJob(jobId: string) {
    const raw = localStorage.getItem(RESOURCE_JOB_STORAGE_KEY);
    if (!raw) {
      setPendingResourceJobId((current) => current === jobId ? undefined : current);
      return;
    }
    try {
      const pending = JSON.parse(raw) as PendingResourceJob;
      if (pending.jobId === jobId) localStorage.removeItem(RESOURCE_JOB_STORAGE_KEY);
    } catch {
      localStorage.removeItem(RESOURCE_JOB_STORAGE_KEY);
    }
    setPendingResourceJobId((current) => current === jobId ? undefined : current);
  }

  async function waitForResourceJob(jobId: string, signal: AbortSignal) {
    const deadline = Date.now() + RESOURCE_JOB_TIMEOUT_MS;
    let retryDelay = 1_200;
    while (Date.now() < deadline) {
      await wait(retryDelay, signal);
      let response: Response;
      let body: ResourceJobResponse & { detail?: string };
      try {
        response = await fetch(`/api/resources/jobs/${encodeURIComponent(jobId)}`, {
          cache: "no-store",
          signal,
        });
        const text = await response.text();
        body = JSON.parse(text) as ResourceJobResponse & { detail?: string };
      } catch (pollError) {
        if (isAbortError(pollError)) throw pollError;
        retryDelay = Math.min(retryDelay * 2, 10_000);
        continue;
      }
      if (!response.ok && response.status !== 202) {
        if (response.status >= 500) {
          retryDelay = Math.min(retryDelay * 2, 10_000);
          continue;
        }
        forgetResourceJob(jobId);
        throw new Error(body.detail ?? body.message ?? "资源安装状态查询失败");
      }
      if (body.status === "failed") {
        forgetResourceJob(jobId);
        throw new Error(body.message ?? "资源安装失败");
      }
      if (body.status === "succeeded") {
        forgetResourceJob(jobId);
        return body;
      }
      retryDelay = 1_200;
    }
    throw new Error("资源安装仍在云端运行；刷新页面后会继续跟踪");
  }

  useEffect(() => {
    const raw = localStorage.getItem(RESOURCE_JOB_STORAGE_KEY);
    if (!raw) return;
    let pending: PendingResourceJob;
    try {
      pending = JSON.parse(raw) as PendingResourceJob;
      if (!pending.jobId || !pending.key) throw new Error("invalid pending job");
    } catch {
      localStorage.removeItem(RESOURCE_JOB_STORAGE_KEY);
      return;
    }

    const controller = new AbortController();
    resourcePollAbort.current = controller;
    setInstallingKey(pending.key);
    setPendingResourceJobId(pending.jobId);
    setResourceNotice("正在恢复上次未完成的资源安装…");
    void waitForResourceJob(pending.jobId, controller.signal)
      .then(async (completed) => {
        if (completed.assetVersion) setAssetVersion(completed.assetVersion);
        if (pending.workflowId) {
          await recheckStoredWorkflow(pending.workflowId, pending.workflowName);
        } else {
          setResourceNotice("资源安装已完成，请重新选择工作流文件以刷新检查结果。");
        }
      })
      .catch((resumeError) => {
        if (!isAbortError(resumeError)) {
          setResourceNotice(undefined);
          setError(resumeError instanceof Error ? resumeError.message : "资源安装状态查询失败");
        }
      })
      .finally(() => {
        if (resourcePollAbort.current === controller) resourcePollAbort.current = null;
        setInstallingKey(undefined);
      });

    return () => controller.abort();
  }, []);

  useEffect(() => () => resourcePollAbort.current?.abort(), []);

  async function analyze(file: File) {
    const requestId = analysisRequests.current.begin();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
    setAnalyzing(true);
    setError(undefined);
    setAnalysis(undefined);
    try {
      const target = costTargets.workflowFile(file.name);
      const approval = await confirmCost({ action: "workflow-analyze", target, fileBytes: file.size, batchCount: 1 });
      if (!approval) return;
      const form = new FormData();
      form.set("workflow", file);
      const response = await fetch("/api/workflows/analyze", {
        method: "POST",
        headers: costHeaders(approval, {
          "x-cost-target": target,
          "x-cost-file-bytes": String(file.size),
        }),
        body: form,
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? body.message ?? "工作流分析失败");
      if (!analysisRequests.current.isCurrent(requestId)) return;
      const nextAnalysis = body as WorkflowAnalysis;
      setAnalysis(nextAnalysis);
      setCanRollbackRuntime(Boolean(nextAnalysis.canRollbackRuntime));
      setAssetVersion(nextAnalysis.assetVersion ?? "base");
    } catch (analyzeError) {
      if (!analysisRequests.current.isCurrent(requestId)) return;
      setAnalysis(undefined);
      setError(
        controller.signal.aborted
          ? "工作流分析超时，请点击工作流文件重新检查"
          : analyzeError instanceof Error
            ? analyzeError.message
            : "工作流分析失败",
      );
    } finally {
      clearTimeout(timeout);
      if (analysisRequests.current.isCurrent(requestId)) setAnalyzing(false);
    }
  }

  async function chooseWorkflow(file: File) {
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (!extension || ![".json", ".png", ".webp"].includes(extension)) {
      setError("请选择 Canvas / API JSON 或带 ComfyUI prompt 的 PNG/WebP");
      return;
    }
    const maximum = extension === ".json" ? 5 : 25;
    if (file.size > maximum * 1024 * 1024) {
      setError(`工作流文件不能超过 ${maximum} MB`);
      return;
    }
    setReviewingWorkflow(undefined);
    setRecheckingId(undefined);
    setResourceNotice(undefined);
    setWorkflowFile(file);
    setWorkflowName(file.name.replace(/\.(json|png|webp)$/i, ""));
    await analyze(file);
  }

  async function saveWorkflow() {
    if (!workflowFile || !analysis?.runnable || savingWorkflow) return;
    setSavingWorkflow(true);
    setError(undefined);
    setResourceNotice("正在保存通过检查的工作流版本…");
    try {
      const target = costTargets.workflowFile(workflowFile.name);
      const approval = await confirmCost({ action: "workflow-import", target, fileBytes: workflowFile.size, batchCount: 1 });
      if (!approval) return;
      const form = new FormData();
      form.set("workflow", workflowFile);
      form.set("name", workflowName);
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: costHeaders(approval, {
          "x-cost-target": target,
          "x-cost-file-bytes": String(workflowFile.size),
        }),
        body: form,
      });
      const body = await response.json() as StoredWorkflow & { detail?: string; message?: string };
      if (!response.ok) throw new Error(body.detail ?? body.message ?? "工作流保存失败");
      setResourceNotice(`“${body.name}”已保存到工作流库，可以前往运行页使用。`);
      await refreshStoredWorkflows();
    } catch (saveError) {
      setResourceNotice(undefined);
      setError(saveError instanceof Error ? saveError.message : "工作流保存失败");
    } finally {
      setSavingWorkflow(false);
    }
  }

  async function downloadApiWorkflow() {
    if (!workflowFile || analysis?.conversionStatus !== "ready") return;
    setConverting(true);
    setError(undefined);
    try {
      const target = costTargets.workflowFile(workflowFile.name);
      const approval = await confirmCost({ action: "workflow-convert", target, fileBytes: workflowFile.size, batchCount: 1 });
      if (!approval) return;
      const form = new FormData();
      form.set("workflow", workflowFile);
      const response = await fetch("/api/workflows/convert", {
        method: "POST",
        headers: costHeaders(approval, {
          "x-cost-target": target,
          "x-cost-file-bytes": String(workflowFile.size),
        }),
        body: form,
      });
      if (!response.ok) {
        const body = await response.json() as { detail?: string; message?: string };
        throw new Error(body.detail ?? body.message ?? "API 工作流生成失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const baseName = workflowFile.name.replace(/\.json$/i, "") || "workflow";
      link.href = url;
      link.download = `${baseName}-api.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (conversionError) {
      setError(conversionError instanceof Error ? conversionError.message : "API 工作流生成失败");
    } finally {
      setConverting(false);
    }
  }

  async function installModel(model: WorkflowModel, repoId: string, repoFile: string, revision: string) {
    const key = `model:${model.category}:${model.filename}`;
    const reviewTarget = reviewingWorkflow;
    setInstallingKey(key);
    setError(undefined);
    setResourceNotice("模型下载已提交，离开页面后仍会在云端继续。");
    let controller: AbortController | undefined;
    try {
      const target = costTargets.model(repoId, repoFile, revision, model.category, model.filename);
      const approval = await confirmCost({ action: "model-download", target, fileBytes: 0, batchCount: 1 });
      if (!approval) return;
      setResourceNotice("模型下载已提交，离开页面后仍会在云端继续。");
      const response = await fetch("/api/resources/models", {
        method: "POST",
        headers: costHeaders(approval, { "content-type": "application/json" }),
        body: JSON.stringify({ repoId, repoFile, revision, category: model.category, filename: model.filename }),
      });
      const body = await response.json() as ResourceJobResponse & { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? body.message ?? "模型安装失败");
      controller = new AbortController();
      resourcePollAbort.current = controller;
      rememberResourceJob({
        jobId: body.jobId,
        key,
        workflowId: reviewTarget?.id,
        workflowName: reviewTarget?.name,
      });
      const completed = await waitForResourceJob(body.jobId, controller.signal);
      if (completed.assetVersion) setAssetVersion(completed.assetVersion);
      setInstallingKey(undefined);
      setResourceNotice("模型下载完成，正在刷新工作流检查…");
      if (reviewTarget) {
        await recheckStoredWorkflow(reviewTarget.id, reviewTarget.name);
      } else {
        if (workflowFile) await analyze(workflowFile);
        setResourceNotice("模型安装完成，工作流检查结果已刷新。");
      }
    } catch (installError) {
      if (!isAbortError(installError)) {
        setResourceNotice(undefined);
        setError(installError instanceof Error ? installError.message : "模型安装失败");
      }
    } finally {
      if (resourcePollAbort.current === controller) resourcePollAbort.current = null;
      setInstallingKey(undefined);
    }
  }

  async function installNodePackage(
    nodeTypes: string[],
    registryId: string,
    trackingKey = registryId,
    source?: { repository: string; revision: string },
  ) {
    const key = `node-package:${trackingKey}`;
    const reviewTarget = reviewingWorkflow;
    setInstallingKey(key);
    setError(undefined);
    setResourceNotice("节点包安装已提交，离开页面后仍会在云端继续。");
    let controller: AbortController | undefined;
    try {
      const target = costTargets.nodePackage(registryId, source?.repository, source?.revision);
      const approval = await confirmCost({ action: "node-package-install", target, fileBytes: 0, batchCount: 1 });
      if (!approval) return;
      setResourceNotice("节点包安装已提交，离开页面后仍会在云端继续。");
      const response = await fetch("/api/resources/nodes", {
        method: "POST",
        headers: costHeaders(approval, { "content-type": "application/json" }),
        body: JSON.stringify({
          registryId,
          nodeTypes,
          ...(source ? {
            sourceRepository: source.repository,
            sourceRevision: source.revision,
          } : {}),
        }),
      });
      const body = await response.json() as ResourceJobResponse & { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? body.message ?? "节点包安装失败");
      controller = new AbortController();
      resourcePollAbort.current = controller;
      rememberResourceJob({
        jobId: body.jobId,
        key,
        workflowId: reviewTarget?.id,
        workflowName: reviewTarget?.name,
      });
      const completed = await waitForResourceJob(body.jobId, controller.signal);
      if (completed.assetVersion) setAssetVersion(completed.assetVersion);
      if (reviewTarget) {
        await recheckStoredWorkflow(reviewTarget.id, reviewTarget.name);
      } else {
        if (workflowFile) await analyze(workflowFile);
        setResourceNotice("节点包安装完成，工作流检查结果已刷新。");
      }
    } catch (installError) {
      if (!isAbortError(installError)) {
        setResourceNotice(undefined);
        setError(installError instanceof Error ? installError.message : "节点包安装失败");
      }
    } finally {
      if (resourcePollAbort.current === controller) resourcePollAbort.current = null;
      setInstallingKey(undefined);
    }
  }

  async function installPythonRuntimePackage(item: MissingPythonRuntimePackage) {
    const key = `runtime-package:${item.packageId}`;
    const reviewTarget = reviewingWorkflow;
    setInstallingKey(key);
    setError(undefined);
    setResourceNotice("运行扩展安装已提交，离开页面后仍会在云端继续。");
    let controller: AbortController | undefined;
    try {
      const target = costTargets.pythonPackage(item.packageId);
      const approval = await confirmCost({ action: "python-package-install", target, fileBytes: 0, batchCount: 1 });
      if (!approval) return;
      setResourceNotice("运行扩展安装已提交，离开页面后仍会在云端继续。");
      const response = await fetch("/api/resources/runtime/packages", {
        method: "POST",
        headers: costHeaders(approval, { "content-type": "application/json" }),
        body: JSON.stringify({ packageId: item.packageId }),
      });
      const body = await response.json() as ResourceJobResponse & { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? body.message ?? "运行扩展安装失败");
      controller = new AbortController();
      resourcePollAbort.current = controller;
      rememberResourceJob({
        jobId: body.jobId,
        key,
        workflowId: reviewTarget?.id,
        workflowName: reviewTarget?.name,
      });
      const completed = await waitForResourceJob(body.jobId, controller.signal);
      if (completed.assetVersion) setAssetVersion(completed.assetVersion);
      if (reviewTarget) {
        await recheckStoredWorkflow(reviewTarget.id, reviewTarget.name);
      } else {
        if (workflowFile) await analyze(workflowFile);
        setResourceNotice("运行扩展安装完成，工作流检查结果已刷新。");
      }
    } catch (installError) {
      if (!isAbortError(installError)) {
        setResourceNotice(undefined);
        setError(installError instanceof Error ? installError.message : "运行扩展安装失败");
      }
    } finally {
      if (resourcePollAbort.current === controller) resourcePollAbort.current = null;
      setInstallingKey(undefined);
    }
  }

  async function rollbackRuntime() {
    const key = "runtime:rollback";
    const reviewTarget = reviewingWorkflow;
    setInstallingKey(key);
    setError(undefined);
    setResourceNotice("正在切换到上一版节点环境…");
    let controller: AbortController | undefined;
    try {
      const target = costTargets.runtimeRollback();
      const approval = await confirmCost({ action: "runtime-rollback", target, fileBytes: 0, batchCount: 1 });
      if (!approval) return;
      setResourceNotice("正在切换到上一版节点环境…");
      const response = await fetch("/api/resources/runtime/rollback", {
        method: "POST",
        headers: costHeaders(approval),
      });
      const body = await response.json() as ResourceJobResponse & { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? body.message ?? "节点环境回滚失败");
      controller = new AbortController();
      resourcePollAbort.current = controller;
      rememberResourceJob({
        jobId: body.jobId,
        key,
        workflowId: reviewTarget?.id,
        workflowName: reviewTarget?.name,
      });
      const completed = await waitForResourceJob(body.jobId, controller.signal);
      if (completed.assetVersion) setAssetVersion(completed.assetVersion);
      if (reviewTarget) {
        await recheckStoredWorkflow(reviewTarget.id, reviewTarget.name);
      } else {
        if (workflowFile) await analyze(workflowFile);
        setResourceNotice("已恢复上一版节点环境，工作流检查结果已刷新。");
      }
    } catch (rollbackError) {
      if (!isAbortError(rollbackError)) {
        setResourceNotice(undefined);
        setError(rollbackError instanceof Error ? rollbackError.message : "节点环境回滚失败");
      }
    } finally {
      if (resourcePollAbort.current === controller) resourcePollAbort.current = null;
      setInstallingKey(undefined);
    }
  }

  async function cancelResourceJob() {
    if (!pendingResourceJobId) return;
    const jobId = pendingResourceJobId;
    resourcePollAbort.current?.abort();
    try {
      const response = await fetch(`/api/resources/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      const body = await response.json() as ResourceJobResponse;
      if (!response.ok) throw new Error(body.message ?? "资源任务取消失败");
      forgetResourceJob(jobId);
      setInstallingKey(undefined);
      setResourceNotice("资源任务已取消，当前资源版本未切换。");
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "资源任务取消失败");
    }
  }

  return (
    <div className="app-shell">
      <AppHeader isMock={isMock} />

      <main className="workflow-shell">
        <div className="workflow-panel">
          <section className="workflow-section workflow-section--lead">
            <h1>工作流库</h1>
            <p>上传、检查并保存可重复运行的工作流版本。运行时输入与生成结果在独立运行页处理。</p>
          </section>

          <section className="workflow-section">
            <div className="workflow-section__heading"><h2>工作流文件</h2>{analysis && <span>{analysis.nodeCount} 个节点</span>}</div>
            {reviewingWorkflow && (
              <div className="workflow-review-target" role="status">
                <span><strong>正在复查已保存版本</strong><small>{reviewingWorkflow.name}</small></span>
                {recheckingId === reviewingWorkflow.id && <span className="mini-spinner" aria-label="正在复查" />}
              </div>
            )}
            <WorkflowDrop file={workflowFile} busy={analyzing} busyLabel="正在云端检查节点和模型" onFile={(file) => void chooseWorkflow(file)} />
            <p className="format-help">支持普通 Canvas JSON、“导出（API）”JSON，以及包含 prompt 元数据的 PNG/WebP。</p>
          </section>

          {analysis && (
            <>
              <section className="workflow-section">
                <div className="workflow-section__heading"><h2>云端检查</h2><span className={analysis.runnable ? "status-good" : "status-warn"}>{analysis.runnable ? "依赖完整" : `${analysis.issues.length} 项待处理`}</span></div>
                <div className="analysis-strip">
                  <span><strong>{analysis.nodeTypes.length}</strong>节点类型</span>
                  <span><strong>{analysis.models.length}</strong>模型引用</span>
                  <span><strong>{analysis.imageInputs.length}</strong>图像输入</span>
                  <span><strong>{analysis.outputNodes.length}</strong>输出节点</span>
                </div>
                {!analysis.runnable && analysis.issues.length > 0 && (
                  <div className="analysis-issues" role="alert">
                    <strong>需要处理</strong>
                    <ul>{analysis.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul>
                    {analysis.unsupportedInputs?.map((item) => (
                      <small key={`${item.nodeId}:${item.inputName}`}>
                        节点 {item.nodeId} 的 {item.inputName} 当前可用值：{availableValuesSummary(item)}
                      </small>
                    ))}
                  </div>
                )}
                {compatibilityAdjustments.length > 0 && (
                  <div className="compatibility-notice" role="status">
                    <strong>已应用云端兼容调整</strong>
                    <ul>{compatibilityAdjustments.map((item) => <li key={`${item.code}:${item.nodeId}`}>{item.message}</li>)}</ul>
                  </div>
                )}
                {analysis.format === "comfyui-canvas" && (
                  <div className={`conversion-status conversion-status--${analysis.conversionStatus ?? "blocked"}`}>
                    <span>
                      <strong>{analysis.conversionStatus === "ready" ? "已在云端生成 API 工作流" : "等待节点安装后转换"}</strong>
                      <small>{analysis.conversionStatus === "ready" ? analysis.runnable ? "可直接运行，也可下载生成的 API JSON。" : "API JSON 已生成，但仍需处理上方问题后才能运行。" : "转换需要云端节点 schema；补齐下方节点后会自动重试。"}</small>
                    </span>
                    {analysis.conversionStatus === "ready" && (
                      <button type="button" onClick={() => void downloadApiWorkflow()} disabled={converting}>
                        {converting ? <span className="mini-spinner" /> : <DownloadIcon size={16} />}
                        {converting ? "正在生成" : "下载 API JSON"}
                      </button>
                    )}
                  </div>
                )}
              </section>

              {analysis.models.length > 0 && (
                <section className="workflow-section resource-section">
                  <div className="workflow-section__heading"><h2>模型</h2><span>{analysis.models.filter((item) => item.status === "missing").length} 个缺失</span></div>
                  {analysis.models.map((model) => (
                    <ModelRow key={`${model.category}:${model.filename}`} model={model} installing={installingKey === `model:${model.category}:${model.filename}`} disabled={Boolean(installingKey)} onInstall={(repoId, repoFile, revision) => installModel(model, repoId, repoFile, revision)} />
                  ))}
                </section>
              )}

              {analysis.missingNodes.length > 0 && (
                <section className="workflow-section resource-section">
                  <div className="workflow-section__heading"><h2>节点包</h2><span>{missingNodePackages.filter((item) => item.kind === "registry").length + suggestedNodePackages.length} 个包 · {analysis.missingNodes.length} 个节点</span></div>
                  {analysis.nodePackageLookupStatus === "failed" && (
                    <div className="package-lookup-warning" role="status">
                      <span>
                        <strong>节点包查询暂时失败</strong>
                        <small>{analysis.nodePackageLookupMessage ?? "请稍后重新检查，或核对后手动填写 Registry 包名。"}</small>
                      </span>
                      <button type="button" disabled={!workflowFile || analyzing || Boolean(installingKey)} onClick={() => workflowFile && void analyze(workflowFile)}>重新检查</button>
                    </div>
                  )}
                  {missingNodePackages.map((item) => {
                    const registryReference = item.kind === "registry" ? item.version ? `${item.registryId}@${item.version}` : item.registryId : "";
                    const source = item.kind === "registry" && item.sourceRevision
                      ? { repository: item.repository, revision: item.sourceRevision }
                      : undefined;
                    const installReference = source && item.kind === "registry" ? item.registryId : registryReference;
                    return <NodePackageRow key={`${item.kind}:${item.kind === "registry" ? item.registryId : item.name}`} item={item} installing={installingKey === `node-package:${registryReference}`} disabled={Boolean(installingKey)} onInstall={() => installNodePackage(item.nodeTypes, installReference, registryReference, source)} />;
                  })}
                  {suggestedNodePackages.map((item) => {
                    return <SuggestedNodePackageRow key={`suggested:${item.registryId}`} item={item} installing={installingKey === `node-package:suggested:${item.registryId}`} disabled={Boolean(installingKey)} onInstall={(registryId) => installNodePackage(item.nodeTypes, registryId, `suggested:${item.registryId}`)} />;
                  })}
                  {unresolvedNodes.map((nodeType) => <UnresolvedNodeRow key={nodeType} nodeType={nodeType} installing={installingKey === `node-package:${nodeType}`} disabled={Boolean(installingKey)} onInstall={(registryId) => installNodePackage([nodeType], registryId, nodeType)} />)}
                </section>
              )}

              {missingRuntimePackages.length > 0 && (
                <section className="workflow-section resource-section">
                  <div className="workflow-section__heading"><h2>运行扩展</h2><span>{missingRuntimePackages.length} 个缺失</span></div>
                  {missingRuntimePackages.map((item) => {
                    if (item.kind === "python") {
                      return <PythonRuntimePackageRow key={`runtime:python:${item.packageId}`} item={item} installing={installingKey === `runtime-package:${item.packageId}`} disabled={Boolean(installingKey)} onInstall={() => installPythonRuntimePackage(item)} />;
                    }
                    const registryReference = item.kind === "registry" ? item.version ? `${item.registryId}@${item.version}` : item.registryId : "";
                    const source = item.kind === "registry" && item.sourceRevision
                      ? { repository: item.repository, revision: item.sourceRevision }
                      : undefined;
                    const installReference = source && item.kind === "registry" ? item.registryId : registryReference;
                    return <NodePackageRow usage="runtime" key={`runtime:${item.kind}:${item.name}`} item={item} installing={installingKey === `node-package:${registryReference}`} disabled={Boolean(installingKey)} onInstall={() => installNodePackage(item.nodeTypes, installReference, registryReference, source)} />;
                  })}
                </section>
              )}

              {(analysis.imageInputs.length > 0 || analysis.textInputs.length > 0 || parameterInputs.length > 0 || Boolean(analysis.variants?.length)) && (
                <section className="workflow-section runtime-section">
                  <div className="workflow-section__heading"><h2>已识别输入</h2><span>{analysis.imageInputs.length} 图像 · {analysis.textInputs.length} 文本 · {parameterInputs.length} 参数</span></div>
                  <div className="workflow-input-schema">
                    {analysis.imageInputs.map((item) => <span key={item.fieldName}><strong>{item.inputName}</strong><small>{item.classType}</small></span>)}
                    {analysis.textInputs.map((item) => <span key={item.fieldName}><strong>{item.label}</strong><small>{item.classType} · 运行时可修改</small></span>)}
                    {parameterInputs.map((item) => <span key={item.fieldName}><strong>{item.label}</strong><small>{item.classType} · 默认 {String(item.currentValue)}</small></span>)}
                    {analysis.variants?.map((variant) => <span key={variant.id}><strong>{variant.name}模式</strong><small>{variant.imageInputs.length} 个图像输入 · {variant.description}</small></span>)}
                  </div>
                </section>
              )}
            </>
          )}

          {canRollbackRuntime && (
            <section className="workflow-section runtime-recovery">
              <div><strong>节点环境恢复</strong><span>当前版本 {analysis?.runtimeRevision?.slice(0, 8) ?? "可回滚"}</span></div>
              <button type="button" disabled={Boolean(installingKey)} onClick={() => void rollbackRuntime()}>
                {installingKey === "runtime:rollback" && <span className="mini-spinner" />}
                回滚上一版
              </button>
            </section>
          )}

          <div className="workflow-submit">
            {resourceNotice && <p className="form-notice" role="status">{resourceNotice}</p>}
            {pendingResourceJobId && <button type="button" className="cancel-button" onClick={() => void cancelResourceJob()}>取消资源任务</button>}
            {error && <p className="form-error" role="alert">{error}</p>}
            {analysis?.runnable && <label className="workflow-name-field"><span>工作流名称</span><input value={workflowName} maxLength={100} onChange={(event) => setWorkflowName(event.target.value)} /></label>}
            <button type="button" className="generate-button" onClick={() => void saveWorkflow()} disabled={!workflowFile || !analysis?.runnable || !workflowName.trim() || analyzing || Boolean(installingKey) || savingWorkflow}>
              {savingWorkflow ? <span className="mini-spinner" /> : <CheckIcon size={15} />}
              {savingWorkflow ? "正在保存" : "保存到工作流库"}
            </button>
            <small>{!analysis ? "先上传或复查工作流" : !analysis.runnable ? "请处理上方检查问题" : `检查通过 · 资源版本 ${assetVersion.slice(0, 8)}`}</small>
          </div>
        </div>

        <section className="workflow-stage library-stage" aria-label="已保存工作流">
          <header><div><strong>已保存工作流</strong><span>{storedWorkflows.length} 个工作流</span></div><div className="library-stage__actions"><button type="button" onClick={() => void syncStoredWorkflows()} disabled={syncingLibrary} title="同步 Modal 工作流"><RefreshCw size={15} className={syncingLibrary ? "is-spinning" : undefined} />同步</button><Link to="/">前往运行</Link></div></header>
          <div className="workflow-canvas library-canvas">
            {loadingLibrary && <div className="workflow-list-skeleton" aria-label="正在读取工作流"><span /><span /><span /></div>}
            {!loadingLibrary && storedWorkflows.length === 0 && <div className="empty-stage"><span aria-hidden="true">{"{}"}</span><strong>工作流库为空</strong><p>可以上传新工作流，或从 luminaflow-studio 同步之前已经保存的工作流。同步会先显示一次费用确认。</p><button type="button" className="empty-stage__action" onClick={() => void syncStoredWorkflows()} disabled={syncingLibrary}><RefreshCw size={15} className={syncingLibrary ? "is-spinning" : undefined} />{syncingLibrary ? "正在同步" : "同步现有工作流"}</button></div>}
            {!loadingLibrary && storedWorkflows.length > 0 && <div className="stored-workflow-list">{storedWorkflows.map((stored) => (
              <article key={stored.id}>
                <div><span className={`stored-status stored-status--${stored.status}`} aria-hidden="true" /><span><strong>{stored.name}</strong><small>{stored.sourceFilename}</small></span></div>
                <dl><div><dt>节点</dt><dd>{stored.nodeCount}</dd></div><div><dt>模型</dt><dd>{stored.models.length}</dd></div><div><dt>输入</dt><dd>{stored.imageInputs.length}</dd></div></dl>
                <footer>
                  <span>{stored.status === "ready" ? "可运行" : "需复查"} · 版本 {stored.revisionId.slice(0, 8)}</span>
                  {stored.status === "ready" && <Link to={`/?workflow=${stored.id}`}>运行</Link>}
                  {stored.status === "stale" && (
                    <button
                      type="button"
                      disabled={Boolean(recheckingId) || Boolean(installingKey) || analyzing}
                      onClick={() => void recheckStoredWorkflow(stored.id, stored.name)}
                    >
                      {recheckingId === stored.id && <span className="mini-spinner" />}
                      {recheckingId === stored.id ? "复查中" : "复查"}
                    </button>
                  )}
                </footer>
              </article>
            ))}</div>}
          </div>
          <footer><span>工作流版本保存在 Modal</span><span>节点环境变化后会自动标记需复查</span></footer>
        </section>
      </main>
    </div>
  );
}

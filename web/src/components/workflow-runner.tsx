import { Link } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileOutput, Maximize2, X } from "lucide-react";

import { costTargets } from "@shared/costs";
import { AppHeader } from "@/components/app-header";
import { costHeaders, useCostApproval } from "@/lib/cost-approval";
import type { JobResponse, StoredWorkflow, WorkflowImageInput, WorkflowParameterInput, WorkflowTextInput } from "@/lib/workflow-contract";
import { workflowNeedsVideoDurationRefresh } from "@/lib/workflow-contract";
import { isTerminalJobStatus, parseActiveRunJob, serializeActiveRunJob } from "@/lib/workflow-state";
import { discardUploads, uploadFile } from "@/lib/uploads";

const RUN_JOB_STORAGE_KEY = "comfy-desk.active-run-job";
const RUN_DRAFT_STORAGE_KEY = "lorachef.run-draft";
const CAMERA_NODE_TYPE = "QwenMultiangleCameraNode";
const CAMERA_CONTROL_NAMES = new Set(["horizontal_angle", "vertical_angle", "zoom"]);
const HIDDEN_CAMERA_CONTROL_NAMES = new Set(["default_prompts", "camera_view"]);

const HORIZONTAL_PRESETS = [
  { value: 0, label: "正面" },
  { value: 45, label: "右前" },
  { value: 90, label: "右侧" },
  { value: 135, label: "右后" },
  { value: 180, label: "背面" },
  { value: 225, label: "左后" },
  { value: 270, label: "左侧" },
  { value: 315, label: "左前" },
];
const VERTICAL_PRESETS = [
  { value: -30, label: "仰拍" },
  { value: 0, label: "平视" },
  { value: 30, label: "高位" },
  { value: 60, label: "俯拍" },
];
const ZOOM_PRESETS = [
  { value: 0, label: "远景" },
  { value: 4, label: "中景" },
  { value: 8, label: "特写" },
];

function horizontalView(value: number) {
  if (!Number.isFinite(value)) return "未设置";
  const angle = ((value % 360) + 360) % 360;
  if (angle < 22.5 || angle >= 337.5) return "正面";
  if (angle < 67.5) return "右前";
  if (angle < 112.5) return "右侧";
  if (angle < 157.5) return "右后";
  if (angle < 202.5) return "背面";
  if (angle < 247.5) return "左后";
  if (angle < 292.5) return "左侧";
  return "左前";
}

function verticalView(value: number) {
  if (!Number.isFinite(value)) return "未设置";
  if (value < -15) return "仰拍";
  if (value < 15) return "平视";
  if (value < 45) return "高位";
  return "俯拍";
}

function zoomView(value: number) {
  if (!Number.isFinite(value)) return "未设置";
  if (value < 2) return "远景";
  if (value < 6) return "中景";
  return "特写";
}

function readableRunError(message?: string) {
  if (!message) return "工作流运行失败，请重新运行或检查工作流资源。";
  if (
    message.toLowerCase().includes("sageattention")
    && message.toLowerCase().includes("cannot import name")
  ) {
    return "SageAttention 加速模式与云端版本不兼容。系统已关闭该加速，请重新运行工作流。";
  }
  const normalized = message.replaceAll("\\n", "\n");
  return normalized.length > 800 ? `${normalized.slice(0, 799)}…` : normalized;
}

function RuntimeInput({ item, label, file, disabled, onFile }: { item: WorkflowImageInput; label: string; file?: File; disabled: boolean; onFile: (file: File) => void }) {
  return (
    <label className={`runner-input ${file ? "runner-input--ready" : ""}`}>
      <input type="file" accept="image/*" disabled={disabled} onChange={(event) => {
        const selected = event.target.files?.[0];
        if (selected) onFile(selected);
      }} />
      <span className="runner-input__mark" aria-hidden="true">{file ? "✓" : "+"}</span>
      <span><strong>{label}</strong><small>{file?.name ?? `${item.classType} · 选择图像`}</small></span>
    </label>
  );
}

function TextParameter({ item, value, disabled, onChange }: { item: WorkflowTextInput; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <label className="runner-text-input">
      <span><strong>{item.label}</strong><small>{item.classType}</small></span>
      <textarea value={value} disabled={disabled} maxLength={20_000} rows={item.multiline ? 6 : 2} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function RuntimeParameter({ item, value, disabled, onChange }: { item: WorkflowParameterInput; value: string; disabled: boolean; onChange: (value: string) => void }) {
  if (item.kind === "boolean") {
    return (
      <label className="runner-boolean-input">
        <input type="checkbox" checked={value === "true"} disabled={disabled} onChange={(event) => onChange(String(event.target.checked))} />
        <span><strong>{item.label}</strong><small>{item.classType}</small></span>
      </label>
    );
  }
  return (
    <label className="runner-number-input">
      <span><strong>{item.label}</strong><small>{item.classType}</small></span>
      <input type="number" value={value} min={item.minimum} max={item.maximum} step={item.step ?? (item.kind === "integer" ? 1 : "any")} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function videoFrameCount(item: WorkflowParameterInput, value: string) {
  const seconds = Number(value);
  const frameRate = item.framesPerSecond;
  const frameStep = item.frameStep;
  const frameOffset = item.frameOffset;
  if (!Number.isFinite(seconds) || !frameRate || !frameStep || frameOffset === undefined) return undefined;
  const requestedFrames = Math.round(seconds * frameRate) + 1;
  let frames = Math.round((requestedFrames - frameOffset) / frameStep) * frameStep + frameOffset;
  if (item.minimumFrames !== undefined) frames = Math.max(frames, item.minimumFrames);
  if (item.maximumFrames !== undefined) frames = Math.min(frames, item.maximumFrames);
  return frames;
}

function VideoDurationParameter({ item, value, disabled, onChange }: { item: WorkflowParameterInput; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const numeric = Number(value);
  const frames = videoFrameCount(item, value);
  const alignedSeconds = frames !== undefined && item.framesPerSecond
    ? (frames - 1) / item.framesPerSecond
    : undefined;
  const presets = [2, 3, 5, 8, 10].filter(
    (preset) => (item.minimum === undefined || preset >= item.minimum) && (item.maximum === undefined || preset <= item.maximum),
  );
  return (
    <div className="video-duration-control" role="group" aria-label={item.label}>
      <div className="video-duration-control__heading">
        <strong>{item.label}</strong>
        <span>{frames === undefined || alignedSeconds === undefined ? "请输入有效秒数" : `约 ${alignedSeconds.toFixed(2)} 秒 · ${frames} 帧`}</span>
      </div>
      <div className="video-duration-control__inputs">
        <input type="range" aria-label="生成时长滑块" value={value} min={item.minimum} max={item.maximum} step={item.step ?? "any"} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
        <label><input type="number" aria-label="生成时长秒数" value={value} min={item.minimum} max={item.maximum} step={item.step ?? "any"} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><span>秒</span></label>
      </div>
      {presets.length ? <div className="video-duration-control__presets" aria-label="常用生成时长">
        {presets.map((preset) => <button key={preset} type="button" aria-pressed={Number.isFinite(numeric) && Math.abs(numeric - preset) < 0.0001} disabled={disabled} onClick={() => onChange(String(preset))}>{preset} 秒</button>)}
      </div> : null}
    </div>
  );
}

function CameraRangeControl({
  item,
  value,
  disabled,
  presets,
  description,
  unit,
  onChange,
}: {
  item: WorkflowParameterInput;
  value: string;
  disabled: boolean;
  presets: Array<{ value: number; label: string }>;
  description: string;
  unit?: string;
  onChange: (value: string) => void;
}) {
  const numeric = Number(value);
  return (
    <div className="camera-control" role="group" aria-label={item.label}>
      <div className="camera-control__heading">
        <strong>{item.label}</strong>
        <span>{description} · {Number.isFinite(numeric) ? `${value}${unit ?? ""}` : "请输入数值"}</span>
      </div>
      <div className="camera-control__inputs">
        <input
          type="range"
          aria-label={`${item.label}滑块`}
          value={value}
          min={item.minimum}
          max={item.maximum}
          step={item.step ?? (item.kind === "integer" ? 1 : "any")}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          type="number"
          aria-label={`${item.label}精确数值`}
          value={value}
          min={item.minimum}
          max={item.maximum}
          step={item.step ?? (item.kind === "integer" ? 1 : "any")}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <div className="camera-control__presets" aria-label={`${item.label}预设`}>
        {presets.map((preset) => (
          <button
            key={preset.value}
            type="button"
            aria-pressed={numeric === preset.value}
            disabled={disabled}
            onClick={() => onChange(String(preset.value))}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CameraParameters({ items, values, disabled, onChange }: {
  items: WorkflowParameterInput[];
  values: Record<string, string>;
  disabled: boolean;
  onChange: (fieldName: string, value: string) => void;
}) {
  const horizontal = items.find((item) => item.inputName === "horizontal_angle");
  const vertical = items.find((item) => item.inputName === "vertical_angle");
  const zoom = items.find((item) => item.inputName === "zoom");
  if (!horizontal || !vertical || !zoom) {
    return <>{items.map((item) => <RuntimeParameter key={item.fieldName} item={item} value={parameterValue(item, values)} disabled={disabled} onChange={(value) => onChange(item.fieldName, value)} />)}</>;
  }
  const horizontalValue = parameterValue(horizontal, values);
  const verticalValue = parameterValue(vertical, values);
  const zoomValue = parameterValue(zoom, values);
  const horizontalNumber = Number(horizontalValue);
  const verticalNumber = Number(verticalValue);
  const zoomNumber = Number(zoomValue);
  const summary = [
    Number.isFinite(horizontalNumber) ? horizontalView(horizontalNumber) : "水平未设置",
    Number.isFinite(verticalNumber) ? verticalView(verticalNumber) : "垂直未设置",
    Number.isFinite(zoomNumber) ? zoomView(zoomNumber) : "景别未设置",
  ].join(" · ");
  return (
    <div className="camera-parameters">
      <div className="camera-parameters__summary"><strong>当前镜头</strong><span>{summary}</span></div>
      <CameraRangeControl item={horizontal} value={horizontalValue} disabled={disabled} presets={HORIZONTAL_PRESETS} description={horizontalView(horizontalNumber)} unit="°" onChange={(value) => onChange(horizontal.fieldName, value)} />
      <CameraRangeControl item={vertical} value={verticalValue} disabled={disabled} presets={VERTICAL_PRESETS} description={verticalView(verticalNumber)} unit="°" onChange={(value) => onChange(vertical.fieldName, value)} />
      <CameraRangeControl item={zoom} value={zoomValue} disabled={disabled} presets={ZOOM_PRESETS} description={zoomView(zoomNumber)} onChange={(value) => onChange(zoom.fieldName, value)} />
    </div>
  );
}

function parameterValue(item: WorkflowParameterInput, values: Record<string, string>) {
  return values[item.fieldName] ?? String(item.currentValue);
}

function validParameterValue(item: WorkflowParameterInput, value: string) {
  if (item.kind === "boolean") return value === "true" || value === "false";
  if (!value.trim()) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric)
    && (item.kind !== "integer" || Number.isInteger(numeric))
    && (item.minimum === undefined || numeric >= item.minimum)
    && (item.maximum === undefined || numeric <= item.maximum);
}

function formatOutputBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_024 ** 2).toFixed(1)} MiB`;
}

function OutputGallery({ job, workflowName }: { job: JobResponse; workflowName?: string }) {
  const outputs = job.outputs?.length
    ? job.outputs
    : job.resultUrl
      ? [{ index: 0, filename: "result", mediaType: "image/*", bytes: 0, url: job.resultUrl }]
      : [];
  const dialog = useRef<HTMLDialogElement>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = outputs[selectedIndex] ?? outputs[0];
  const canNavigate = outputs.length > 1;
  const selectedPosition = Math.max(0, outputs.indexOf(selected));

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, outputs.length - 1)));
  }, [outputs.length]);

  function selectOutput(nextIndex: number) {
    setSelectedIndex((nextIndex + outputs.length) % outputs.length);
  }

  function openPreview() {
    if (!dialog.current?.open) dialog.current?.showModal();
  }

  function closePreview() {
    dialog.current?.close();
  }

  function restorePreviewFocus() {
    previewTrigger.current?.focus();
  }

  function handleNavigationKey(event: React.KeyboardEvent<HTMLElement>) {
    if (!canNavigate) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectOutput(selectedPosition - 1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectOutput(selectedPosition + 1);
    }
  }

  if (!selected) return null;
  const isImage = selected.mediaType.startsWith("image/");
  const isVideo = selected.mediaType.startsWith("video/");
  const canPreview = isImage || isVideo;
  const label = `${workflowName ?? "工作流"}的输出 ${selectedPosition + 1}`;
  const statusNotice = job.status === "processing"
    ? `已保存 ${outputs.length} 个结果，正在完成转存`
    : job.status === "failed"
      ? `已保存 ${outputs.length} 个结果；${readableRunError(job.message)}`
      : undefined;

  return (
    <div className="output-browser" aria-label={`${outputs.length} 个工作流输出`} onKeyDown={handleNavigationKey}>
      <div className="output-browser__main">
        {canPreview ? (
          <button ref={previewTrigger} type="button" className="output-browser__preview" onClick={openPreview} title="放大查看当前结果">
            {isImage
              ? <img src={selected.url} alt={label} />
              : <video src={selected.url} aria-label={label} controls />}
            <span className="output-browser__expand" aria-hidden="true"><Maximize2 size={18} /></span>
          </button>
        ) : (
          <div className="output-browser__file"><FileOutput size={28} /><strong>{selected.filename}</strong><span>{selected.mediaType}</span></div>
        )}
        {canNavigate && (
          <>
            <button type="button" className="output-browser__step output-browser__step--previous" onClick={() => selectOutput(selectedPosition - 1)} aria-label="查看上一个结果" title="上一个结果"><ChevronLeft size={22} /></button>
            <button type="button" className="output-browser__step output-browser__step--next" onClick={() => selectOutput(selectedPosition + 1)} aria-label="查看下一个结果" title="下一个结果"><ChevronRight size={22} /></button>
          </>
        )}
        <div className="output-browser__meta"><span>{selectedPosition + 1} / {outputs.length}</span><strong title={selected.filename}>{selected.filename}</strong><small>{formatOutputBytes(selected.bytes)}</small></div>
        <div className="output-browser__actions">
          <a href={selected.url} target="_blank" rel="noreferrer" aria-label="在新标签页打开原图" title="打开原图"><Maximize2 size={17} /></a>
          <a href={selected.url} download={selected.filename} aria-label="下载当前结果" title="下载"><Download size={17} /></a>
        </div>
      </div>
      {statusNotice && <p className={`output-browser__notice output-browser__notice--${job.status}`} role={job.status === "failed" ? "alert" : "status"}>{statusNotice}</p>}
      {canNavigate && (
        <div className="output-browser__thumbnails" role="tablist" aria-label="选择生成结果">
          {outputs.map((output, index) => {
            const active = index === selectedPosition;
            return (
              <button key={`${output.index}:${output.filename}`} type="button" className={active ? "is-selected" : ""} onClick={() => setSelectedIndex(index)} aria-selected={active} role="tab" aria-label={`查看结果 ${index + 1}`}>
                {output.mediaType.startsWith("image/")
                  ? <img src={output.url} alt="" loading="lazy" />
                  : <FileOutput size={18} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
      <dialog ref={dialog} className="output-preview-dialog" onClose={restorePreviewFocus} onKeyDown={handleNavigationKey}>
        <div className="output-preview-dialog__body">
          <header><div><strong>{selected.filename}</strong><small>结果 {selectedPosition + 1} / {outputs.length} · {formatOutputBytes(selected.bytes)}</small></div><button type="button" onClick={closePreview} aria-label="关闭预览" title="关闭"><X size={19} /></button></header>
          <div className="output-preview-dialog__media">{isImage ? <img src={selected.url} alt={label} /> : isVideo ? <video src={selected.url} aria-label={label} controls autoPlay /> : <FileOutput size={32} />}</div>
          <footer>{canNavigate && <div><button type="button" onClick={() => selectOutput(selectedPosition - 1)} aria-label="查看上一个结果" title="上一个结果"><ChevronLeft size={18} /></button><button type="button" onClick={() => selectOutput(selectedPosition + 1)} aria-label="查看下一个结果" title="下一个结果"><ChevronRight size={18} /></button></div>}<a href={selected.url} download={selected.filename}><Download size={16} />下载</a></footer>
        </div>
      </dialog>
    </div>
  );
}

export function WorkflowRunner({ isMock }: { isMock: boolean }) {
  const confirmCost = useCostApproval();
  const [workflows, setWorkflows] = useState<StoredWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>();
  const [variantId, setVariantId] = useState<string>();
  const [files, setFiles] = useState<Record<string, File>>({});
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [job, setJob] = useState<JobResponse>();
  const [error, setError] = useState<string>();
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readyWorkflows = useMemo(
    () => workflows.filter((workflow) => workflow.status === "ready"),
    [workflows],
  );
  const selected = readyWorkflows.find((workflow) => workflow.id === selectedId);
  const selectedVariant = selected?.variants?.find((variant) => variant.id === variantId);
  const activeImageInputs = selectedVariant?.imageInputs ?? selected?.imageInputs ?? [];
  const activeTextInputs = selectedVariant?.textInputs ?? selected?.textInputs ?? [];
  const activeParameterInputs = selectedVariant?.parameterInputs ?? selected?.parameterInputs ?? [];
  const videoDurationInputs = activeParameterInputs.filter((item) => item.semantic === "video-duration");
  const cameraParameterInputs = activeParameterInputs.filter(
    (item) => item.classType === CAMERA_NODE_TYPE && CAMERA_CONTROL_NAMES.has(item.inputName),
  );
  const genericParameterInputs = activeParameterInputs.filter(
    (item) => item.classType !== CAMERA_NODE_TYPE && item.semantic !== "video-duration",
  );
  const fallbackParameterInputs = activeParameterInputs.filter(
    (item) => item.classType === CAMERA_NODE_TYPE
      && !CAMERA_CONTROL_NAMES.has(item.inputName)
      && !HIDDEN_CAMERA_CONTROL_NAMES.has(item.inputName),
  );
  const visibleParameterInputs = [...videoDurationInputs, ...cameraParameterInputs, ...fallbackParameterInputs, ...genericParameterInputs];
  const activeOutputNodes = selectedVariant?.outputNodes ?? selected?.outputNodes ?? [];
  const defaultModeName = selected?.imageInputs?.length === 1 ? "单图" : "默认模式";
  const activeModeName = selectedVariant?.name ?? defaultModeName;
  const videoDurationNeedsRefresh = Boolean(selected && workflowNeedsVideoDurationRefresh(selected));
  const activeJobId = job?.status === "processing" ? job.jobId : undefined;
  const jobBusy = job?.status === "uploading" || job?.status === "processing";
  const missingInputs = selected ? activeImageInputs.some((item) => !files[item.fieldName]) : true;
  const invalidParameters = visibleParameterInputs.some((item) => !validParameterValue(item, parameterValue(item, parameterValues)));
  const canRun = Boolean(selected && !missingInputs && !invalidParameters && !jobBusy);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch("/api/workflows", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { workflows?: StoredWorkflow[]; message?: string };
        if (!response.ok) throw new Error(body.message ?? "工作流库读取失败");
        const loadedWorkflows = body.workflows ?? [];
        setWorkflows(loadedWorkflows);
        const requested = new URLSearchParams(window.location.search).get("workflow");
        const requestedWorkflow = loadedWorkflows.find((item) => item.id === requested && item.status === "ready");
        let draft: { workflowId?: string; fieldName?: string; content?: string } | undefined;
        try {
          draft = JSON.parse(sessionStorage.getItem(RUN_DRAFT_STORAGE_KEY) ?? "null") ?? undefined;
        } catch {
          sessionStorage.removeItem(RUN_DRAFT_STORAGE_KEY);
        }
        const draftWorkflow = loadedWorkflows.find((item) => item.id === draft?.workflowId && item.status === "ready");
        const draftFieldExists = Boolean(draftWorkflow && draft?.fieldName && [
          ...draftWorkflow.textInputs,
          ...(draftWorkflow.variants ?? []).flatMap((variant) => variant.textInputs),
        ].some((item) => item.fieldName === draft?.fieldName));
        if (draftWorkflow && draftFieldExists && draft?.fieldName && typeof draft.content === "string") {
          setSelectedId(draftWorkflow.id);
          setTextValues((current) => ({ ...current, [draft.fieldName!]: draft.content! }));
          sessionStorage.removeItem(RUN_DRAFT_STORAGE_KEY);
        } else {
          setSelectedId((current) => current ?? requestedWorkflow?.id ?? loadedWorkflows.find((item) => item.status === "ready")?.id);
          if (draft && !draftWorkflow) setError("提示词绑定的工作流当前不可运行，请先在工作流库完成检查");
          else if (draft && !draftFieldExists) setError("目标工作流已更新，原提示词字段已不存在");
        }
      })
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "工作流库读取失败");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(RUN_JOB_STORAGE_KEY);
    const activeRun = parseActiveRunJob(raw);
    if (!activeRun) {
      if (raw) localStorage.removeItem(RUN_JOB_STORAGE_KEY);
      return;
    }
    if (activeRun.workflowId) setSelectedId(activeRun.workflowId);
    setVariantId(activeRun.variantId);
    setTextValues(activeRun.textValues);
    setParameterValues(activeRun.parameterValues);
    setJob({ jobId: activeRun.jobId, status: "processing", message: "正在恢复云端任务状态" });
  }, []);

  useEffect(() => {
    if (!activeJobId || activeJobId === "pending") return;
    const jobId = activeJobId;
    let cancelled = false;
    let failures = 0;
    async function poll() {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const next = await response.json() as JobResponse;
        if (!response.ok) throw new Error(next.message ?? "任务状态查询失败");
        if (cancelled) return;
        failures = 0;
        if (
          isTerminalJobStatus(next.status)
          && parseActiveRunJob(localStorage.getItem(RUN_JOB_STORAGE_KEY))?.jobId === jobId
        ) {
          localStorage.removeItem(RUN_JOB_STORAGE_KEY);
        }
        if (next.workflowId) setSelectedId(next.workflowId);
        if (next.workflowVariantId) setVariantId(next.workflowVariantId);
        setJob(next);
        if (next.status === "processing") pollTimer.current = setTimeout(poll, 1_200);
      } catch (pollError) {
        if (cancelled) return;
        failures += 1;
        if (failures <= 5) {
          pollTimer.current = setTimeout(poll, Math.min(1_200 * 2 ** failures, 10_000));
        } else {
          setError(pollError instanceof Error ? `${pollError.message}；刷新页面可继续查询` : "任务状态查询失败");
        }
      }
    }
    pollTimer.current = setTimeout(poll, 700);
    return () => { cancelled = true; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [activeJobId]);

  function selectWorkflow(workflowId: string) {
    if (jobBusy) return;
    setSelectedId(workflowId);
    setVariantId(undefined);
    setFiles({});
    setTextValues({});
    setParameterValues({});
    setJob(undefined);
    setError(undefined);
  }

  function selectVariant(nextVariantId?: string) {
    if (jobBusy) return;
    setVariantId(nextVariantId);
    setParameterValues({});
    setJob(undefined);
    setError(undefined);
  }

  async function runWorkflow() {
    if (!selected || !canRun) return;
    setError(undefined);
    setJob({
      jobId: "pending",
      status: "uploading",
      message: "正在上传工作流输入",
      workflowId: selected.id,
      workflowName: selected.name,
      workflowVariantId: selectedVariant?.id,
      workflowVariantName: selectedVariant?.name,
    });
    const uploadedKeys: string[] = [];
    try {
      const submittedTextValues = Object.fromEntries(
        activeTextInputs.map((item) => [item.fieldName, textValues[item.fieldName] ?? item.currentValue]),
      );
      const submittedParameterValues = Object.fromEntries(
        visibleParameterInputs.map((item) => [item.fieldName, parameterValue(item, parameterValues)]),
      );
      const uploadedFiles = [];
      let uploadedBytes = 0;
      for (const item of activeImageInputs) {
        const uploaded = await uploadFile(files[item.fieldName]);
        uploadedKeys.push(uploaded.uploadKey);
        uploadedBytes += uploaded.bytes;
        uploadedFiles.push({ fieldName: item.fieldName, uploadKey: uploaded.uploadKey });
      }
      const approval = await confirmCost({
        action: "workflow-run",
        target: costTargets.workflowRun(selected.id, selectedVariant?.id),
        fileBytes: uploadedBytes,
        batchCount: 1,
      });
      if (!approval) {
        await discardUploads(uploadedKeys);
        setJob(undefined);
        return;
      }
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: costHeaders(approval, { "content-type": "application/json" }),
        body: JSON.stringify({
          workflowId: selected.id,
          variantId: selectedVariant?.id,
          fields: { ...submittedTextValues, ...submittedParameterValues },
          files: uploadedFiles,
        }),
      });
      const body = await response.json() as JobResponse & { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? body.message ?? "工作流提交失败");
      localStorage.setItem(RUN_JOB_STORAGE_KEY, serializeActiveRunJob({
        jobId: body.jobId,
        workflowId: selected.id,
        variantId: selectedVariant?.id,
        textValues: submittedTextValues,
        parameterValues: submittedParameterValues,
      }));
      setJob(body);
    } catch (runError) {
      if (uploadedKeys.length) await discardUploads(uploadedKeys);
      localStorage.removeItem(RUN_JOB_STORAGE_KEY);
      setJob({ jobId: "failed", status: "failed", message: runError instanceof Error ? runError.message : "工作流提交失败" });
    }
  }

  async function cancelJob() {
    if (!activeJobId) return;
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(activeJobId)}`, { method: "DELETE" });
      const body = await response.json() as JobResponse;
      if (!response.ok) throw new Error(body.message ?? "任务取消失败");
      localStorage.removeItem(RUN_JOB_STORAGE_KEY);
      setJob(body);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "任务取消失败");
    }
  }

  return (
    <div className="app-shell">
      <AppHeader isMock={isMock} />
      <main className="runner-shell">
        <aside className="runner-library" aria-label="可运行工作流">
          <div className="runner-heading"><h1>运行工作流</h1><p>选择一个已经通过云端检查的版本。</p></div>
          {loading && <div className="workflow-list-skeleton" aria-label="正在读取工作流"><span /><span /><span /></div>}
          {!loading && readyWorkflows.length === 0 && (
            <div className="runner-empty"><strong>还没有可运行工作流</strong><p>先到工作流库上传并通过云端检查。</p><Link to="/workflows">打开工作流库</Link></div>
          )}
          <div className="workflow-picker">
            {readyWorkflows.map((workflow) => (
              <button key={workflow.id} type="button" className={workflow.id === selectedId ? "is-selected" : ""} onClick={() => selectWorkflow(workflow.id)} disabled={jobBusy}>
                <span><strong>{workflow.name}</strong><small>版本 {workflow.revisionId.slice(0, 8)} · {workflow.nodeCount} 个节点 · {workflow.imageInputs.length}{workflow.variants?.length ? `–${Math.max(...workflow.variants.map((variant) => variant.imageInputs.length))}` : ""} 个图像输入</small></span>
                <i aria-hidden="true" />
              </button>
            ))}
          </div>
          {workflows.some((workflow) => workflow.status === "stale") && <p className="runner-stale-note">有工作流因节点环境变化需要在工作流库中复查。</p>}
        </aside>

        <section className="runner-controls" aria-label="工作流输入">
          {selected ? (
            <>
              <header><span className="ready-dot" aria-hidden="true" /><div><strong>{selected.name}</strong><small>版本 {selected.revisionId.slice(0, 8)} · {activeModeName}</small></div></header>
              <div className="runner-summary"><span><strong>{selectedVariant?.nodeCount ?? selected.nodeCount}</strong>节点</span><span><strong>{selected.models.length}</strong>模型</span><span><strong>{activeOutputNodes.length}</strong>输出</span></div>
              {selected.compatibilityAdjustments.length > 0 && (
                <div className="runner-compatibility-note" role="note">
                  <strong>云端兼容模式</strong>
                  <span>{selected.compatibilityAdjustments.map((item) => item.message).join("；")}</span>
                </div>
              )}
              {videoDurationNeedsRefresh && (
                <div className="runner-compatibility-note" role="note">
                  <strong>视频时长待启用</strong>
                  <span>复查当前工作流后即可按秒控制</span>
                  <Link to="/workflows">前往复查</Link>
                </div>
              )}
              <div className="runner-input-list">
                {selected.variants?.length ? (
                  <div className="runner-mode-field">
                    <div className="runner-section-title"><h2>输入模式</h2><span>{selectedVariant?.description ?? `${selected.imageInputs.length} 个默认图像输入`}</span></div>
                    <div className="runner-mode-options" role="group" aria-label="输入模式">
                      <button type="button" aria-pressed={!selectedVariant} className={!selectedVariant ? "is-selected" : ""} disabled={jobBusy} onClick={() => selectVariant(undefined)}>{defaultModeName}</button>
                      {selected.variants.map((variant) => <button key={variant.id} type="button" aria-pressed={variant.id === selectedVariant?.id} className={variant.id === selectedVariant?.id ? "is-selected" : ""} disabled={jobBusy} onClick={() => selectVariant(variant.id)}>{variant.name}</button>)}
                    </div>
                  </div>
                ) : null}
                {activeTextInputs.length ? (
                  <div className="runner-parameter-group">
                    <div className="runner-section-title"><h2>提示词</h2><span>{activeTextInputs.length} 项</span></div>
                    {activeTextInputs.map((item) => <TextParameter key={item.fieldName} item={item} value={textValues[item.fieldName] ?? item.currentValue} disabled={jobBusy} onChange={(value) => setTextValues((current) => ({ ...current, [item.fieldName]: value }))} />)}
                  </div>
                ) : null}
                {videoDurationInputs.length ? (
                  <div className="runner-parameter-group">
                    <div className="runner-section-title"><h2>视频设置</h2><span>{videoDurationInputs.length} 项</span></div>
                    {videoDurationInputs.map((item) => <VideoDurationParameter key={item.fieldName} item={item} value={parameterValue(item, parameterValues)} disabled={jobBusy} onChange={(value) => setParameterValues((current) => ({ ...current, [item.fieldName]: value }))} />)}
                  </div>
                ) : null}
                {visibleParameterInputs.length > videoDurationInputs.length ? (
                  <div className="runner-parameter-group">
                    <div className="runner-section-title"><h2>{cameraParameterInputs.length ? "相机视角" : "工作流参数"}</h2><span>{visibleParameterInputs.length - videoDurationInputs.length} 项</span></div>
                    {cameraParameterInputs.length ? <CameraParameters items={cameraParameterInputs} values={parameterValues} disabled={jobBusy} onChange={(fieldName, value) => setParameterValues((current) => ({ ...current, [fieldName]: value }))} /> : null}
                    {fallbackParameterInputs.map((item) => <RuntimeParameter key={item.fieldName} item={item} value={parameterValue(item, parameterValues)} disabled={jobBusy} onChange={(value) => setParameterValues((current) => ({ ...current, [item.fieldName]: value }))} />)}
                    {genericParameterInputs.map((item) => <RuntimeParameter key={item.fieldName} item={item} value={parameterValue(item, parameterValues)} disabled={jobBusy} onChange={(value) => setParameterValues((current) => ({ ...current, [item.fieldName]: value }))} />)}
                  </div>
                ) : null}
                <div className="runner-parameter-group">
                  <div className="runner-section-title"><h2>图像输入</h2><span>{activeImageInputs.filter((item) => files[item.fieldName]).length} / {activeImageInputs.length}</span></div>
                {activeImageInputs.length
                  ? activeImageInputs.map((item, index) => <RuntimeInput key={item.fieldName} item={item} label={activeImageInputs.length > 1 ? `图片 ${String.fromCharCode(65 + index)}` : "输入图片"} file={files[item.fieldName]} disabled={jobBusy} onFile={(file) => setFiles((current) => ({ ...current, [item.fieldName]: file }))} />)
                  : <p className="runner-no-input">该工作流没有图像输入，可以直接运行。</p>}
                </div>
              </div>
              <div className="runner-submit">
                {error && <p className="form-error" role="alert">{error}</p>}
                <button type="button" className="generate-button" disabled={!canRun} onClick={() => void runWorkflow()}>
                  {(job?.status === "uploading" || job?.status === "processing") && <span className="mini-spinner" />}
                  {job?.status === "uploading" ? "正在上传" : job?.status === "processing" ? "工作流运行中" : "运行工作流"}
                </button>
                {activeJobId && <button type="button" className="cancel-button" onClick={() => void cancelJob()}>取消云端任务</button>}
                <small>{missingInputs ? "请补齐工作流声明的图像输入" : invalidParameters ? "请检查工作流参数范围" : "运行时才会申请 L40S GPU"}</small>
              </div>
            </>
          ) : (
            <div className="runner-control-empty"><strong>选择一个工作流</strong><p>通过检查的工作流会显示在左侧。</p></div>
          )}
        </section>

        <section className="workflow-stage runner-stage" aria-label="工作流输出">
          <header><div><strong>{selected?.name ?? "等待选择工作流"}</strong>{selected && <span>{activeModeName} · {activeOutputNodes.length} 个输出节点</span>}</div>{job && <span role="status" className={`job-chip job-chip--${job.status}`}>{job.status === "succeeded" ? "已完成" : job.status === "failed" ? "失败" : job.status === "cancelled" ? "已取消" : "处理中"}</span>}</header>
          <div className="workflow-canvas">
            {!job && <div className="empty-stage"><span aria-hidden="true">▶</span><strong>{selected ? "准备运行" : "选择工作流后开始"}</strong><p>{selected ? "上传工作流需要的图像，生成结果会显示在这里。" : "运行页只显示已经通过云端检查的工作流版本。"}</p></div>}
            {(job?.status === "uploading" || (job?.status === "processing" && !job.outputs?.length)) && <div className="processing-preview" role="status"><span className="processing-orbit"><span /></span><strong>Modal 正在运行节点图</strong><span>{job.message}</span></div>}
            {job && (job.outputs?.length || (job.status === "succeeded" && job.resultUrl)) ? <OutputGallery job={job} workflowName={selected?.name ?? job.workflowName} /> : null}
            {job?.status === "failed" && !job.outputs?.length && <div className="inspection-stage"><span className="inspection-mark">!</span><strong>工作流运行失败</strong><p>{readableRunError(job.message)}</p></div>}
            {job?.status === "cancelled" && <div className="inspection-stage"><span className="inspection-mark">×</span><strong>云端任务已取消</strong><p>输入仍然保留，可以再次运行。</p></div>}
          </div>
          <footer><span>ComfyUI on Modal</span>{job?.resultUrl && <a href={job.resultUrl} download>下载首个结果</a>}</footer>
        </section>
      </main>
    </div>
  );
}

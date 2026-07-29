import { Download, ImagePlus, LoaderCircle, Sparkles, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { costTargets } from "@shared/costs";
import { AppHeader } from "@/components/app-header";
import { readJson } from "@/lib/api";
import { costHeaders, useCostApproval } from "@/lib/cost-approval";
import { discardUploads, uploadFile } from "@/lib/uploads";

interface ImageModel { id: string; label: string; }
interface ImageOutput { index: number; filename: string; mediaType: string; bytes: number; url: string; }
interface ImageResult { jobId: string; status: "queued" | "processing" | "succeeded" | "failed" | "cancelled"; message?: string; outputs?: ImageOutput[]; }

const MAX_PROMPT_CHARS = 20_000;
const MAX_REFERENCE_IMAGES = 16;
const REFERENCE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function ImageGeneratorPage() {
  const confirmCost = useCostApproval();
  const [configured, setConfigured] = useState<boolean>();
  const [defaultModel, setDefaultModel] = useState("");
  const [models, setModels] = useState<ImageModel[]>([]);
  const [mode, setMode] = useState<"generate" | "edit">("generate");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("auto");
  const [count, setCount] = useState("1");
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<ImageResult>();
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string>();
  const resultActive = result?.status === "queued" || result?.status === "processing";

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const configResponse = await fetch("/api/images/config", { signal: controller.signal });
        const config = await readJson<{ configured: boolean; defaultModel?: string }>(configResponse, "中转站配置读取失败");
        setConfigured(config.configured);
        let nextModels: ImageModel[] = [];
        let modelDefault = "";
        if (config.configured) {
          try {
            const modelResponse = await fetch("/api/images/models", { signal: controller.signal });
            const modelData = await readJson<{ models?: ImageModel[]; defaultModel?: string }>(modelResponse, "中转站模型读取失败");
            nextModels = modelData.models ?? [];
            modelDefault = modelData.defaultModel ?? "";
          } catch (modelError) {
            if (modelError instanceof DOMException && modelError.name === "AbortError") throw modelError;
            setError("模型列表读取失败，可以手动填写模型 ID 后继续");
          }
        } else {
          setError("中转站尚未配置，请在 Cloudflare Worker Secret 中填写 WISART_API_KEY");
        }
        const nextDefault = config.defaultModel || modelDefault || nextModels[0]?.id || "";
        setDefaultModel(nextDefault);
        setModels(nextModels);
        setModel(nextDefault);
      } catch (loadError) {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) setError(loadError instanceof Error ? loadError.message : "中转站配置读取失败");
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const runId = localStorage.getItem("wisart:last-run") ?? "";
    if (!/^[a-f0-9]{32}$/.test(runId)) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/images/${runId}`, { signal: controller.signal });
        if (response.status === 404) {
          localStorage.removeItem("wisart:last-run");
          return;
        }
        setResult(await readJson<ImageResult>(response, "上次图片任务读取失败"));
      } catch (restoreError) {
        if (!(restoreError instanceof DOMException && restoreError.name === "AbortError")) {
          setError(restoreError instanceof Error ? restoreError.message : "上次图片任务读取失败");
        }
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!result?.jobId || !resultActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/images/${result.jobId}`, { signal: controller.signal });
        const next = await readJson<ImageResult>(response, "图片任务状态读取失败");
        setResult(next);
        if (next.status === "failed") setError(next.message ?? "中转站生图失败");
        else {
          setError(undefined);
          if (next.status === "queued" || next.status === "processing") {
            timer = setTimeout(() => void poll(), 3_000);
          }
        }
      } catch (pollError) {
        if (pollError instanceof DOMException && pollError.name === "AbortError") return;
        setError(`${pollError instanceof Error ? pollError.message : "图片任务状态读取失败"}；云端任务不会自动重提`);
        timer = setTimeout(() => void poll(), 5_000);
      }
    };
    timer = setTimeout(() => void poll(), 1_500);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [result?.jobId, resultActive]);

  const previewUrls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previewUrls.forEach((url) => URL.revokeObjectURL(url)), [previewUrls]);

  function selectFiles(next: FileList | null) {
    if (!next) return;
    setError(undefined);
    const selected = [...next].filter((file) => REFERENCE_IMAGE_TYPES.has(file.type) && file.size <= 25 * 1024 * 1024);
    if (selected.length !== next.length) setError("只支持 25 MB 以内的 PNG、JPEG 或 WebP 图片");
    const combined = [...files, ...selected].slice(0, MAX_REFERENCE_IMAGES);
    let total = 0;
    const accepted = combined.filter((file) => {
      total += file.size;
      return total <= 80 * 1024 * 1024;
    });
    if (accepted.length !== combined.length) setError("参考图总大小不能超过 80 MB");
    setFiles(accepted);
  }

  async function generate() {
    if (generating) return;
    const selectedModel = model.trim() || defaultModel.trim();
    const n = Number(count);
    if (!prompt.trim()) { setError("请输入提示词"); return; }
    if (!selectedModel) { setError("请选择模型"); return; }
    if (mode === "edit" && !files.length) { setError("图生图至少需要一张参考图"); return; }
    if (!Number.isInteger(n) || n < 1 || n > 5) { setError("生成张数范围为 1–5"); return; }
    setGenerating(true);
    setError(undefined);
    setResult(undefined);
    const uploadedKeys: string[] = [];
    let submitted = false;
    let requestRejected = false;
    let clientRunId = "";
    try {
      let uploadedBytes = 0;
      for (const file of mode === "edit" ? files : []) {
        const uploaded = await uploadFile(file);
        uploadedKeys.push(uploaded.uploadKey);
        uploadedBytes += uploaded.bytes;
      }
      const approval = await confirmCost({
        action: "wisart-image",
        target: costTargets.wisartImage(mode, selectedModel, size, quality, n),
        fileBytes: uploadedBytes,
        batchCount: 1,
      });
      if (!approval) {
        await discardUploads(uploadedKeys);
        return;
      }
      submitted = true;
      clientRunId = crypto.randomUUID().replaceAll("-", "");
      localStorage.setItem("wisart:last-run", clientRunId);
      const response = await fetch("/api/images/generate", {
        method: "POST",
        headers: costHeaders(approval, { "content-type": "application/json" }),
        body: JSON.stringify({ runId: clientRunId, mode, prompt: prompt.trim(), model: selectedModel, size, quality, n, uploadKeys: uploadedKeys }),
      });
      const body = await response.json() as ImageResult & { message?: string };
      if (!response.ok) {
        requestRejected = true;
        localStorage.removeItem("wisart:last-run");
        throw new Error(body.message ?? "中转站生图失败");
      }
      setResult(body);
      localStorage.setItem("wisart:last-run", body.jobId);
      setFiles([]);
    } catch (generationError) {
      if (!submitted) await discardUploads(uploadedKeys);
      if (submitted && !requestRejected && clientRunId) {
        try {
          const recovery = await fetch(`/api/images/${clientRunId}`);
          if (recovery.ok) {
            setResult(await readJson<ImageResult>(recovery, "图片任务恢复失败"));
            setFiles([]);
            return;
          }
        } catch { /* preserve the original submission error */ }
      }
      setError(generationError instanceof Error ? generationError.message : "中转站生图失败");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader isMock={false} />
      <main className="image-generator-shell">
        <header className="page-heading"><div><h1>中转站生图</h1><p>文生图与图生图，结果自动保存到作品库。</p></div><span className={`service-pill ${configured ? "service-pill--good" : ""}`}><span aria-hidden="true" />{loading ? "检查中" : configured ? "已连接" : "未配置"}</span></header>
        <div className="image-generator-layout">
          <section className="image-generator-form">
            <div className="image-mode-tabs" role="group" aria-label="生成模式">
              <button type="button" disabled={generating} className={mode === "generate" ? "is-selected" : ""} aria-pressed={mode === "generate"} onClick={() => setMode("generate")}><Sparkles size={16} />文生图</button>
              <button type="button" disabled={generating} className={mode === "edit" ? "is-selected" : ""} aria-pressed={mode === "edit"} onClick={() => setMode("edit")}><ImagePlus size={16} />图生图</button>
            </div>
            <label className="image-generator-field"><span>提示词</span><textarea value={prompt} disabled={generating} maxLength={MAX_PROMPT_CHARS} rows={12} placeholder={mode === "edit" ? "描述希望如何修改参考图…" : "描述你想生成的画面…"} onChange={(event) => setPrompt(event.target.value)} /><small>{prompt.length.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()}</small></label>
            {mode === "edit" && <div className="image-reference-field"><div className="image-generator-field__heading"><span>参考图</span><small>{files.length} / {MAX_REFERENCE_IMAGES}</small></div><label className="image-reference-drop"><input type="file" disabled={generating} accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { selectFiles(event.target.files); event.currentTarget.value = ""; }} /><ImagePlus size={20} /><span><strong>添加参考图</strong><small>支持 PNG、JPEG、WebP，单张 25 MB、总计 80 MB 以内</small></span></label>{files.length > 0 && <div className="image-reference-grid">{files.map((file, index) => <figure key={`${file.name}-${file.lastModified}-${index}`}><img src={previewUrls[index]} alt={file.name} /><button type="button" disabled={generating} title="移除参考图" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></figure>)}</div>}</div>}
            <div className="image-generator-options">
              <label><span>模型</span>{models.length ? <select value={model} disabled={generating} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select> : <input value={model} disabled={generating} placeholder={defaultModel || "模型 ID"} onChange={(event) => setModel(event.target.value)} />}</label>
              <label><span>尺寸</span><select value={size} disabled={generating} onChange={(event) => setSize(event.target.value)}><option value="auto">自动</option><option value="1:1">1:1</option><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="4:3">4:3</option><option value="3:4">3:4</option><option value="1024x1024">1024 × 1024</option></select></label>
              <label><span>质量</span><select value={quality} disabled={generating || mode === "edit"} onChange={(event) => setQuality(event.target.value)}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
              <label><span>张数</span><select value={count} disabled={generating} onChange={(event) => setCount(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} 张</option>)}</select></label>
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button type="button" className="image-generate-button" disabled={generating || resultActive || loading || configured === false} onClick={() => void generate()}>{generating ? <><LoaderCircle size={17} className="spin" />正在提交</> : resultActive ? <><LoaderCircle size={17} className="spin" />后台生成中</> : <><WandSparkles size={17} />开始生成</>}</button>
            <small className="image-generator-note">每次提交前会显示中转站积分确认；不会自动重试。</small>
          </section>
          <section className="image-generator-results" aria-live="polite">
            {!result && <div className="image-results-empty"><WandSparkles size={28} /><strong>生成结果</strong><p>生成后的图片会显示在这里，并同步到作品库。</p></div>}
            {resultActive && <div className="image-results-empty" role="status"><LoaderCircle size={28} className="spin" /><strong>{result.status === "queued" ? "等待后台任务" : "中转站正在生成"}</strong><p>{result.message ?? "可以关闭页面，任务仍会继续。"}</p></div>}
            {(result?.status === "failed" || result?.status === "cancelled") && <div className="image-results-empty"><X size={28} /><strong>生成未完成</strong><p>{result.message ?? "任务失败，未自动重提。"}</p></div>}
            {result?.outputs?.length ? <div className="image-results-grid">{result.outputs.map((output) => <figure key={output.index}><div><img src={output.url} alt={output.filename} /></div><figcaption><span>{output.filename}</span><a href={output.url} download={output.filename} title="下载原图"><Download size={16} /></a></figcaption></figure>)}</div> : null}
          </section>
        </div>
      </main>
    </div>
  );
}

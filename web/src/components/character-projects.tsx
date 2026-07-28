import { Link } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { costTargets } from "@shared/costs";
import { AppHeader } from "@/components/app-header";
import {
  CHARACTER_PROJECT_TARGETS,
  CHARACTER_VIEW_PRESETS,
  characterProjectActive,
  characterWorkflowCompatible,
  defaultCharacterViewIds,
  type CharacterGenerationBatch,
  type CharacterProject,
  type CharacterProjectTarget,
} from "@/lib/character-project";
import type { StoredWorkflow } from "@/lib/workflow-contract";
import { costHeaders, useCostApproval } from "@/lib/cost-approval";
import { discardUploads, uploadFile } from "@/lib/uploads";

const TARGET_LABELS: Record<CharacterProjectTarget, string> = {
  sd15: "SD 1.5",
  sdxl: "SDXL",
  flux_rank64: "FLUX · Rank 64",
  flux_rank128: "FLUX · Rank 128",
};

const BATCH_LABELS: Record<CharacterGenerationBatch["status"], string> = {
  queued: "等待生成",
  generating: "云端生成中",
  analyzing: "LoRAChef 筛选中",
  succeeded: "筛选完成",
  partial: "部分完成",
  failed: "生成失败",
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function reportStats(batch: CharacterGenerationBatch) {
  const report = batch.analysis.report;
  if (!report || typeof report !== "object") return undefined;
  const stats = report.stats;
  return stats && typeof stats === "object" && !Array.isArray(stats)
    ? stats as Record<string, unknown>
    : undefined;
}

export function CharacterProjects({ isMock }: { isMock: boolean }) {
  const confirmCost = useCostApproval();
  const [projects, setProjects] = useState<CharacterProject[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState<CharacterProject>();
  const [workflows, setWorkflows] = useState<StoredWorkflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [viewIds, setViewIds] = useState<string[]>(defaultCharacterViewIds());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [retryingBatchId, setRetryingBatchId] = useState<string>();
  const [deletingProject, setDeletingProject] = useState(false);
  const [workflowLoading, setWorkflowLoading] = useState(true);
  const [workflowError, setWorkflowError] = useState<string>();
  const [workflowReloadKey, setWorkflowReloadKey] = useState(0);
  const [pollKey, setPollKey] = useState(0);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [triggerWord, setTriggerWord] = useState("ohwx woman");
  const [target, setTarget] = useState<CharacterProjectTarget>("flux_rank128");
  const [reference, setReference] = useState<File>();

  const compatibleWorkflows = useMemo(
    () => workflows.filter(characterWorkflowCompatible),
    [workflows],
  );
  const selectedBatch = selected?.batches[0];
  const selectedCandidates = selectedBatch
    ? selected?.candidates.filter((candidate) => candidate.batchId === selectedBatch.id) ?? []
    : [];

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    void fetch("/api/projects", { cache: "no-store", signal: controller.signal }).then(async (projectsResponse) => {
      const projectBody = await projectsResponse.json() as { projects?: CharacterProject[]; warnings?: string[]; message?: string };
      if (!projectsResponse.ok) throw new Error(projectBody.message ?? "人物项目读取失败");
      if (stopped) return;
      const nextProjects = projectBody.projects ?? [];
      setProjects(nextProjects);
      setSelectedId((current) => {
        const next = current ?? nextProjects[0]?.id;
        selectedIdRef.current = next;
        return next;
      });
      setCreateOpen(nextProjects.length === 0);
      if (projectBody.warnings?.length) setError(projectBody.warnings.join("；"));
    }).catch((loadError) => {
      if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
        setError(loadError instanceof Error ? loadError.message : "人物项目读取失败");
      }
    }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; controller.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setWorkflowLoading(true);
    setWorkflowError(undefined);
    void fetch("/api/workflows", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json() as { workflows?: StoredWorkflow[]; message?: string };
      if (!response.ok) throw new Error(body.message ?? "工作流读取失败");
      if (stopped) return;
      const nextWorkflows = body.workflows ?? [];
      setWorkflows(nextWorkflows);
      const nextCompatible = nextWorkflows.filter(characterWorkflowCompatible);
      setWorkflowId((current) => nextCompatible.some((workflow) => workflow.id === current)
        ? current
        : nextCompatible[0]?.id || "");
    }).catch((loadError) => {
      if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
        setWorkflows([]);
        setWorkflowId("");
        setWorkflowError(loadError instanceof Error ? loadError.message : "工作流读取失败");
      }
    }).finally(() => { if (!stopped) setWorkflowLoading(false); });
    return () => { stopped = true; controller.abort(); };
  }, [workflowReloadKey]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(undefined);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(selectedId!)}`, { cache: "no-store" });
        const body = await response.json() as CharacterProject & { message?: string };
        if (!response.ok) throw new Error(body.message ?? "人物项目读取失败");
        if (stopped) return;
        setSelected(body);
        setProjects((current) => current.map((project) => project.id === body.id ? body : project));
        if (characterProjectActive(body)) timer = setTimeout(refresh, 1_500);
      } catch (refreshError) {
        if (!stopped) setError(refreshError instanceof Error ? refreshError.message : "人物项目读取失败");
      }
    }
    void refresh();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [selectedId, pollKey]);

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reference || creating) return;
    setCreating(true);
    setError(undefined);
    let uploadKey: string | undefined;
    try {
      uploadKey = (await uploadFile(reference)).uploadKey;
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, triggerWord, target, uploadKey }),
      });
      const body = await response.json() as CharacterProject & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "人物项目创建失败");
      setProjects((current) => [body, ...current]);
      selectProject(body.id);
      setSelected(body);
      setName("");
      setReference(undefined);
      setCreateOpen(false);
    } catch (createError) {
      if (uploadKey) await discardUploads([uploadKey]);
      setError(createError instanceof Error ? createError.message : "人物项目创建失败");
    } finally {
      setCreating(false);
    }
  }

  function toggleView(viewId: string) {
    setViewIds((current) => current.includes(viewId)
      ? current.filter((item) => item !== viewId)
      : [...current, viewId]);
  }

  function selectProject(projectId: string) {
    selectedIdRef.current = projectId;
    setSelectedId(projectId);
  }

  async function createBatch() {
    if (!selected || !workflowId || !viewIds.length || generating) return;
    setGenerating(true);
    setError(undefined);
    try {
      const approval = await confirmCost({
        action: "character-batch",
        target: costTargets.characterBatch(selected.id, workflowId),
        fileBytes: selected.referenceBytes,
        batchCount: viewIds.length,
      });
      if (!approval) return;
      const response = await fetch(`/api/projects/${encodeURIComponent(selected.id)}/batches`, {
        method: "POST",
        headers: costHeaders(approval, { "content-type": "application/json" }),
        body: JSON.stringify({ workflowId, viewIds }),
      });
      const body = await response.json() as CharacterProject & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "多视角任务创建失败");
      if (selectedIdRef.current === body.id) setSelected(body);
      setProjects((current) => current.map((project) => project.id === body.id ? body : project));
      setPollKey((current) => current + 1);
    } catch (batchError) {
      setError(batchError instanceof Error ? batchError.message : "多视角任务创建失败");
    } finally {
      setGenerating(false);
    }
  }

  async function retryAnalysis(batchId: string) {
    if (!selected || retryingBatchId) return;
    setRetryingBatchId(batchId);
    setError(undefined);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(selected.id)}/batches/${encodeURIComponent(batchId)}/analysis`, { method: "POST" });
      const body = await response.json() as CharacterProject & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "LoRAChef 重新筛选失败");
      if (selectedIdRef.current === body.id) setSelected(body);
      setProjects((current) => current.map((project) => project.id === body.id ? body : project));
      setPollKey((current) => current + 1);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "LoRAChef 重新筛选失败");
    } finally {
      setRetryingBatchId(undefined);
    }
  }

  async function deleteProject() {
    if (!selected || deletingProject || characterProjectActive(selected)) return;
    if (!window.confirm(`删除人物项目“${selected.name}”及参考图？已生成作品仍保留在作品库。`)) return;
    setDeletingProject(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? "人物项目删除失败");
      const remaining = projects.filter((project) => project.id !== selected.id);
      const nextId = remaining[0]?.id;
      setProjects(remaining);
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      setSelected(undefined);
      setCreateOpen(remaining.length === 0);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "人物项目删除失败");
    } finally {
      setDeletingProject(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader isMock={isMock} />
      <main className="character-shell" aria-busy={loading}>
        <aside className="character-sidebar" aria-label="人物项目">
          <header className="character-sidebar__heading">
            <div><h1>人物项目</h1><p>从一张参考图开始补齐训练素材。</p></div>
            <button type="button" onClick={() => setCreateOpen((current) => !current)} aria-expanded={createOpen}>新建</button>
          </header>

          {createOpen && (
            <form className="character-create" onSubmit={createProject}>
              <label><span>项目名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：人物 A" maxLength={80} required /></label>
              <label><span>触发词</span><input value={triggerWord} onChange={(event) => setTriggerWord(event.target.value)} maxLength={160} required /></label>
              <label><span>训练目标</span><select value={target} onChange={(event) => setTarget(event.target.value as CharacterProjectTarget)}>{CHARACTER_PROJECT_TARGETS.map((item) => <option key={item} value={item}>{TARGET_LABELS[item]}</option>)}</select></label>
              <label className="character-reference-input"><span>人物参考图</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setReference(event.target.files?.[0])} required /><small>{reference ? `${reference.name} · ${formatBytes(reference.size)}` : "PNG、JPEG 或 WebP，不超过 25 MB"}</small></label>
              <button className="character-primary" type="submit" disabled={creating || !reference}>{creating ? "正在创建" : "创建人物项目"}</button>
            </form>
          )}

          {loading && <div className="character-list-skeleton" role="status" aria-live="polite"><span /><span /><span /><p className="sr-only">正在读取人物项目</p></div>}
          {!loading && projects.length === 0 && !createOpen && <div className="character-sidebar__empty"><strong>还没有人物项目</strong><p>创建项目后，参考图只需上传一次。</p></div>}
          <div className="character-project-list">
            {projects.map((project) => {
              const active = characterProjectActive(project);
              return (
                <button key={project.id} type="button" className={project.id === selectedId ? "is-selected" : ""} onClick={() => selectProject(project.id)}>
                  <img src={`/api/projects/${project.id}/reference`} alt="" />
                  <span><strong>{project.name}</strong><small>{TARGET_LABELS[project.target]} · {project.candidates.length} 张候选</small></span>
                  <i className={active ? "is-active" : ""} aria-label={active ? "任务进行中" : "没有进行中的任务"} />
                </button>
              );
            })}
          </div>
        </aside>

        <section className="character-workspace">
          {error && <div className="character-error" role="alert"><span>!</span><p>{error}</p><button type="button" onClick={() => setError(undefined)}>关闭</button></div>}
          {!selected ? (
            <div className="character-workspace__empty"><strong>选择或创建人物项目</strong><p>人物项目会保存参考图、生成参数、候选素材和 LoRAChef 筛选结果。</p></div>
          ) : (
            <>
              <header className="character-identity">
                <img src={`/api/projects/${selected.id}/reference`} alt={`${selected.name} 的人物参考图`} />
                <div><span>当前人物</span><h2>{selected.name}</h2><p><code>{selected.triggerWord}</code><span>{TARGET_LABELS[selected.target]}</span></p><button className="character-delete" type="button" disabled={deletingProject || characterProjectActive(selected)} title={characterProjectActive(selected) ? "任务完成后才能删除项目" : "删除项目和参考图，保留已生成作品"} onClick={() => void deleteProject()}><Trash2 size={15} />{deletingProject ? "正在删除" : "删除项目"}</button></div>
                <dl><div><dt>候选素材</dt><dd>{selected.candidates.length}</dd></div><div><dt>已接受</dt><dd>{selected.candidates.filter((candidate) => candidate.reviewStatus === "accepted").length}</dd></div><div><dt>已拒绝</dt><dd>{selected.candidates.filter((candidate) => candidate.reviewStatus === "rejected").length}</dd></div></dl>
              </header>

              <section className="character-planner" aria-labelledby="view-plan-title">
                <header><div><h2 id="view-plan-title">补充多视角素材</h2><p>同一批次串行运行，优先复用已加载的 L40S 容器。</p></div><span>{viewIds.length} 个视角</span></header>
                {!workflowLoading && compatibleWorkflows.length ? (
                  <label className="character-workflow-select"><span>生成工作流</span><select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} disabled={characterProjectActive(selected)}>{compatibleWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name} · {workflow.revisionId.slice(0, 8)}</option>)}</select></label>
                ) : (
                  <div className="character-workflow-missing" role={workflowError ? "alert" : "status"}><strong>{workflowLoading ? "正在读取多视角工作流" : workflowError ? "Modal 工作流暂不可用" : "没有可用的多视角工作流"}</strong><p>{workflowLoading ? "本地人物项目仍可正常浏览。" : workflowError ?? "工作流需要一个图像输入，并暴露水平角度、垂直角度和缩放参数。"}</p>{workflowError ? <button type="button" onClick={() => setWorkflowReloadKey((current) => current + 1)}>重新连接 Modal</button> : !workflowLoading ? <Link to="/workflows">前往工作流库</Link> : null}</div>
                )}
                <div className="character-view-grid" role="group" aria-label="选择生成视角">
                  {CHARACTER_VIEW_PRESETS.map((view) => {
                    const checked = viewIds.includes(view.id);
                    return <button key={view.id} type="button" aria-pressed={checked} className={checked ? "is-selected" : ""} disabled={characterProjectActive(selected)} onClick={() => toggleView(view.id)}><span><strong>{view.label}</strong><small>{view.description}</small></span><code>{view.horizontalAngle}° / {view.verticalAngle}° / {view.zoom}</code></button>;
                  })}
                </div>
                <div className="character-plan-submit"><button className="character-primary" type="button" disabled={workflowLoading || !compatibleWorkflows.length || !viewIds.length || characterProjectActive(selected) || generating} onClick={() => void createBatch()}>{generating ? "正在创建批次" : `生成 ${viewIds.length} 个视角`}</button><small>{characterProjectActive(selected) ? "当前批次完成前不能重复提交" : "所有人物项目共享一个串行 GPU 队列"}</small></div>
              </section>

              {selectedBatch && (
                <section className="character-batch" aria-labelledby="batch-title">
                  <header><div><h2 id="batch-title">最新生成批次</h2><p>{selectedBatch.workflowName} · 版本 {selectedBatch.workflowRevisionId.slice(0, 8)}</p></div><span className={`character-batch-status character-batch-status--${selectedBatch.status}`}>{BATCH_LABELS[selectedBatch.status]}</span></header>
                  <div className="character-view-progress">
                    {selectedBatch.views.map((view) => <div key={view.id} className={`character-view-progress__item is-${view.status}`}><span aria-hidden="true" /><div><strong>{view.label}</strong><small>{view.message ?? (view.status === "queued" ? "等待前一个视角" : "")}</small></div></div>)}
                  </div>
                  <div className={`character-analysis character-analysis--${selectedBatch.analysis.status}`} aria-live="polite">
                    <span aria-hidden="true" />
                    <div><strong>{selectedBatch.analysis.status === "waiting-agent" ? "等待 LoRAChef Local Agent" : "LoRAChef 自动筛选"}</strong><p>{selectedBatch.analysis.message ?? "生成完成后自动进行身份、质量和数据集结构检查。"}</p></div>
                    {typeof selectedBatch.analysis.progress === "number" && <b>{selectedBatch.analysis.progress}%</b>}
                    {["succeeded", "failed"].includes(selectedBatch.analysis.status) && <button type="button" disabled={Boolean(retryingBatchId)} onClick={() => void retryAnalysis(selectedBatch.id)}>{retryingBatchId ? "正在提交" : "重新筛选"}</button>}
                  </div>
                  {reportStats(selectedBatch) && <div className="character-report-summary"><span>总计 <strong>{String(reportStats(selectedBatch)?.total ?? 0)}</strong></span><span>保留 <strong>{String(reportStats(selectedBatch)?.kept ?? 0)}</strong></span><span>剔除 <strong>{String(reportStats(selectedBatch)?.dropped ?? 0)}</strong></span></div>}
                </section>
              )}

              <section className="character-candidates" aria-labelledby="candidates-title">
                <header><div><h2 id="candidates-title">候选素材</h2><p>生成参数与筛选结果保存在每张图片上。</p></div><span>{selectedCandidates.length} 张</span></header>
                {selectedCandidates.length ? (
                  <div className="character-candidate-grid">
                    {selectedCandidates.map((candidate) => (
                      <figure key={candidate.id} className={`character-candidate is-${candidate.reviewStatus}`}>
                        <div><img src={`/api/projects/${selected.id}/candidates/${candidate.id}`} alt={`${candidate.viewLabel}候选素材`} loading="lazy" /><span>{candidate.reviewStatus === "accepted" ? "已接受" : candidate.reviewStatus === "rejected" ? "已拒绝" : "待筛选"}</span></div>
                        <figcaption><strong>{candidate.viewLabel}</strong><small>{candidate.horizontalAngle}° · {candidate.verticalAngle}° · 缩放 {candidate.zoom}</small>{candidate.quality?.similarity !== undefined && candidate.quality.similarity !== null && <small>身份相似度 {candidate.quality.similarity.toFixed(3)}</small>}{candidate.quality?.reasons?.length ? <p>{candidate.quality.reasons.join("；")}</p> : null}</figcaption>
                      </figure>
                    ))}
                  </div>
                ) : (
                  <div className="character-candidates__empty"><strong>还没有候选素材</strong><p>选择一组视角开始生成，结果会自动落入这里。</p></div>
                )}
              </section>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

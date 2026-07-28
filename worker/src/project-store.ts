import type { Env } from "./env";
import { parseJson, validId } from "./utils";

interface ProjectRow {
  id: string;
  name: string;
  trigger_word: string;
  target: string;
  reference_key: string;
  reference_filename: string;
  reference_media_type: string;
  reference_bytes: number;
  created_at: number;
  updated_at: number;
}

interface BatchRow {
  id: string;
  workflow_id: string;
  workflow_revision_id: string;
  workflow_name: string;
  status: string;
  analysis_status: string;
  analysis_message: string | null;
  analysis_progress: number | null;
  report_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ViewRow {
  id: string;
  batch_id: string;
  label: string;
  description: string;
  horizontal_angle: number;
  vertical_angle: number;
  zoom: number;
  bucket: string;
  status: string;
  message: string | null;
}

interface CandidateRow {
  id: string;
  batch_id: string;
  view_id: string;
  label: string;
  object_key: string;
  filename: string;
  media_type: string;
  bytes: number;
  review_status: string;
  quality_json: string | null;
  horizontal_angle: number;
  vertical_angle: number;
  zoom: number;
  workflow_id: string;
  workflow_revision_id: string;
  modal_job_id: string | null;
  created_at: number;
}

export async function loadProject(env: Env, ownerEmail: string, projectId: string) {
  validId(projectId);
  const project = await env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND owner_email = ?2",
  ).bind(projectId, ownerEmail).first<ProjectRow>();
  if (!project) throw new Error("人物项目不存在");

  const [batchResult, viewResult, candidateResult] = await Promise.all([
    env.DB.prepare("SELECT * FROM batches WHERE project_id = ?1 ORDER BY created_at DESC").bind(projectId).all<BatchRow>(),
    env.DB.prepare("SELECT v.* FROM batch_views v JOIN batches b ON b.id = v.batch_id WHERE b.project_id = ?1 ORDER BY v.position").bind(projectId).all<ViewRow>(),
    env.DB.prepare(`SELECT c.*, v.label, v.horizontal_angle, v.vertical_angle, v.zoom,
      b.workflow_id, b.workflow_revision_id, r.modal_job_id
      FROM candidates c
      JOIN batch_views v ON v.id = c.view_id
      JOIN batches b ON b.id = c.batch_id
      LEFT JOIN runs r ON r.id = v.run_id
      WHERE c.project_id = ?1 ORDER BY c.created_at`).bind(projectId).all<CandidateRow>(),
  ]);

  const viewsByBatch = new Map<string, ViewRow[]>();
  for (const view of viewResult.results) viewsByBatch.set(view.batch_id, [...(viewsByBatch.get(view.batch_id) ?? []), view]);
  return {
    id: project.id,
    name: project.name,
    triggerWord: project.trigger_word,
    target: project.target,
    referenceFilename: project.reference_filename,
    referenceMediaType: project.reference_media_type,
    referenceBytes: project.reference_bytes,
    batches: batchResult.results.map((batch) => ({
      id: batch.id,
      workflowId: batch.workflow_id,
      workflowRevisionId: batch.workflow_revision_id,
      workflowName: batch.workflow_name,
      status: batch.status,
      views: (viewsByBatch.get(batch.id) ?? []).map((view) => ({
        id: view.id,
        label: view.label,
        description: view.description,
        horizontalAngle: view.horizontal_angle,
        verticalAngle: view.vertical_angle,
        zoom: view.zoom,
        bucket: view.bucket,
        status: view.status,
        message: view.message ?? undefined,
        candidateIds: candidateResult.results.filter((candidate) => candidate.view_id === view.id).map((candidate) => candidate.id),
      })),
      analysis: {
        status: batch.analysis_status,
        message: batch.analysis_message ?? undefined,
        progress: batch.analysis_progress ?? undefined,
        report: parseJson<Record<string, unknown> | undefined>(batch.report_json, undefined),
      },
      createdAt: batch.created_at,
      updatedAt: batch.updated_at,
    })),
    candidates: candidateResult.results.map((candidate) => ({
      id: candidate.id,
      batchId: candidate.batch_id,
      viewId: candidate.view_id,
      viewLabel: candidate.label,
      relativePath: candidate.object_key,
      filename: candidate.filename,
      mediaType: candidate.media_type,
      bytes: candidate.bytes,
      horizontalAngle: candidate.horizontal_angle,
      verticalAngle: candidate.vertical_angle,
      zoom: candidate.zoom,
      modalJobId: candidate.modal_job_id ?? "",
      workflowId: candidate.workflow_id,
      workflowRevisionId: candidate.workflow_revision_id,
      reviewStatus: candidate.review_status,
      quality: parseJson<Record<string, unknown> | undefined>(candidate.quality_json, undefined),
      createdAt: candidate.created_at,
    })),
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

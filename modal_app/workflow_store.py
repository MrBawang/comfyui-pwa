from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Mapping


WORKFLOW_ID = re.compile(r"^[a-f0-9]{32}$")
VARIANT_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
WORKFLOW_VALIDATION_VERSION = 4


def _valid_workflow_id(value: str) -> bool:
    return bool(WORKFLOW_ID.fullmatch(value))


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("工作流存储记录损坏") from error
    if not isinstance(value, dict):
        raise ValueError("工作流存储记录格式不正确")
    return value


def _analysis_manifest_fields(analysis: dict[str, Any]) -> dict[str, Any]:
    return {
        "nodeCount": int(analysis.get("nodeCount", 0)),
        "nodeTypes": list(analysis.get("nodeTypes", [])),
        "models": list(analysis.get("models", [])),
        "imageInputs": list(analysis.get("imageInputs", [])),
        "textInputs": list(analysis.get("textInputs", [])),
        "parameterInputs": list(analysis.get("parameterInputs", [])),
        "outputNodes": list(analysis.get("outputNodes", [])),
        "variants": list(analysis.get("variants", [])),
        "compatibilityAdjustments": list(
            analysis.get("compatibilityAdjustments", [])
        ),
    }


def _variant_ids(analysis: Mapping[str, Any]) -> set[str]:
    variants = analysis.get("variants")
    if not isinstance(variants, list):
        return set()
    result = set()
    for item in variants:
        variant_id = item.get("id") if isinstance(item, Mapping) else None
        if not isinstance(variant_id, str) or not VARIANT_ID.fullmatch(variant_id):
            raise ValueError("工作流变体 ID 格式不正确")
        if variant_id in result:
            raise ValueError("工作流变体 ID 重复")
        result.add(variant_id)
    return result


def _write_revision(
    revision_root: Path,
    raw_workflow: dict[str, Any],
    variant_workflows: Mapping[str, dict[str, Any]] | None,
    analysis: Mapping[str, Any],
    manifest: Mapping[str, Any] | None = None,
) -> None:
    variants = dict(variant_workflows or {})
    expected_ids = _variant_ids(analysis)
    if set(variants) != expected_ids:
        raise ValueError("工作流变体文件与检查结果不一致")
    revision_root.mkdir(parents=True)
    (revision_root / "workflow.json").write_text(
        json.dumps(raw_workflow, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    if manifest is not None:
        (revision_root / "manifest.json").write_text(
            json.dumps(dict(manifest), ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    if variants:
        variant_root = revision_root / "variants"
        variant_root.mkdir()
        for variant_id, workflow in variants.items():
            (variant_root / f"{variant_id}.json").write_text(
                json.dumps(workflow, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )


def create_stored_workflow(
    root: Path,
    raw_workflow: dict[str, Any],
    analysis: dict[str, Any],
    *,
    variant_workflows: Mapping[str, dict[str, Any]] | None = None,
    name: str,
    source_filename: str,
    runtime_revision: str,
    asset_version: str,
) -> dict[str, Any]:
    normalized_name = " ".join(name.split()).strip()
    if not normalized_name or len(normalized_name) > 100:
        raise ValueError("工作流名称应为 1 到 100 个字符")
    if not analysis.get("runnable"):
        raise ValueError("只有检查通过的工作流才能保存")

    workflow_id = uuid.uuid4().hex
    revision_id = uuid.uuid4().hex
    now = int(time.time())
    manifest = {
        "id": workflow_id,
        "revisionId": revision_id,
        "name": normalized_name,
        "status": "ready",
        "sourceFilename": Path(source_filename).name or "workflow.json",
        "sourceFormat": str(analysis.get("format", "comfyui-api")),
        **_analysis_manifest_fields(analysis),
        "runtimeRevision": runtime_revision,
        "assetVersion": asset_version,
        "validationVersion": WORKFLOW_VALIDATION_VERSION,
        "createdAt": now,
        "updatedAt": now,
    }

    root.mkdir(parents=True, exist_ok=True)
    destination = root / workflow_id
    temporary = root / f".{workflow_id}.{uuid.uuid4().hex}.tmp"
    try:
        _write_revision(
            temporary / "revisions" / revision_id,
            raw_workflow,
            variant_workflows,
            analysis,
            manifest,
        )
        (temporary / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return manifest


def refresh_stored_workflow(
    root: Path,
    workflow_id: str,
    raw_workflow: dict[str, Any],
    analysis: dict[str, Any],
    *,
    variant_workflows: Mapping[str, dict[str, Any]] | None = None,
    runtime_revision: str,
    asset_version: str,
    name: str | None = None,
    source_filename: str | None = None,
    source_format: str | None = None,
) -> dict[str, Any]:
    if not analysis.get("runnable"):
        raise ValueError("只有检查通过的工作流才能更新")
    manifest, _ = load_stored_workflow(root, workflow_id)
    if manifest.get("id") != workflow_id:
        raise ValueError("工作流存储记录 ID 不匹配")

    revision_id = uuid.uuid4().hex
    now = int(time.time())
    updated = {
        **manifest,
        "revisionId": revision_id,
        "status": "ready",
        **_analysis_manifest_fields(analysis),
        "runtimeRevision": runtime_revision,
        "assetVersion": asset_version,
        "validationVersion": WORKFLOW_VALIDATION_VERSION,
        "updatedAt": now,
    }
    if name is not None:
        normalized_name = " ".join(name.split()).strip()
        if not normalized_name or len(normalized_name) > 100:
            raise ValueError("工作流名称应为 1 到 100 个字符")
        updated["name"] = normalized_name
    if source_filename is not None:
        updated["sourceFilename"] = Path(source_filename).name or "workflow.json"
    if source_format is not None:
        updated["sourceFormat"] = source_format
    updated.pop("statusMessage", None)

    workflow_root = root / workflow_id
    revisions_root = workflow_root / "revisions"
    temporary_revision = revisions_root / f".{revision_id}.{uuid.uuid4().hex}.tmp"
    destination_revision = revisions_root / revision_id
    temporary_manifest = workflow_root / f".manifest.{uuid.uuid4().hex}.tmp"
    temporary_snapshot: Path | None = None
    try:
        current_revision = revisions_root / str(manifest["revisionId"])
        current_snapshot = current_revision / "manifest.json"
        if not current_snapshot.is_file():
            temporary_snapshot = current_revision / f".manifest.{uuid.uuid4().hex}.tmp"
            temporary_snapshot.write_text(
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary_snapshot, current_snapshot)
        _write_revision(
            temporary_revision,
            raw_workflow,
            variant_workflows,
            analysis,
            updated,
        )
        os.replace(temporary_revision, destination_revision)
        temporary_manifest.write_text(
            json.dumps(updated, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary_manifest, workflow_root / "manifest.json")
    except Exception:
        shutil.rmtree(temporary_revision, ignore_errors=True)
        temporary_manifest.unlink(missing_ok=True)
        if temporary_snapshot is not None:
            temporary_snapshot.unlink(missing_ok=True)
        raise
    return updated


def load_stored_workflow(root: Path, workflow_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if not _valid_workflow_id(workflow_id):
        raise ValueError("工作流 ID 格式不正确")
    manifest = _read_json_object(root / workflow_id / "manifest.json")
    revision_id = manifest.get("revisionId")
    if not isinstance(revision_id, str) or not _valid_workflow_id(revision_id):
        raise ValueError("工作流版本 ID 格式不正确")
    return load_stored_workflow_revision(root, workflow_id, revision_id)


def load_stored_workflow_revision(
    root: Path, workflow_id: str, revision_id: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not _valid_workflow_id(workflow_id):
        raise ValueError("工作流 ID 格式不正确")
    if not _valid_workflow_id(revision_id):
        raise ValueError("工作流版本 ID 格式不正确")
    workflow_root = root / workflow_id
    current_manifest = _read_json_object(workflow_root / "manifest.json")
    if current_manifest.get("revisionId") == revision_id:
        manifest = current_manifest
    else:
        manifest = _read_json_object(
            workflow_root / "revisions" / revision_id / "manifest.json"
        )
    if manifest.get("id") != workflow_id or manifest.get("revisionId") != revision_id:
        raise ValueError("工作流版本清单不匹配")
    workflow = _read_json_object(
        workflow_root / "revisions" / revision_id / "workflow.json"
    )
    return manifest, workflow


def load_stored_workflow_variant(
    root: Path, workflow_id: str, variant_id: str, revision_id: str | None = None
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not VARIANT_ID.fullmatch(variant_id):
        raise ValueError("工作流变体 ID 格式不正确")
    manifest, _ = (
        load_stored_workflow_revision(root, workflow_id, revision_id)
        if revision_id
        else load_stored_workflow(root, workflow_id)
    )
    variants = manifest.get("variants")
    known_ids = {
        item.get("id")
        for item in variants
        if isinstance(variants, list) and isinstance(item, Mapping)
    } if isinstance(variants, list) else set()
    if variant_id not in known_ids:
        raise ValueError("工作流变体不存在")
    revision_id = str(manifest["revisionId"])
    workflow = _read_json_object(
        root
        / workflow_id
        / "revisions"
        / revision_id
        / "variants"
        / f"{variant_id}.json"
    )
    return manifest, workflow


def workflow_record_for_runtime(
    manifest: dict[str, Any], current_runtime_revision: str
) -> dict[str, Any]:
    record = dict(manifest)
    for field in (
        "nodeTypes",
        "models",
        "imageInputs",
        "textInputs",
        "parameterInputs",
        "outputNodes",
        "variants",
        "compatibilityAdjustments",
    ):
        if not isinstance(record.get(field), list):
            record[field] = []
    if (
        record.get("status") == "ready"
        and record.get("runtimeRevision") != current_runtime_revision
    ):
        record["status"] = "stale"
        record["statusMessage"] = "云端节点环境已变化，请重新上传或复查此工作流"
    elif (
        record.get("status") == "ready"
        and record.get("validationVersion") != WORKFLOW_VALIDATION_VERSION
    ):
        record["status"] = "stale"
        record["statusMessage"] = "工作流检查规则已更新，请复查此工作流"
    return record


def list_stored_workflows(
    root: Path, current_runtime_revision: str
) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []
    records = []
    for directory in root.iterdir():
        if not directory.is_dir() or not _valid_workflow_id(directory.name):
            continue
        try:
            manifest = _read_json_object(directory / "manifest.json")
        except ValueError:
            continue
        records.append(workflow_record_for_runtime(manifest, current_runtime_revision))
    return sorted(
        records,
        key=lambda item: (int(item.get("updatedAt", 0)), str(item.get("name", ""))),
        reverse=True,
    )

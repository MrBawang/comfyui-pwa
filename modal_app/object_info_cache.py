import json
import os
import re
import time
import uuid
from collections.abc import Callable, Collection
from pathlib import Path
from typing import Any


LEGACY_RUNTIME_REVISION = "legacy"
OBJECT_INFO_CACHE_SCHEMA_VERSION = 3


def _validate_cache_identity(
    runtime_revision: str,
    comfyui_version: str,
    asset_version: str | None = None,
) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", comfyui_version):
        raise ValueError("ComfyUI 版本格式不正确")
    if runtime_revision != LEGACY_RUNTIME_REVISION and not re.fullmatch(
        r"[a-f0-9]{32}", runtime_revision
    ):
        raise ValueError("资源版本格式不正确")
    if asset_version is not None and not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", asset_version
    ):
        raise ValueError("资源状态版本格式不正确")


def _runtime_cache_root(runtime_root: Path, runtime_revision: str) -> Path:
    if runtime_revision == LEGACY_RUNTIME_REVISION:
        return runtime_root / "schema-cache" / LEGACY_RUNTIME_REVISION
    return runtime_root / "revisions" / runtime_revision / "schema-cache"


def object_info_cache_path(
    runtime_root: Path,
    runtime_revision: str,
    comfyui_version: str,
    asset_version: str,
) -> Path:
    _validate_cache_identity(runtime_revision, comfyui_version, asset_version)
    return _runtime_cache_root(runtime_root, runtime_revision) / (
        f"object-info-v{OBJECT_INFO_CACHE_SCHEMA_VERSION}-"
        f"{comfyui_version}.json"
    )


def previous_object_info_cache_path(
    runtime_root: Path,
    runtime_revision: str,
    comfyui_version: str,
) -> Path:
    _validate_cache_identity(runtime_revision, comfyui_version)
    if runtime_revision == LEGACY_RUNTIME_REVISION:
        return (
            runtime_root
            / "schema-cache"
            / f"object-info-{comfyui_version}-{LEGACY_RUNTIME_REVISION}.json"
        )
    return (
        runtime_root
        / "revisions"
        / runtime_revision
        / f"object-info-{comfyui_version}.json"
    )


def _valid_object_info_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    object_info = payload.get("objectInfo")
    node_count = payload.get("nodeCount")
    return (
        type(node_count) is int
        and isinstance(object_info, dict)
        and bool(object_info)
        and node_count == len(object_info)
        and all(
            isinstance(node_type, str)
            and bool(node_type)
            and isinstance(definition, dict)
            for node_type, definition in object_info.items()
        )
    )


def valid_object_info_cache(
    payload: Any,
    runtime_revision: str,
    comfyui_version: str,
    asset_version: str,
) -> bool:
    return (
        _valid_object_info_payload(payload)
        and payload.get("cacheSchemaVersion") == OBJECT_INFO_CACHE_SCHEMA_VERSION
        and payload.get("comfyuiVersion") == comfyui_version
        and payload.get("runtimeRevision") == runtime_revision
    )


def load_object_info_cache(
    path: Path,
    runtime_revision: str,
    comfyui_version: str,
    asset_version: str,
) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not valid_object_info_cache(
        payload, runtime_revision, comfyui_version, asset_version
    ):
        return None
    return payload["objectInfo"]


def load_previous_object_info_cache(
    path: Path,
    runtime_revision: str,
    comfyui_version: str,
) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not (
        _valid_object_info_payload(payload)
        and payload.get("comfyuiVersion") == comfyui_version
        and payload.get("runtimeRevision") == runtime_revision
    ):
        return None
    return payload["objectInfo"]


def write_object_info_cache(
    path: Path,
    object_info: dict[str, Any],
    runtime_revision: str,
    comfyui_version: str,
    asset_version: str,
) -> None:
    payload = {
        "cacheSchemaVersion": OBJECT_INFO_CACHE_SCHEMA_VERSION,
        "comfyuiVersion": comfyui_version,
        "runtimeRevision": runtime_revision,
        "nodeCount": len(object_info),
        "cachedAt": int(time.time()),
        "objectInfo": object_info,
    }
    if not valid_object_info_cache(
        payload, runtime_revision, comfyui_version, asset_version
    ):
        raise ValueError("ComfyUI 返回了不正确的 object_info")

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def migrate_asset_scoped_object_info_cache(
    path: Path,
    runtime_revision: str,
    comfyui_version: str,
    asset_version: str,
    expected_node_types: Collection[str] = (),
) -> bool:
    if path.is_file():
        return False
    expected = set(expected_node_types)
    previous_schema = OBJECT_INFO_CACHE_SCHEMA_VERSION - 1
    candidates = sorted(
        path.parent.glob(
            f"object-info-v{previous_schema}-{comfyui_version}-*.json"
        ),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        cached = load_previous_object_info_cache(
            candidate,
            runtime_revision,
            comfyui_version,
        )
        if cached is None or not expected.issubset(cached):
            continue
        write_object_info_cache(
            path,
            cached,
            runtime_revision,
            comfyui_version,
            asset_version,
        )
        return True
    return False


def load_or_refresh_object_info(
    path: Path,
    runtime_revision: str,
    comfyui_version: str,
    asset_version: str,
    fetch_object_info: Callable[[], dict[str, Any]],
    expected_node_types: Collection[str] = (),
) -> tuple[dict[str, Any], str]:
    expected = set(expected_node_types)
    cached = load_object_info_cache(
        path,
        runtime_revision,
        comfyui_version,
        asset_version,
    )
    if cached is not None and expected.issubset(cached):
        return cached, "cache"

    object_info = fetch_object_info()
    missing_nodes = sorted(expected - set(object_info))
    if missing_nodes:
        preview = "、".join(missing_nodes[:8])
        raise ValueError(
            f"CPU Inspector 未加载 {len(missing_nodes)} 个已验证节点类型（{preview}）"
        )
    write_object_info_cache(
        path,
        object_info,
        runtime_revision,
        comfyui_version,
        asset_version,
    )
    return object_info, "comfyui-cpu"

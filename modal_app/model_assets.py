from __future__ import annotations

import copy
import json
import re
import urllib.parse
from pathlib import Path
from typing import Any, Mapping, Sequence

from modal_app.workflow_analysis import (
    MODEL_INPUTS,
    MODEL_INPUT_OVERRIDES,
    model_input_category,
    safe_model_reference,
)


MODEL_CATEGORIES = frozenset(
    set(MODEL_INPUTS.values())
    | {category for category in MODEL_INPUT_OVERRIDES.values() if category is not None}
)
MODEL_DOWNLOAD_HOSTS = (
    "civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com",
    "civitai.com",
    "github.com",
    "githubusercontent.com",
    "huggingface.co",
    "hf.co",
    "modelscope.cn",
)
SENSITIVE_QUERY_KEYS = frozenset(
    {"access_token", "api_key", "apikey", "auth", "authorization", "key", "token"}
)


def _model_reference(value: Any, label: str) -> str:
    if not isinstance(value, str) or not safe_model_reference(value):
        raise ValueError(f"{label}不安全")
    return value


def validate_model_bindings(raw: Any) -> list[dict[str, str]]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list) or len(raw) > 100:
        raise ValueError("模型绑定必须是最多 100 项的数组")

    bindings: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in raw:
        if not isinstance(item, Mapping):
            raise ValueError("模型绑定格式不正确")
        category = item.get("category")
        if not isinstance(category, str) or category not in MODEL_CATEGORIES:
            raise ValueError("模型绑定目录不受支持")
        expected = _model_reference(item.get("expectedFilename"), "工作流模型路径")
        actual = _model_reference(item.get("actualFilename"), "云端模型路径")
        key = (category, expected)
        if key in seen:
            raise ValueError(f"模型绑定重复：{category}/{expected}")
        seen.add(key)
        bindings.append(
            {
                "category": category,
                "expectedFilename": expected,
                "actualFilename": actual,
            }
        )
    return bindings


def apply_model_bindings(
    workflow: dict[str, Any], raw_bindings: Any
) -> dict[str, Any]:
    bindings = validate_model_bindings(raw_bindings)
    if not bindings:
        return workflow

    replacements = {
        (item["category"], item["expectedFilename"]): item["actualFilename"]
        for item in bindings
    }
    prepared = copy.deepcopy(workflow)
    for node in prepared.values():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        inputs = node["inputs"]
        class_type = node.get("class_type")
        if not isinstance(class_type, str):
            continue
        for input_name, current in inputs.items():
            category = model_input_category(class_type, input_name)
            if category is None:
                continue
            if isinstance(current, str) and (category, current) in replacements:
                inputs[input_name] = replacements[(category, current)]
    return prepared


def parse_model_bindings(value: Any) -> list[dict[str, str]]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise ValueError("模型绑定不是有效 JSON") from error
    return validate_model_bindings(value)


def _metadata_for(path: Path) -> dict[str, Any]:
    sidecar = path.with_name(f".{path.name}.comfy-desk.json")
    if not sidecar.is_file():
        return {}
    try:
        value = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(value, dict):
        return {}
    allowed = {
        key: value[key]
        for key in (
            "sourceKind",
            "repoId",
            "repoFile",
            "requestedRepoFile",
            "requestedRevision",
            "resolvedRevision",
            "sourceUrl",
            "sha256",
            "bytes",
        )
        if key in value and isinstance(value[key], (str, int))
    }
    if "sourceKind" not in allowed:
        allowed["sourceKind"] = "huggingface" if "repoId" in allowed else "unknown"
    return allowed


def list_model_assets(
    root: Path, categories: Sequence[str] = tuple(sorted(MODEL_CATEGORIES)), limit: int = 2000
) -> list[dict[str, Any]]:
    if limit < 1 or limit > 2000:
        raise ValueError("模型目录条数限制不正确")
    assets: list[dict[str, Any]] = []
    for category in sorted(set(categories)):
        if category not in MODEL_CATEGORIES:
            continue
        category_root = root / category
        if not category_root.is_dir():
            continue
        for path in sorted(category_root.rglob("*")):
            relative = path.relative_to(category_root)
            if (
                len(assets) >= limit
                or not path.is_file()
                or any(part.startswith(".") for part in relative.parts)
                or path.name.endswith(".partial")
                or not safe_model_reference(relative.as_posix())
            ):
                continue
            stat = path.stat()
            assets.append(
                {
                    "category": category,
                    "filename": relative.as_posix(),
                    "bytes": stat.st_size,
                    "modifiedAt": int(stat.st_mtime * 1000),
                    "source": _metadata_for(path),
                }
            )
            if len(assets) >= limit:
                return assets
    return assets


def validate_model_download_url(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("模型下载地址不正确")
    parsed = urllib.parse.urlsplit(value)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or not any(hostname == host or hostname.endswith(f".{host}") for host in MODEL_DOWNLOAD_HOSTS)
    ):
        raise ValueError("仅支持 Hugging Face、Civitai、ModelScope 或 GitHub 的 HTTPS 下载地址")
    query_keys = {key.lower() for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}
    if query_keys & SENSITIVE_QUERY_KEYS:
        raise ValueError("下载地址不能包含 Token、API Key 或其他凭据")
    return value


def public_model_download_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(validate_model_download_url(value))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def validate_expected_sha256(value: Any) -> str:
    if value in (None, ""):
        return ""
    digest = str(value).strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("SHA-256 必须是 64 位十六进制字符串")
    return digest


def require_matching_sha256(actual: str, expected: str) -> None:
    if expected and actual.lower() != validate_expected_sha256(expected):
        raise ValueError(f"模型 SHA-256 校验失败：期望 {expected}，实际 {actual}")

import asyncio
import copy
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any

import modal

from modal_app.comfy_runtime import (
    comfy_execution_error_message,
    comfy_prompt_error_message,
    discover_repository_file,
    huggingface_download_error_message,
    python_runtime_package_available,
    standard_prompt_id,
    validate_uploaded_image,
    validate_python_runtime_package,
)
from modal_app.object_info_cache import (
    load_or_refresh_object_info,
    load_previous_object_info_cache,
    migrate_asset_scoped_object_info_cache,
    object_info_cache_path,
    previous_object_info_cache_path,
)
from modal_app.model_assets import (
    MODEL_CATEGORIES,
    apply_model_bindings,
    list_model_assets,
    parse_model_bindings,
    public_model_download_url,
    require_matching_sha256,
    validate_expected_sha256,
    validate_model_download_url,
)
from modal_app.registry_install import (
    _install_python_dependencies,
    install_github_node,
    install_registry_node,
)
from modal_app.registry_lookup import (
    resolve_missing_node_packages,
    with_node_package_lookup_failure,
)
from modal_app.workflow_analysis import (
    MODEL_INPUTS,
    RUNTIME_PYTHON_PACKAGES,
    WorkflowFormatError,
    analyze_workflow,
    coerce_runtime_parameter_value,
    merge_workflow_resource_findings,
    safe_model_reference,
    validate_runtime_parameter_value,
)
from modal_app.workflow_import import IMAGE_SUFFIXES, load_workflow_document
from modal_app.workflow_conversion import (
    apply_canvas_model_sources,
    canvas_node_package_hints,
    canvas_node_count,
    canvas_optional_image_variants,
    canvas_node_types,
    convert_workflow_document,
    is_canvas_workflow,
    missing_canvas_nodes,
)
from modal_app.workflow_outputs import (
    final_history_file_entries,
    history_file_entries,
    preferred_upscale_output_nodes,
)
from modal_app.workflow_store import (
    create_stored_workflow,
    list_stored_workflows,
    load_stored_workflow,
    load_stored_workflow_revision,
    load_stored_workflow_variant,
    refresh_stored_workflow,
    workflow_record_for_runtime,
)


APP_NAME = "comfy-desk"
COMFYUI_VERSION = "0.27.0"
COMFY_ROOT = Path("/root/comfy/ComfyUI")
COMFY_INPUT = COMFY_ROOT / "input"
COMFY_OUTPUT = COMFY_ROOT / "output"
COMFY_TEMP = COMFY_ROOT / "temp"
MODEL_ROOT = Path("/vol/models")
CUSTOM_NODE_ROOT = Path("/vol/custom_nodes")
PYTHON_PACKAGES = Path("/vol/pip-packages")
RUNTIME_ROOT = Path("/vol/runtime")
RUNTIME_REVISIONS = RUNTIME_ROOT / "revisions"
ARTIFACT_ROOT = Path("/vol/artifacts")
WORKFLOW_ROOT = Path("/vol/workflows")
LEGACY_RUNTIME_REVISION = "legacy"
RUNTIME_CURRENT_KEY = "runtime-current"
RUNTIME_PREVIOUS_KEY = "runtime-previous"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_WORKFLOW_BYTES = 5 * 1024 * 1024
MAX_WORKFLOW_IMAGE_BYTES = 25 * 1024 * 1024
MAX_RUN_REQUEST_BYTES = 130 * 1024 * 1024
MAX_ANALYZE_REQUEST_BYTES = 30 * 1024 * 1024
MAX_JSON_REQUEST_BYTES = 64 * 1024
MAX_MODEL_DOWNLOAD_BYTES = 100 * 1024 * 1024 * 1024
MAX_ARTIFACT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
ARTIFACT_RETENTION_SECONDS = 7 * 24 * 60 * 60
COMFY_CPU_STARTUP_TIMEOUT_SECONDS = 540
COMFY_GPU_STARTUP_TIMEOUT_SECONDS = 1_200

models = modal.Volume.from_name("comfy-desk-models", create_if_missing=True)
custom_nodes = modal.Volume.from_name("comfy-desk-custom-nodes", create_if_missing=True)
python_packages = modal.Volume.from_name("comfy-desk-python-packages", create_if_missing=True)
runtime_assets = modal.Volume.from_name("comfy-desk-runtime-assets", create_if_missing=True)
artifacts = modal.Volume.from_name("comfy-desk-artifacts", create_if_missing=True)
workflow_catalog = modal.Volume.from_name("comfy-desk-workflows", create_if_missing=True)
asset_state = modal.Dict.from_name("comfy-desk-asset-state", create_if_missing=True)
job_state = modal.Dict.from_name("comfy-desk-job-state", create_if_missing=True)
config = modal.Secret.from_name("comfy-desk-config")
huggingface = modal.Secret.from_name("huggingface-secret")

web_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install(
        "fastapi[standard]==0.115.4",
        "python-multipart==0.0.20",
        "pillow==11.1.0",
    )
    .add_local_python_source("modal_app")
)

comfy_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .uv_pip_install(
        "comfy-cli==1.12.0",
        "huggingface-hub[hf_xet]==0.36.0",
        "pillow==11.1.0",
    )
    .run_commands(
        f"comfy --skip-prompt install --fast-deps --nvidia --version {COMFYUI_VERSION}"
    )
    .run_commands(
        f"mkdir -p {MODEL_ROOT} {CUSTOM_NODE_ROOT} {PYTHON_PACKAGES} {RUNTIME_ROOT}",
        f"rm -rf {COMFY_ROOT / 'models'} {COMFY_ROOT / 'custom_nodes'}",
        f"ln -s {MODEL_ROOT} {COMFY_ROOT / 'models'}",
        f"ln -s {CUSTOM_NODE_ROOT} {COMFY_ROOT / 'custom_nodes'}",
    )
    .env(
        {
            "HF_XET_HIGH_PERFORMANCE": "1",
            "PYTHONPATH": str(PYTHON_PACKAGES),
            "PIP_TARGET": str(PYTHON_PACKAGES),
        }
    )
    .add_local_python_source("modal_app")
)

app = modal.App(APP_NAME)


def _save_uploaded_image(data: bytes, destination: Path) -> None:
    from PIL import Image, ImageOps

    with Image.open(BytesIO(data)) as image:
        ImageOps.exif_transpose(image).save(destination, format="PNG")


def _authorized(request: Any) -> bool:
    expected = os.environ.get("COMFY_API_TOKEN")
    if not expected:
        return False
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
    return hmac.compare_digest(supplied, expected)


def _asset_version() -> str:
    return uuid.uuid4().hex


def _publish_asset_version(version: str | None = None) -> str:
    version = version or _asset_version()
    asset_state.put("current", version)
    return version


def _runtime_paths(revision: str) -> tuple[Path, Path]:
    if revision == LEGACY_RUNTIME_REVISION:
        return CUSTOM_NODE_ROOT, PYTHON_PACKAGES
    if not re.fullmatch(r"[a-f0-9]{32}", revision):
        raise ValueError("资源版本格式不正确")
    root = RUNTIME_REVISIONS / revision
    return root / "custom_nodes", root / "python_packages"


def _runtime_manifest_node_types(runtime_revision: str) -> set[str]:
    if runtime_revision == LEGACY_RUNTIME_REVISION:
        return set()
    manifest_file = RUNTIME_REVISIONS / runtime_revision / "runtime.json"
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    if not isinstance(manifest, dict):
        return set()
    node_types = manifest.get("validatedNodeTypes")
    if (
        manifest.get("revision") != runtime_revision
        or manifest.get("validatedComfyuiVersion") != COMFYUI_VERSION
        or not isinstance(node_types, list)
        or any(not isinstance(node_type, str) or not node_type for node_type in node_types)
    ):
        return set()
    return set(node_types)


def _expected_object_info_node_types(runtime_revision: str) -> set[str]:
    expected = _runtime_manifest_node_types(runtime_revision)
    if expected:
        return expected
    previous_cache = load_previous_object_info_cache(
        previous_object_info_cache_path(
            RUNTIME_ROOT,
            runtime_revision,
            COMFYUI_VERSION,
        ),
        runtime_revision,
        COMFYUI_VERSION,
    )
    return set(previous_cache or {})


def _write_runtime_validation_manifest(
    runtime_revision: str, node_types: list[str]
) -> None:
    if not re.fullmatch(r"[a-f0-9]{32}", runtime_revision):
        raise ValueError("资源版本格式不正确")
    if not node_types or any(
        not isinstance(node_type, str) or not node_type for node_type in node_types
    ):
        raise ValueError("节点验证结果格式不正确")

    manifest_file = RUNTIME_REVISIONS / runtime_revision / "runtime.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("revision") != runtime_revision:
        raise ValueError("节点运行版本清单不正确")
    manifest["validatedComfyuiVersion"] = COMFYUI_VERSION
    manifest["validatedNodeTypes"] = sorted(set(node_types))
    manifest["validatedAt"] = int(time.time())
    temporary = manifest_file.with_name(
        f".{manifest_file.name}.{uuid.uuid4().hex}.tmp"
    )
    try:
        temporary.write_text(json.dumps(manifest), encoding="utf-8")
        os.replace(temporary, manifest_file)
    finally:
        temporary.unlink(missing_ok=True)


def _record_runtime_validation(runtime_revision: str, node_types: list[str]) -> None:
    runtime_assets.reload()
    _write_runtime_validation_manifest(runtime_revision, node_types)
    runtime_assets.commit()


def _start_comfyui(runtime_revision: str, port: int, *, cpu: bool) -> None:
    runtime_nodes, runtime_python = _runtime_paths(runtime_revision)
    if not runtime_nodes.is_dir() or not runtime_python.is_dir():
        raise RuntimeError("ComfyUI 资源版本不存在")
    comfy_nodes = COMFY_ROOT / "custom_nodes"
    if comfy_nodes.is_symlink() or comfy_nodes.is_file():
        comfy_nodes.unlink()
    elif comfy_nodes.exists():
        shutil.rmtree(comfy_nodes)
    comfy_nodes.symlink_to(runtime_nodes, target_is_directory=True)

    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(runtime_python)
    environment["PIP_TARGET"] = str(runtime_python)
    launch_arguments = ["--listen", "127.0.0.1", "--port", str(port)]
    if cpu:
        launch_arguments.insert(0, "--cpu")
    process = subprocess.Popen(
        [sys.executable, str(COMFY_ROOT / "main.py"), *launch_arguments],
        cwd=COMFY_ROOT,
        env=environment,
    )
    startup_timeout = (
        COMFY_CPU_STARTUP_TIMEOUT_SECONDS
        if cpu
        else COMFY_GPU_STARTUP_TIMEOUT_SECONDS
    )
    deadline = time.monotonic() + startup_timeout
    while time.monotonic() < deadline:
        try:
            _check_comfy_health(port)
            return
        except RuntimeError:
            if process.poll() is not None:
                raise RuntimeError(
                    f"ComfyUI 启动失败，退出码 {process.returncode}"
                )
            time.sleep(1)
    process.terminate()
    raise RuntimeError("ComfyUI 启动超时")


def _check_comfy_health(port: int) -> None:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/system_stats", timeout=10
        ) as response:
            if response.status != 200:
                raise RuntimeError("ComfyUI 健康检查失败")
    except (socket.timeout, urllib.error.URLError) as error:
        raise RuntimeError("ComfyUI 服务不可用，请等待新容器启动后重试") from error


def _read_object_info(port: int) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/object_info", timeout=30
        ) as response:
            result = json.loads(response.read())
    except (socket.timeout, urllib.error.URLError, json.JSONDecodeError) as error:
        raise RuntimeError("无法读取 ComfyUI object_info") from error
    if not isinstance(result, dict) or not result:
        raise RuntimeError("ComfyUI 返回了不正确的 object_info")
    return result


def _copy_runtime(source: Path, destination: Path) -> None:
    if source.exists():
        shutil.copytree(source, destination)
    else:
        destination.mkdir(parents=True, exist_ok=False)


def _prune_runtime_revisions(keep: set[str]) -> None:
    if not RUNTIME_REVISIONS.is_dir():
        return
    for candidate in RUNTIME_REVISIONS.iterdir():
        if (
            candidate.name not in keep
            and re.fullmatch(r"[a-f0-9]{32}", candidate.name)
            and candidate.is_dir()
        ):
            shutil.rmtree(candidate)


def _runtime_python_package_for_module(module: str) -> dict[str, Any] | None:
    return next(
        (
            package
            for package in RUNTIME_PYTHON_PACKAGES.values()
            if package.get("module") == module
        ),
        None,
    )


def _runtime_python_module_available(runtime_revision: str, module: str) -> bool:
    package = _runtime_python_package_for_module(module)
    if package is None:
        return False
    _, runtime_python = _runtime_paths(runtime_revision)
    return python_runtime_package_available(
        runtime_python,
        module=module,
        distribution=str(package["packageId"]),
        version=str(package["version"]),
    )


def _validate_runtime_python_package(
    python_root: Path, package: dict[str, Any]
) -> None:
    validate_python_runtime_package(
        python_root,
        module=str(package["module"]),
        distribution=str(package["packageId"]),
        version=str(package["version"]),
    )


def _discard_runtime_revision(revision_root: Path) -> None:
    try:
        runtime_assets.reload()
        shutil.rmtree(revision_root, ignore_errors=True)
        runtime_assets.commit()
    except Exception:
        pass


def _history_file_path(entry: dict[str, str]) -> Path:
    roots = {"input": COMFY_INPUT, "output": COMFY_OUTPUT, "temp": COMFY_TEMP}
    root = roots.get(entry["type"])
    if root is None:
        raise RuntimeError(f"ComfyUI 返回了不支持的文件类型：{entry['type']}")
    filename = entry["filename"]
    if not filename or Path(filename).name != filename:
        raise RuntimeError("ComfyUI 返回了不安全的输出文件名")
    subfolder = Path(*Path(entry["subfolder"].replace("\\", "/")).parts)
    if subfolder.is_absolute() or ".." in subfolder.parts:
        raise RuntimeError("ComfyUI 返回了不安全的输出目录")
    path = (root / subfolder / filename).resolve()
    resolved_root = root.resolve()
    if resolved_root not in path.parents:
        raise RuntimeError("ComfyUI 返回了越界的输出路径")
    return path


def _cleanup_expired_artifacts(now: int) -> None:
    if not ARTIFACT_ROOT.is_dir():
        return
    cutoff = now - ARTIFACT_RETENTION_SECONDS
    for directory in ARTIFACT_ROOT.iterdir():
        if not directory.is_dir() or not re.fullmatch(r"[a-f0-9]{32}", directory.name):
            continue
        created_at = int(directory.stat().st_mtime)
        manifest_file = directory / "manifest.json"
        if manifest_file.is_file():
            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
                created_at = int(manifest.get("createdAt", created_at))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                pass
        if created_at < cutoff:
            shutil.rmtree(directory, ignore_errors=True)


def _workflow_model_manifest(models_found: list[dict[str, Any]]) -> list[dict[str, Any]]:
    manifest = []
    for model in models_found:
        category = str(model.get("category", ""))
        filename = str(model.get("filename", ""))
        item: dict[str, Any] = {"category": category, "filename": filename}
        metadata_file = (MODEL_ROOT / category / filename).with_name(
            f".{Path(filename).name}.comfy-desk.json"
        )
        if metadata_file.is_file():
            try:
                metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
                if isinstance(metadata, dict):
                    item["source"] = metadata
            except (OSError, json.JSONDecodeError):
                pass
        manifest.append(item)
    return manifest


@app.cls(
    image=comfy_image,
    cpu=2.0,
    memory=4096,
    volumes={
        str(MODEL_ROOT): models,
        str(CUSTOM_NODE_ROOT): custom_nodes,
        str(PYTHON_PACKAGES): python_packages,
        str(RUNTIME_ROOT): runtime_assets,
    },
    scaledown_window=120,
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    retries=0,
    startup_timeout=600,
    timeout=600,
)
@modal.concurrent(max_inputs=10)
class ComfyInspector:
    asset_version: str = modal.parameter(default="base")
    runtime_revision: str = modal.parameter(default=LEGACY_RUNTIME_REVISION)
    port: int = 8188

    @modal.enter()
    def load_object_info(self) -> None:
        runtime_assets.reload()
        self._runtime_dependency_status: dict[str, bool] = {}
        runtime_nodes, runtime_python = _runtime_paths(self.runtime_revision)
        if not runtime_nodes.is_dir() or not runtime_python.is_dir():
            raise RuntimeError("ComfyUI 资源版本不存在")
        cache_path = object_info_cache_path(
            RUNTIME_ROOT,
            self.runtime_revision,
            COMFYUI_VERSION,
            self.asset_version,
        )
        expected_node_types = _expected_object_info_node_types(
            self.runtime_revision
        )
        migrated_cache = migrate_asset_scoped_object_info_cache(
            cache_path,
            self.runtime_revision,
            COMFYUI_VERSION,
            self.asset_version,
            expected_node_types,
        )
        migrate_runtime_manifest = (
            self.runtime_revision != LEGACY_RUNTIME_REVISION
            and not _runtime_manifest_node_types(self.runtime_revision)
            and bool(expected_node_types)
        )

        def fetch_object_info() -> dict[str, Any]:
            _start_comfyui(self.runtime_revision, self.port, cpu=True)
            return _read_object_info(self.port)

        self._object_info_data, self._schema_source = load_or_refresh_object_info(
            cache_path,
            self.runtime_revision,
            COMFYUI_VERSION,
            self.asset_version,
            fetch_object_info,
            expected_node_types,
        )
        if migrate_runtime_manifest:
            _write_runtime_validation_manifest(
                self.runtime_revision,
                sorted(self._object_info_data),
            )
        if (
            self._schema_source == "comfyui-cpu"
            or migrate_runtime_manifest
            or migrated_cache
        ):
            runtime_assets.commit()

    def _runtime_dependency_exists(self, module: str) -> bool:
        if module not in self._runtime_dependency_status:
            self._runtime_dependency_status[module] = (
                _runtime_python_module_available(self.runtime_revision, module)
            )
        return self._runtime_dependency_status[module]

    @modal.method()
    def inspect(
        self,
        raw_workflow: dict[str, Any],
        include_workflow: bool = False,
        model_bindings: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        model_bindings = parse_model_bindings(model_bindings)
        object_info = self._object_info_data
        installed_nodes = set(object_info)
        variant_candidates: list[dict[str, Any]] = []

        if is_canvas_workflow(raw_workflow):
            variant_candidates = canvas_optional_image_variants(raw_workflow)
            missing_nodes = set(missing_canvas_nodes(raw_workflow, installed_nodes))
            package_hints = canvas_node_package_hints(raw_workflow, list(missing_nodes))
            for candidate in variant_candidates:
                candidate_missing = missing_canvas_nodes(
                    candidate["canvas"], installed_nodes
                )
                missing_nodes.update(candidate_missing)
                for node_type, hints in canvas_node_package_hints(
                    candidate["canvas"], candidate_missing
                ).items():
                    package_hints.setdefault(node_type, [])
                    package_hints[node_type] = sorted(
                        set(package_hints[node_type]) | set(hints)
                    )
            if missing_nodes:
                return {
                    "format": "comfyui-canvas",
                    "conversionStatus": "blocked",
                    "convertedFromCanvas": False,
                    "nodeCount": canvas_node_count(raw_workflow),
                    "nodeTypes": canvas_node_types(raw_workflow),
                    "missingNodes": sorted(missing_nodes),
                    "nodePackageHints": package_hints,
                    "models": [],
                    "imageInputs": [],
                    "textInputs": [],
                    "parameterInputs": [],
                    "outputNodes": [],
                    "variants": [],
                    "compatibilityAdjustments": [],
                    "unsupportedInputs": [],
                    "missingRuntimePackages": [],
                    "issues": [
                        f"缺少 {len(missing_nodes)} 个节点类型；安装后将自动重新转换"
                    ],
                    "runnable": False,
                    "assetVersion": self.asset_version,
                    "runtimeRevision": self.runtime_revision,
                    "schemaSource": self._schema_source,
                }

        compatibility_adjustments: list[dict[str, str]] = []
        workflow, converted_from_canvas = convert_workflow_document(
            raw_workflow,
            object_info,
            compatibility_adjustments,
        )
        workflow = apply_model_bindings(workflow, model_bindings)
        result = analyze_workflow(
            workflow,
            installed_nodes=installed_nodes,
            model_exists=lambda category, filename: (
                MODEL_ROOT / category / filename
            ).is_file(),
            node_info=object_info,
            runtime_dependency_exists=self._runtime_dependency_exists,
        )
        if is_canvas_workflow(raw_workflow):
            apply_canvas_model_sources(result["models"], raw_workflow)
            variants = []
            variant_workflows = {}
            default_image_input_count = len(result["imageInputs"])
            for candidate in variant_candidates:
                try:
                    variant_workflow, _ = convert_workflow_document(
                        candidate["canvas"],
                        object_info,
                        compatibility_adjustments,
                    )
                    variant_workflow = apply_model_bindings(
                        variant_workflow, model_bindings
                    )
                    variant_analysis = analyze_workflow(
                        variant_workflow,
                        installed_nodes=installed_nodes,
                        model_exists=lambda category, filename: (
                            MODEL_ROOT / category / filename
                        ).is_file(),
                        node_info=object_info,
                        runtime_dependency_exists=self._runtime_dependency_exists,
                    )
                except WorkflowFormatError as error:
                    result["issues"].append(
                        f"{candidate['name']}模式转换失败：{error}"
                    )
                    result["runnable"] = False
                    continue
                if len(variant_analysis["imageInputs"]) <= default_image_input_count:
                    continue
                apply_canvas_model_sources(
                    variant_analysis["models"], candidate["canvas"]
                )
                result["nodeTypes"] = sorted(
                    set(result["nodeTypes"]) | set(variant_analysis["nodeTypes"])
                )
                merge_workflow_resource_findings(result, variant_analysis)
                if (
                    not variant_analysis.get("runnable")
                ):
                    result["issues"].extend(
                        f"{candidate['name']}模式：{issue}"
                        for issue in variant_analysis.get("issues", [])
                    )
                    result["runnable"] = False
                    continue
                default_fields = {
                    item["fieldName"] for item in result["imageInputs"]
                }
                variant_inputs = {
                    item["fieldName"]: item for item in variant_analysis["imageInputs"]
                }
                ordered_variant_inputs = [
                    variant_inputs[item["fieldName"]]
                    for item in result["imageInputs"]
                    if item["fieldName"] in variant_inputs
                ] + [
                    item
                    for item in variant_analysis["imageInputs"]
                    if item["fieldName"] not in default_fields
                ]
                variant_id = candidate["id"]
                variants.append(
                    {
                        "id": variant_id,
                        "name": candidate["name"],
                        "description": candidate["description"],
                        "nodeCount": variant_analysis["nodeCount"],
                        "imageInputs": ordered_variant_inputs,
                        "textInputs": variant_analysis["textInputs"],
                        "parameterInputs": variant_analysis["parameterInputs"],
                        "outputNodes": variant_analysis["outputNodes"],
                    }
                )
                variant_workflows[variant_id] = variant_analysis["workflow"]
            result["variants"] = variants
            if include_workflow:
                result["variantWorkflows"] = variant_workflows
        if not include_workflow:
            result.pop("workflow", None)
        if converted_from_canvas:
            result["format"] = "comfyui-canvas"
            result["conversionStatus"] = "ready"
            result["convertedFromCanvas"] = True
        result["assetVersion"] = self.asset_version
        result["runtimeRevision"] = self.runtime_revision
        result["schemaSource"] = self._schema_source
        result["compatibilityAdjustments"] = compatibility_adjustments
        return result

    @modal.method()
    def convert(
        self,
        raw_workflow: dict[str, Any],
        model_bindings: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        compatibility_adjustments: list[dict[str, str]] = []
        workflow, converted_from_canvas = convert_workflow_document(
            raw_workflow,
            self._object_info_data,
            compatibility_adjustments,
        )
        workflow = apply_model_bindings(workflow, model_bindings)
        return {
            "workflow": workflow,
            "convertedFromCanvas": converted_from_canvas,
            "schemaSource": self._schema_source,
            "compatibilityAdjustments": compatibility_adjustments,
        }

    @modal.method()
    def validate(self) -> dict[str, Any]:
        return {
            "status": "valid",
            "nodeTypes": sorted(self._object_info_data),
            "runtimeRevision": self.runtime_revision,
            "schemaSource": self._schema_source,
        }


@app.cls(
    image=comfy_image,
    gpu=os.environ.get("COMFY_GPU", "L40S"),
    volumes={
        str(MODEL_ROOT): models,
        str(CUSTOM_NODE_ROOT): custom_nodes,
        str(PYTHON_PACKAGES): python_packages,
        str(RUNTIME_ROOT): runtime_assets,
        str(ARTIFACT_ROOT): artifacts,
    },
    scaledown_window=120,
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    startup_timeout=1_200,
    timeout=1_800,
)
@modal.concurrent(max_inputs=1)
class ComfyWorker:
    asset_version: str = modal.parameter(default="base")
    runtime_revision: str = modal.parameter(default=LEGACY_RUNTIME_REVISION)
    port: int = 8188

    @modal.enter()
    def start_comfyui(self) -> None:
        self._runtime_dependency_status: dict[str, bool] = {}
        _start_comfyui(self.runtime_revision, self.port, cpu=False)

    def _runtime_dependency_exists(self, module: str) -> bool:
        if module not in self._runtime_dependency_status:
            self._runtime_dependency_status[module] = (
                _runtime_python_module_available(self.runtime_revision, module)
            )
        return self._runtime_dependency_status[module]

    @modal.method()
    def run(
        self,
        raw_workflow: dict[str, Any],
        assets: dict[str, bytes],
        text_values: dict[str, str],
        parameter_values: dict[str, Any],
        workflow_reference: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        self._check_health()
        object_info = self._object_info()
        installed_nodes = set(object_info)
        workflow, _ = convert_workflow_document(raw_workflow, object_info)
        analysis = analyze_workflow(
            workflow,
            installed_nodes=installed_nodes,
            model_exists=lambda category, filename: (
                MODEL_ROOT / category / filename
            ).is_file(),
            node_info=object_info,
            runtime_dependency_exists=self._runtime_dependency_exists,
        )
        if not analysis["runnable"]:
            raise ValueError("工作流仍有未解决问题：" + "；".join(analysis["issues"]))

        workflow = copy.deepcopy(analysis["workflow"])
        text_input_map = {
            item["fieldName"]: item for item in analysis.get("textInputs", [])
        }
        unknown_text_values = sorted(set(text_values) - set(text_input_map))
        if unknown_text_values:
            raise ValueError("工作流不支持运行参数：" + ", ".join(unknown_text_values))
        for field_name, value in text_values.items():
            item = text_input_map[field_name]
            workflow[item["nodeId"]]["inputs"][item["inputName"]] = value
        parameter_input_map = {
            item["fieldName"]: item for item in analysis.get("parameterInputs", [])
        }
        unknown_parameter_values = sorted(set(parameter_values) - set(parameter_input_map))
        if unknown_parameter_values:
            raise ValueError(
                "工作流不支持运行参数：" + ", ".join(unknown_parameter_values)
            )
        for field_name, value in parameter_values.items():
            item = parameter_input_map[field_name]
            validate_runtime_parameter_value(item, value)
            workflow[item["nodeId"]]["inputs"][item["inputName"]] = value
        required_inputs = {item["fieldName"] for item in analysis["imageInputs"]}
        missing_inputs = sorted(required_inputs - set(assets))
        if missing_inputs:
            raise ValueError("缺少工作流图像输入：" + ", ".join(missing_inputs))

        artifact_id = uuid.uuid4().hex
        COMFY_INPUT.mkdir(parents=True, exist_ok=True)
        COMFY_OUTPUT.mkdir(parents=True, exist_ok=True)
        COMFY_TEMP.mkdir(parents=True, exist_ok=True)
        input_paths: list[Path] = []
        generated_paths: list[Path] = []

        try:
            upload_roots = {"input": COMFY_INPUT, "output": COMFY_OUTPUT, "temp": COMFY_TEMP}
            for item in analysis["imageInputs"]:
                field_name = item["fieldName"]
                data = assets[field_name]
                safe_input = re.sub(r"[^A-Za-z0-9_.-]", "-", item["inputName"])
                filename = f"comfy-desk-{artifact_id}-{item['nodeId']}-{safe_input}.png"
                folder = item.get("folder", "input")
                destination = upload_roots.get(folder, COMFY_INPUT) / filename
                _save_uploaded_image(data, destination)
                input_paths.append(destination)
                annotated_filename = filename if folder == "input" else f"{filename} [{folder}]"
                workflow[item["nodeId"]]["inputs"][item["inputName"]] = annotated_filename

            for node_id in analysis["outputNodes"]:
                if "filename_prefix" in workflow[node_id]["inputs"]:
                    workflow[node_id]["inputs"]["filename_prefix"] = f"comfy-desk/{artifact_id}-{node_id}"

            history = self._execute_workflow(workflow, standard_prompt_id(artifact_id))
            all_file_entries = history_file_entries(history)
            preferred_outputs = preferred_upscale_output_nodes(
                workflow, analysis.get("outputNodes", [])
            )
            file_entries = final_history_file_entries(history, preferred_outputs)
            if not file_entries:
                raise RuntimeError("ComfyUI 已完成，但历史记录中没有文件输出")

            for entry in all_file_entries:
                result = _history_file_path(entry)
                if result.is_file():
                    generated_paths.append(result)

            artifacts.reload()
            created_at = int(time.time())
            _cleanup_expired_artifacts(created_at)
            artifact_dir = ARTIFACT_ROOT / artifact_id
            artifact_dir.mkdir(parents=True, exist_ok=False)
            outputs = []
            artifact_bytes = 0
            for index, entry in enumerate(file_entries):
                result = _history_file_path(entry)
                if not result.is_file():
                    raise RuntimeError(f"ComfyUI 输出文件不存在：{entry['filename']}")
                artifact_bytes += result.stat().st_size
                if artifact_bytes > MAX_ARTIFACT_TOTAL_BYTES:
                    raise RuntimeError("单个任务的输出文件总大小不能超过 2 GB")
                stored_name = f"{index:04d}-{entry['filename']}"
                stored = artifact_dir / stored_name
                shutil.copyfile(result, stored)
                outputs.append(
                    {
                        "index": index,
                        "nodeId": entry["nodeId"],
                        "filename": entry["filename"],
                        "storedName": stored_name,
                        "mediaType": mimetypes.guess_type(entry["filename"])[0]
                        or "application/octet-stream",
                        "bytes": stored.stat().st_size,
                    }
                )
            stored_inputs = []
            if input_paths:
                inputs_dir = artifact_dir / "inputs"
                inputs_dir.mkdir()
                for input_path in input_paths:
                    artifact_bytes += input_path.stat().st_size
                    if artifact_bytes > MAX_ARTIFACT_TOTAL_BYTES:
                        raise RuntimeError("单个任务的输入和输出总大小不能超过 2 GB")
                    stored_input = inputs_dir / input_path.name
                    shutil.copyfile(input_path, stored_input)
                    stored_inputs.append(
                        {"filename": input_path.name, "bytes": stored_input.stat().st_size}
                    )
            (artifact_dir / "workflow.json").write_text(
                json.dumps(workflow), encoding="utf-8"
            )
            manifest = {
                "artifactId": artifact_id,
                "createdAt": created_at,
                "assetVersion": self.asset_version,
                "runtimeRevision": self.runtime_revision,
                "models": _workflow_model_manifest(analysis["models"]),
                "inputs": stored_inputs,
                "outputs": outputs,
                **(workflow_reference or {}),
            }
            (artifact_dir / "manifest.json").write_text(
                json.dumps(manifest), encoding="utf-8"
            )
            artifacts.commit()
            return {
                **manifest,
            }
        finally:
            for path in input_paths:
                path.unlink(missing_ok=True)
            for output in generated_paths:
                if output not in input_paths:
                    output.unlink(missing_ok=True)

    def _object_info(self) -> dict[str, Any]:
        return _read_object_info(self.port)

    def _json_request(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            headers=headers,
            method="POST" if payload is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = error.read(64 * 1024).decode("utf-8", errors="replace")
            raise RuntimeError(comfy_prompt_error_message(detail)) from error
        except (urllib.error.URLError, json.JSONDecodeError) as error:
            raise RuntimeError("无法读取 ComfyUI 工作流状态") from error
        if not isinstance(result, dict):
            raise RuntimeError("ComfyUI 返回了不正确的工作流状态")
        return result

    def _execute_workflow(self, workflow: dict[str, Any], prompt_id: str) -> dict[str, Any]:
        queued = self._json_request(
            "/prompt",
            {"prompt": workflow, "prompt_id": prompt_id, "client_id": prompt_id},
        )
        if queued.get("prompt_id") != prompt_id:
            raise RuntimeError("ComfyUI 返回了不匹配的任务 ID")
        deadline = time.monotonic() + 1_200
        history_path = "/history/" + urllib.parse.quote(prompt_id, safe="")
        while time.monotonic() < deadline:
            history = self._json_request(history_path)
            record = history.get(prompt_id)
            if isinstance(record, dict):
                status = record.get("status")
                if isinstance(status, dict) and status.get("status_str") == "error":
                    message = comfy_execution_error_message(status.get("messages", []))
                    raise RuntimeError(f"ComfyUI 工作流执行失败：{message}")
                return record
            time.sleep(0.5)
        raise TimeoutError("ComfyUI 工作流执行超时")

    def _check_health(self) -> None:
        _check_comfy_health(self.port)


@app.cls(
    image=comfy_image,
    volumes={str(MODEL_ROOT): models},
    secrets=[huggingface],
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    timeout=7_200,
)
@modal.concurrent(max_inputs=1)
class ModelDownloader:
    @modal.method()
    def download_model(
        self,
        repo_id: str,
        repo_file: str,
        category: str,
        filename: str,
        revision: str = "main",
        source_kind: str = "huggingface",
        source_url: str = "",
        expected_sha256: str = "",
    ) -> dict[str, Any]:
        if category not in MODEL_CATEGORIES:
            raise ValueError("不支持的模型目录")
        if not safe_model_reference(filename):
            raise ValueError("模型文件路径不安全")
        expected_sha256 = validate_expected_sha256(expected_sha256)
        if source_kind not in {"huggingface", "url"}:
            raise ValueError("不支持的模型来源")

        models.reload()
        target = MODEL_ROOT / category / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        resolved_repo_file = ""
        resolved_revision = ""
        source = None
        metadata_source: dict[str, Any]
        if source_kind == "huggingface":
            from huggingface_hub import HfApi, hf_hub_download

            if not safe_model_reference(repo_file):
                raise ValueError("模型文件路径不安全")
            if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo_id):
                raise ValueError("Hugging Face 仓库格式应为 owner/repository")
            if not re.fullmatch(r"[A-Za-z0-9_./-]{1,200}", revision) or ".." in revision.split("/"):
                raise ValueError("Hugging Face revision 格式不正确")
            resolved_repo_file = repo_file
            try:
                cached = Path(
                    hf_hub_download(
                        repo_id=repo_id,
                        filename=resolved_repo_file,
                        revision=revision,
                    )
                )
            except Exception as error:
                error_name = type(error).__name__
                if "EntryNotFound" not in error_name:
                    raise ValueError(
                        huggingface_download_error_message(
                            error_name, repo_id, resolved_repo_file, revision
                        )
                    ) from None
                try:
                    resolved_repo_file = discover_repository_file(
                        repo_file,
                        filename,
                        HfApi().list_repo_files(repo_id=repo_id, revision=revision),
                    )
                except ValueError:
                    raise
                except Exception as discovery_error:
                    raise ValueError(
                        huggingface_download_error_message(
                            type(discovery_error).__name__, repo_id, repo_file, revision
                        )
                    ) from None
                if resolved_repo_file is None:
                    raise ValueError(
                        huggingface_download_error_message(
                            error_name, repo_id, repo_file, revision
                        )
                    ) from None
                try:
                    cached = Path(
                        hf_hub_download(
                            repo_id=repo_id,
                            filename=resolved_repo_file,
                            revision=revision,
                        )
                    )
                except Exception as retry_error:
                    raise ValueError(
                        huggingface_download_error_message(
                            type(retry_error).__name__,
                            repo_id,
                            resolved_repo_file,
                            revision,
                        )
                    ) from None
            source = cached.open("rb")
            resolved_revision = revision
            cached_parts = cached.parts
            if "snapshots" in cached_parts:
                snapshot_index = cached_parts.index("snapshots")
                if snapshot_index + 1 < len(cached_parts):
                    resolved_revision = cached_parts[snapshot_index + 1]
            metadata_source = {
                "sourceKind": "huggingface",
                "repoId": repo_id,
                "requestedRepoFile": repo_file,
                "repoFile": resolved_repo_file,
                "requestedRevision": revision,
                "resolvedRevision": resolved_revision,
            }
        else:
            source_url = validate_model_download_url(source_url)

            class SafeModelRedirectHandler(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, request, file_pointer, code, message, headers, new_url):
                    validate_model_download_url(new_url)
                    return super().redirect_request(
                        request, file_pointer, code, message, headers, new_url
                    )
            try:
                opener = urllib.request.build_opener(SafeModelRedirectHandler())
                source = opener.open(
                    urllib.request.Request(
                        source_url,
                        headers={"User-Agent": "LuminaFlow-ModelDownloader/1.0"},
                    ),
                    timeout=120,
                )
                content_type = source.headers.get_content_type()
                try:
                    content_length = int(
                        source.headers.get("Content-Length", "0") or "0"
                    )
                except ValueError:
                    content_length = 0
                if content_type == "text/html":
                    source.close()
                    source = None
                    raise ValueError("下载地址返回了网页，不是模型文件")
                if content_length < 0 or content_length > MAX_MODEL_DOWNLOAD_BYTES:
                    source.close()
                    source = None
                    raise ValueError("模型文件超过 100 GiB 安全上限")
            except Exception as download_error:
                if isinstance(download_error, ValueError):
                    raise
                raise ValueError(
                    f"模型下载地址请求失败：{type(download_error).__name__}"
                ) from None
            metadata_source = {
                "sourceKind": "url",
                "sourceUrl": public_model_download_url(source_url),
            }

        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.partial")
        metadata = target.with_name(f".{target.name}.comfy-desk.json")
        metadata_temporary = metadata.with_name(f".{metadata.name}.{uuid.uuid4().hex}.partial")
        digest = hashlib.sha256()
        copied = 0
        try:
            with temporary.open("xb") as output:
                while chunk := source.read(8 * 1024 * 1024):
                    if copied + len(chunk) > MAX_MODEL_DOWNLOAD_BYTES:
                        raise ValueError("模型文件超过 100 GiB 安全上限")
                    output.write(chunk)
                    digest.update(chunk)
                    copied += len(chunk)
            if copied == 0:
                raise ValueError("远程来源返回了空模型文件")
            actual_sha256 = digest.hexdigest()
            require_matching_sha256(actual_sha256, expected_sha256)
            metadata_temporary.write_text(
                json.dumps(
                    {
                        **metadata_source,
                        "sha256": actual_sha256,
                        "bytes": copied,
                    }
                ),
                encoding="utf-8",
            )
            os.replace(temporary, target)
            os.replace(metadata_temporary, metadata)
            models.commit()
        except Exception:
            temporary.unlink(missing_ok=True)
            metadata_temporary.unlink(missing_ok=True)
            try:
                models.reload()
            except Exception:
                pass
            raise
        finally:
            if source is not None:
                source.close()
        return {
            "status": "installed",
            "path": f"{category}/{filename}",
            "bytes": copied,
            "sha256": digest.hexdigest(),
            **({"revision": resolved_revision, "repoFile": resolved_repo_file}
               if source_kind == "huggingface" else {"sourceUrl": metadata_source["sourceUrl"]}),
            "assetVersion": _publish_asset_version(),
        }


@app.cls(
    image=comfy_image,
    volumes={
        str(CUSTOM_NODE_ROOT): custom_nodes,
        str(PYTHON_PACKAGES): python_packages,
        str(RUNTIME_ROOT): runtime_assets,
    },
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    memory=4_096,
    timeout=7_200,
)
@modal.concurrent(max_inputs=1)
class NodeInstaller:
    @modal.method()
    def install_node(
        self,
        registry_id: str,
        expected_node_types: list[str] | str = "",
        source_repository: str = "",
        source_revision: str = "",
        runtime_package_id: str = "",
    ) -> dict[str, str]:
        if isinstance(expected_node_types, str):
            expected_node_types = [expected_node_types] if expected_node_types else []
        if (
            not isinstance(expected_node_types, list)
            or len(expected_node_types) > 100
            or any(
                not isinstance(node_type, str)
                or not node_type
                or len(node_type) > 300
                or "\n" in node_type
                for node_type in expected_node_types
            )
        ):
            raise ValueError("待验证节点类型格式不正确")
        if bool(source_repository) != bool(source_revision):
            raise ValueError("GitHub 节点源码仓库和 commit 必须同时提供")
        runtime_package = RUNTIME_PYTHON_PACKAGES.get(runtime_package_id)
        if runtime_package_id and runtime_package is None:
            raise ValueError("不支持的运行扩展")
        if runtime_package_id and (registry_id or source_repository or source_revision):
            raise ValueError("运行扩展不能与节点包同时安装")
        runtime_assets.reload()
        current_revision = str(asset_state.get(RUNTIME_CURRENT_KEY, LEGACY_RUNTIME_REVISION))
        previous_revision = str(asset_state.get(RUNTIME_PREVIOUS_KEY, ""))
        current_asset_version = str(asset_state.get("current", "base"))
        if runtime_package is not None:
            _prune_runtime_revisions({current_revision, previous_revision})
            _, current_python = _runtime_paths(current_revision)
            install_paths = [
                Path(str(path)) for path in runtime_package["installPaths"]
            ]
            destinations = [current_python / path for path in install_paths]
            if any(path.exists() for path in destinations):
                if not all(path.exists() for path in destinations):
                    raise RuntimeError("运行扩展存在不完整安装，请回滚节点环境后重试")
                _validate_runtime_python_package(current_python, runtime_package)
                return {
                    "status": "installed",
                    "registryId": runtime_package_id,
                    "version": str(runtime_package["version"]),
                    "source": "python",
                    "runtimeRevision": current_revision,
                    "validatedNodeTypes": "0",
                    "assetVersion": _publish_asset_version(),
                }
            try:
                with tempfile.TemporaryDirectory(
                    prefix="comfy-desk-runtime-package-"
                ) as temporary:
                    staged_python = Path(temporary)
                    protected_dependencies = _install_python_dependencies(
                        [str(runtime_package["requirement"])], staged_python
                    )
                    _validate_runtime_python_package(staged_python, runtime_package)
                    for relative, destination in zip(
                        install_paths, destinations, strict=True
                    ):
                        source = staged_python / relative
                        if not source.exists():
                            raise RuntimeError(
                                f"运行扩展安装结果缺少 {relative}"
                            )
                        if source.is_dir():
                            shutil.copytree(source, destination)
                        else:
                            shutil.copy2(source, destination)
                runtime_assets.commit()
            except Exception:
                try:
                    runtime_assets.reload()
                except Exception:
                    pass
                raise
            return {
                "status": "installed",
                "registryId": runtime_package_id,
                "version": str(runtime_package["version"]),
                "source": "python",
                "protectedDependencies": ",".join(protected_dependencies),
                "runtimeRevision": current_revision,
                "validatedNodeTypes": "0",
                "assetVersion": _publish_asset_version(),
            }
        try:
            baseline_validation = ComfyInspector(
                asset_version=current_asset_version,
                runtime_revision=current_revision,
            ).validate.remote()
            baseline_node_types = set(baseline_validation["nodeTypes"])
        except Exception as error:
            raise RuntimeError(
                "无法验证当前节点环境；节点安装已取消，当前运行版本未改变"
            ) from error
        source_nodes, source_python = _runtime_paths(current_revision)
        _prune_runtime_revisions({current_revision, previous_revision})
        runtime_assets.commit()
        revision = _asset_version()
        revision_root = RUNTIME_REVISIONS / revision
        staged_nodes, staged_python = _runtime_paths(revision)

        try:
            revision_root.mkdir(parents=True, exist_ok=False)
            _copy_runtime(source_nodes, staged_nodes)
            _copy_runtime(source_python, staged_python)
            if source_revision:
                result = install_github_node(
                    registry_id,
                    source_repository,
                    source_revision,
                    custom_node_root=staged_nodes,
                    python_packages=staged_python,
                )
            else:
                result = install_registry_node(
                    registry_id,
                    custom_node_root=staged_nodes,
                    python_packages=staged_python,
                )
            (revision_root / "runtime.json").write_text(
                json.dumps(
                    {
                        "revision": revision,
                        "parent": current_revision,
                        "registryId": result["registryId"],
                        "version": result["version"],
                        "source": result.get("source", "registry"),
                        **(
                            {"repository": result["repository"]}
                            if result.get("repository")
                            else {}
                        ),
                    }
                ),
                encoding="utf-8",
            )
            runtime_assets.commit()
        except Exception:
            shutil.rmtree(revision_root, ignore_errors=True)
            try:
                runtime_assets.reload()
            except Exception:
                pass
            raise

        try:
            asset_version = f"runtime-{revision}"
            validation = ComfyInspector(
                asset_version=asset_version,
                runtime_revision=revision,
            ).validate.remote()
        except Exception as error:
            _discard_runtime_revision(revision_root)
            raise RuntimeError(
                "节点已在隔离版本中安装，但 ComfyUI 启动验证失败；当前运行版本未改变"
            ) from error
        missing_expected_types = sorted(
            set(expected_node_types) - set(validation["nodeTypes"])
        )
        if missing_expected_types:
            _discard_runtime_revision(revision_root)
            raise RuntimeError(
                "节点包安装后仍未提供工作流需要的节点类型："
                + "、".join(missing_expected_types)
                + "；当前运行版本未改变"
            )
        missing_previous_types = sorted(baseline_node_types - set(validation["nodeTypes"]))
        if missing_previous_types:
            preview = ", ".join(missing_previous_types[:8])
            _discard_runtime_revision(revision_root)
            raise RuntimeError(
                f"新节点环境导致 {len(missing_previous_types)} 个已有节点类型失效（{preview}）；当前运行版本未改变"
            )

        try:
            _record_runtime_validation(revision, validation["nodeTypes"])
        except Exception as error:
            _discard_runtime_revision(revision_root)
            raise RuntimeError(
                "节点环境已通过验证，但验证清单保存失败；当前运行版本未改变"
            ) from error

        asset_state.put(RUNTIME_PREVIOUS_KEY, current_revision)
        asset_state.put(RUNTIME_CURRENT_KEY, revision)
        return {
            "status": "installed",
            **result,
            "runtimeRevision": revision,
            "validatedNodeTypes": str(len(validation["nodeTypes"])),
            "assetVersion": _publish_asset_version(asset_version),
        }

    @modal.method()
    def rollback_runtime(self) -> dict[str, str]:
        current_revision = str(asset_state.get(RUNTIME_CURRENT_KEY, LEGACY_RUNTIME_REVISION))
        previous_revision = str(asset_state.get(RUNTIME_PREVIOUS_KEY, ""))
        if not previous_revision:
            raise ValueError("没有可回滚的节点环境")
        previous_nodes, previous_python = _runtime_paths(previous_revision)
        if not previous_nodes.is_dir() or not previous_python.is_dir():
            raise ValueError("上一节点环境已不存在")
        asset_state.put(RUNTIME_CURRENT_KEY, previous_revision)
        asset_state.put(RUNTIME_PREVIOUS_KEY, current_revision)
        return {
            "status": "rolled-back",
            "runtimeRevision": previous_revision,
            "assetVersion": _publish_asset_version(),
        }


@app.function(
    image=web_image,
    secrets=[config],
    volumes={
        str(ARTIFACT_ROOT): artifacts,
        str(WORKFLOW_ROOT): workflow_catalog,
        str(MODEL_ROOT): models,
    },
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    timeout=660,
)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def api():
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import FileResponse, JSONResponse

    web = FastAPI(title="Comfy Desk API", docs_url=None, redoc_url=None)

    def require_auth(request: Request) -> None:
        if not os.environ.get("COMFY_API_TOKEN"):
            raise HTTPException(status_code=503, detail="server authentication is not configured")
        if not _authorized(request):
            raise HTTPException(status_code=401, detail="invalid bearer token")

    def require_request_size(request: Request, maximum: int) -> None:
        raw_length = request.headers.get("content-length")
        if raw_length is None:
            return
        try:
            content_length = int(raw_length)
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Content-Length 不正确") from error
        if content_length < 0 or content_length > maximum:
            raise HTTPException(status_code=413, detail="请求体过大")

    async def current_asset_version() -> str:
        return str(await asset_state.get.aio("current", "base"))

    async def current_runtime_revision() -> str:
        return str(await asset_state.get.aio(RUNTIME_CURRENT_KEY, LEGACY_RUNTIME_REVISION))

    def workflow_reference_from_state(state: Any) -> dict[str, str]:
        if not isinstance(state, dict):
            return {}
        return {
            key: value
            for key in (
                "workflowId",
                "workflowRevisionId",
                "workflowName",
                "workflowVariantId",
                "workflowVariantName",
            )
            if isinstance((value := state.get(key)), str)
        }

    async def workflow_from_form(form: Any) -> dict[str, Any]:
        raw = form.get("workflow")
        if raw is None:
            raise HTTPException(status_code=400, detail="缺少 workflow")
        if hasattr(raw, "read"):
            filename = str(getattr(raw, "filename", "workflow.json") or "workflow.json")
            suffix = Path(filename).suffix.lower()
            limit = MAX_WORKFLOW_IMAGE_BYTES if suffix in IMAGE_SUFFIXES else MAX_WORKFLOW_BYTES
            data = await raw.read(limit + 1)
        else:
            data = str(raw).encode("utf-8")
            filename = "workflow.json"
            limit = MAX_WORKFLOW_BYTES
        if len(data) > limit:
            maximum = limit // (1024 * 1024)
            raise HTTPException(status_code=413, detail=f"工作流文件不能超过 {maximum} MB")
        try:
            return load_workflow_document(data, filename)
        except WorkflowFormatError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    def model_bindings_from_form(form: Any) -> list[dict[str, str]]:
        try:
            return parse_model_bindings(form.get("modelBindings"))
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    async def analyze_document(
        workflow: dict[str, Any],
        asset_version: str,
        runtime_revision: str,
        *,
        include_workflow: bool = False,
        model_bindings: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        result = await ComfyInspector(
            asset_version=asset_version,
            runtime_revision=runtime_revision,
        ).inspect.remote.aio(workflow, include_workflow, model_bindings)
        missing_nodes = result.get("missingNodes")
        package_hints = result.pop("nodePackageHints", None)
        if isinstance(missing_nodes, list) and missing_nodes:
            try:
                result.update(
                    await asyncio.to_thread(
                        resolve_missing_node_packages,
                        [str(node_type) for node_type in missing_nodes],
                        package_hints if isinstance(package_hints, dict) else None,
                    )
                )
            except Exception:
                logging.exception("ComfyUI Registry 节点包查询失败")
                result = with_node_package_lookup_failure(result, missing_nodes)
        result["canRollbackRuntime"] = bool(
            await asset_state.get.aio(RUNTIME_PREVIOUS_KEY, "")
        )
        return result

    def validated_job_result(result: Any) -> dict[str, Any]:
        if not isinstance(result, dict):
            raise HTTPException(status_code=500, detail="任务结果格式不正确")
        artifact_id = result.get("artifactId")
        outputs = result.get("outputs")
        if not isinstance(artifact_id, str) or not re.fullmatch(r"[a-f0-9]{32}", artifact_id):
            raise HTTPException(status_code=500, detail="任务 Artifact ID 不正确")
        if not isinstance(outputs, list) or not outputs:
            raise HTTPException(status_code=500, detail="任务没有可用输出")
        return result

    async def artifact_response(result: Any, output_index: int):
        manifest = validated_job_result(result)
        outputs = manifest["outputs"]
        if output_index < 0 or output_index >= len(outputs):
            raise HTTPException(status_code=404, detail="输出文件不存在")
        output = outputs[output_index]
        if not isinstance(output, dict):
            raise HTTPException(status_code=500, detail="输出文件信息不正确")
        stored_name = output.get("storedName")
        filename = output.get("filename")
        media_type = output.get("mediaType")
        if not isinstance(stored_name, str) or Path(stored_name).name != stored_name:
            raise HTTPException(status_code=500, detail="输出文件路径不正确")
        if not isinstance(filename, str) or not filename:
            raise HTTPException(status_code=500, detail="输出文件名不正确")
        await artifacts.reload.aio()
        path = ARTIFACT_ROOT / manifest["artifactId"] / stored_name
        if not path.is_file():
            raise HTTPException(status_code=404, detail="输出文件已过期或不存在")
        return FileResponse(
            path,
            media_type=media_type if isinstance(media_type, str) else "application/octet-stream",
            filename=Path(filename).name,
            content_disposition_type="inline",
        )

    async def stored_artifact_result(artifact_id: str) -> dict[str, Any]:
        if not re.fullmatch(r"[a-f0-9]{32}", artifact_id):
            raise HTTPException(status_code=500, detail="任务 Artifact ID 不正确")
        await artifacts.reload.aio()
        manifest_file = ARTIFACT_ROOT / artifact_id / "manifest.json"
        if not manifest_file.is_file():
            raise HTTPException(status_code=404, detail="任务结果已过期或不存在")
        try:
            result = json.loads(manifest_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise HTTPException(status_code=500, detail="任务结果清单损坏") from error
        return validated_job_result(result)

    async def completed_or_active_job_result(job_id: str) -> dict[str, Any] | None:
        saved_state = await job_state.get.aio(job_id, None)
        if isinstance(saved_state, dict):
            status = saved_state.get("status")
            if status == "cancelled":
                raise HTTPException(status_code=409, detail="任务已取消")
            if status == "failed":
                raise HTTPException(
                    status_code=422,
                    detail=str(saved_state.get("message", "任务运行失败")),
                )
            artifact_id = saved_state.get("artifactId")
            if status == "succeeded" and isinstance(artifact_id, str):
                return await stored_artifact_result(artifact_id)
        call = modal.functions.FunctionCall.from_id(job_id)
        try:
            return validated_job_result(await call.get.aio(timeout=0))
        except TimeoutError:
            return None

    @web.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "app": APP_NAME}

    @web.get("/ready")
    async def ready(request: Request) -> dict[str, Any]:
        require_auth(request)
        return {
            "status": "ready",
            "app": APP_NAME,
            "comfyuiVersion": COMFYUI_VERSION,
            "assetVersion": await current_asset_version(),
            "runtimeRevision": await current_runtime_revision(),
            "canRollbackRuntime": bool(
                await asset_state.get.aio(RUNTIME_PREVIOUS_KEY, "")
            ),
        }

    @web.post("/workflows/analyze")
    async def inspect_workflow(request: Request):
        require_auth(request)
        require_request_size(request, MAX_ANALYZE_REQUEST_BYTES)
        form = await request.form()
        workflow = await workflow_from_form(form)
        model_bindings = model_bindings_from_form(form)
        asset_version = await current_asset_version()
        runtime_revision = await current_runtime_revision()
        try:
            return await analyze_document(
                workflow,
                asset_version,
                runtime_revision,
                model_bindings=model_bindings,
            )
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.get("/workflows")
    async def stored_workflows(request: Request):
        require_auth(request)
        await workflow_catalog.reload.aio()
        runtime_revision = await current_runtime_revision()
        return {
            "workflows": list_stored_workflows(WORKFLOW_ROOT, runtime_revision)
        }

    @web.post("/workflows", status_code=201)
    async def store_workflow(request: Request):
        require_auth(request)
        require_request_size(request, MAX_ANALYZE_REQUEST_BYTES)
        form = await request.form()
        uploaded = form.get("workflow")
        source_filename = str(
            getattr(uploaded, "filename", "workflow.json") or "workflow.json"
        )
        requested_name = str(form.get("name", "")).strip()
        name = requested_name or Path(source_filename).stem or "未命名工作流"
        workflow = await workflow_from_form(form)
        model_bindings = model_bindings_from_form(form)
        asset_version = await current_asset_version()
        runtime_revision = await current_runtime_revision()
        try:
            analysis = await analyze_document(
                workflow,
                asset_version,
                runtime_revision,
                include_workflow=True,
                model_bindings=model_bindings,
            )
            if not analysis.get("runnable"):
                issues = analysis.get("issues")
                detail = "；".join(str(issue) for issue in issues) if isinstance(issues, list) else ""
                raise ValueError(
                    "工作流尚未通过云端检查" + (f"：{detail}" if detail else "")
                )
            prepared_workflow = analysis.pop("workflow", None)
            variant_workflows = analysis.pop("variantWorkflows", None)
            if not isinstance(prepared_workflow, dict):
                raise ValueError("工作流检查结果缺少规范化 API 工作流")
            if variant_workflows is not None and not isinstance(variant_workflows, dict):
                raise ValueError("工作流变体检查结果格式不正确")
            await workflow_catalog.reload.aio()
            manifest = create_stored_workflow(
                WORKFLOW_ROOT,
                prepared_workflow,
                analysis,
                variant_workflows=variant_workflows,
                name=name,
                source_filename=source_filename,
                runtime_revision=runtime_revision,
                asset_version=asset_version,
            )
            await workflow_catalog.commit.aio()
            return manifest
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.get("/workflows/{workflow_id}")
    async def stored_workflow(workflow_id: str, request: Request):
        require_auth(request)
        await workflow_catalog.reload.aio()
        try:
            requested_revision = str(request.query_params.get("revisionId", "")).strip()
            manifest, _ = (
                load_stored_workflow_revision(
                    WORKFLOW_ROOT, workflow_id, requested_revision
                )
                if requested_revision
                else load_stored_workflow(WORKFLOW_ROOT, workflow_id)
            )
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return workflow_record_for_runtime(
            manifest, await current_runtime_revision()
        )

    @web.put("/workflows/{workflow_id}")
    async def replace_stored_workflow(workflow_id: str, request: Request):
        require_auth(request)
        require_request_size(request, MAX_ANALYZE_REQUEST_BYTES)
        await workflow_catalog.reload.aio()
        try:
            stored_manifest, _ = load_stored_workflow(WORKFLOW_ROOT, workflow_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

        form = await request.form()
        uploaded = form.get("workflow")
        source_filename = str(
            getattr(uploaded, "filename", "workflow.json") or "workflow.json"
        )
        requested_name = str(form.get("name", "")).strip()
        workflow = await workflow_from_form(form)
        model_bindings = model_bindings_from_form(form)
        asset_version = await current_asset_version()
        runtime_revision = await current_runtime_revision()
        try:
            analysis = await analyze_document(
                workflow,
                asset_version,
                runtime_revision,
                include_workflow=True,
                model_bindings=model_bindings,
            )
            if not analysis.get("runnable"):
                raise ValueError(
                    "工作流尚未通过云端检查："
                    + "；".join(str(issue) for issue in analysis.get("issues", []))
                )
            prepared_workflow = analysis.pop("workflow", None)
            variant_workflows = analysis.pop("variantWorkflows", None)
            if not isinstance(prepared_workflow, dict):
                raise ValueError("工作流检查结果缺少规范化 API 工作流")
            if variant_workflows is not None and not isinstance(variant_workflows, dict):
                raise ValueError("工作流变体检查结果格式不正确")
            manifest = refresh_stored_workflow(
                WORKFLOW_ROOT,
                workflow_id,
                prepared_workflow,
                analysis,
                variant_workflows=variant_workflows,
                runtime_revision=runtime_revision,
                asset_version=asset_version,
                name=requested_name or str(stored_manifest["name"]),
                source_filename=source_filename,
                source_format=str(analysis.get("format", "comfyui-api")),
            )
            await workflow_catalog.commit.aio()
            return manifest
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.post("/workflows/{workflow_id}/recheck")
    async def recheck_stored_workflow(workflow_id: str, request: Request):
        require_auth(request)
        require_request_size(request, MAX_JSON_REQUEST_BYTES)
        body: Any = {}
        if request.headers.get("content-type", "").startswith("application/json"):
            try:
                body = await request.json()
            except Exception as error:
                raise HTTPException(status_code=400, detail="请求 JSON 格式不正确") from error
        try:
            model_bindings = parse_model_bindings(
                body.get("modelBindings") if isinstance(body, dict) else None
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        await workflow_catalog.reload.aio()
        try:
            stored_manifest, workflow = load_stored_workflow(
                WORKFLOW_ROOT, workflow_id
            )
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

        asset_version = await current_asset_version()
        runtime_revision = await current_runtime_revision()
        try:
            analysis = await analyze_document(
                workflow,
                asset_version,
                runtime_revision,
                include_workflow=True,
                model_bindings=model_bindings,
            )
            previous_model_sources = {
                (item.get("category"), item.get("filename")): item.get("source")
                for item in stored_manifest.get("models", [])
                if isinstance(item, dict) and isinstance(item.get("source"), dict)
            }
            for model in analysis.get("models", []):
                if not isinstance(model, dict) or isinstance(model.get("source"), dict):
                    continue
                source = previous_model_sources.get(
                    (model.get("category"), model.get("filename"))
                )
                if isinstance(source, dict):
                    model["source"] = source
            generated_variant_workflows = analysis.pop("variantWorkflows", None)
            refreshed_variants = list(analysis.get("variants", []))
            refreshed_variant_workflows = (
                dict(generated_variant_workflows)
                if isinstance(generated_variant_workflows, dict)
                else {}
            )
            stored_variants = stored_manifest.get("variants")
            if isinstance(stored_variants, list) and stored_variants:
                refreshed_variants = []
                refreshed_variant_workflows = {}
                for stored_variant in stored_variants:
                    if not isinstance(stored_variant, dict):
                        continue
                    variant_id = stored_variant.get("id")
                    if not isinstance(variant_id, str):
                        continue
                    try:
                        _, variant_workflow = load_stored_workflow_variant(
                            WORKFLOW_ROOT, workflow_id, variant_id
                        )
                        variant_analysis = await analyze_document(
                            variant_workflow,
                            asset_version,
                            runtime_revision,
                            include_workflow=True,
                            model_bindings=model_bindings,
                        )
                    except Exception as variant_error:
                        analysis["issues"].append(
                            f"变体 {stored_variant.get('name', variant_id)} 复查失败：{variant_error}"
                        )
                        analysis["runnable"] = False
                        continue
                    if not variant_analysis.get("runnable"):
                        for model in variant_analysis.get("models", []):
                            if not isinstance(model, dict) or isinstance(model.get("source"), dict):
                                continue
                            source = previous_model_sources.get(
                                (model.get("category"), model.get("filename"))
                            )
                            if isinstance(source, dict):
                                model["source"] = source
                        merge_workflow_resource_findings(analysis, variant_analysis)
                        analysis["nodeTypes"] = sorted(
                            set(analysis.get("nodeTypes", []))
                            | set(variant_analysis.get("nodeTypes", []))
                        )
                        analysis["issues"].append(
                            f"变体 {stored_variant.get('name', variant_id)} 尚不可运行："
                            + "；".join(str(issue) for issue in variant_analysis.get("issues", []))
                        )
                        analysis["runnable"] = False
                        continue
                    for model in variant_analysis.get("models", []):
                        if not isinstance(model, dict) or isinstance(model.get("source"), dict):
                            continue
                        source = previous_model_sources.get(
                            (model.get("category"), model.get("filename"))
                        )
                        if isinstance(source, dict):
                            model["source"] = source
                    merge_workflow_resource_findings(analysis, variant_analysis)
                    analysis["nodeTypes"] = sorted(
                        set(analysis.get("nodeTypes", []))
                        | set(variant_analysis.get("nodeTypes", []))
                    )
                    prepared_variant = variant_analysis.pop("workflow", None)
                    if not isinstance(prepared_variant, dict):
                        analysis["issues"].append(
                            f"变体 {stored_variant.get('name', variant_id)} 缺少规范化工作流"
                        )
                        analysis["runnable"] = False
                        continue
                    variant_inputs = {
                        item["fieldName"]: item
                        for item in variant_analysis["imageInputs"]
                    }
                    previous_input_order = [
                        item.get("fieldName")
                        for item in stored_variant.get("imageInputs", [])
                        if isinstance(item, dict)
                    ]
                    ordered_variant_inputs = [
                        variant_inputs[field_name]
                        for field_name in previous_input_order
                        if field_name in variant_inputs
                    ] + [
                        item
                        for item in variant_analysis["imageInputs"]
                        if item["fieldName"] not in previous_input_order
                    ]
                    refreshed_variants.append(
                        {
                            "id": variant_id,
                            "name": str(stored_variant.get("name", variant_id)),
                            "description": str(stored_variant.get("description", "")),
                            "nodeCount": variant_analysis["nodeCount"],
                            "imageInputs": ordered_variant_inputs,
                            "textInputs": variant_analysis["textInputs"],
                            "parameterInputs": variant_analysis["parameterInputs"],
                            "outputNodes": variant_analysis["outputNodes"],
                        }
                    )
                    refreshed_variant_workflows[variant_id] = prepared_variant
            analysis["variants"] = refreshed_variants
            if not analysis.get("runnable"):
                analysis.pop("workflow", None)
                return JSONResponse(
                    {
                        "message": "工作流复查未通过，请补齐缺失资源",
                        "analysis": analysis,
                    },
                    status_code=409,
                )
            prepared_workflow = analysis.pop("workflow", None)
            if not isinstance(prepared_workflow, dict):
                raise ValueError("工作流检查结果缺少规范化 API 工作流")
            manifest = refresh_stored_workflow(
                WORKFLOW_ROOT,
                workflow_id,
                prepared_workflow,
                analysis,
                variant_workflows=refreshed_variant_workflows,
                runtime_revision=runtime_revision,
                asset_version=asset_version,
            )
            await workflow_catalog.commit.aio()
            return manifest
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.post("/workflows/convert")
    async def convert_workflow(request: Request):
        require_auth(request)
        require_request_size(request, MAX_ANALYZE_REQUEST_BYTES)
        form = await request.form()
        workflow = await workflow_from_form(form)
        model_bindings = model_bindings_from_form(form)
        asset_version = await current_asset_version()
        runtime_revision = await current_runtime_revision()
        try:
            result = await ComfyInspector(
                asset_version=asset_version,
                runtime_revision=runtime_revision,
            ).convert.remote.aio(workflow, model_bindings)
            return JSONResponse(
                result["workflow"],
                headers={
                    "Content-Disposition": 'attachment; filename="workflow-api.json"'
                },
            )
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.get("/resources/models")
    async def installed_models(request: Request):
        require_auth(request)
        await models.reload.aio()
        return {"models": list_model_assets(MODEL_ROOT)}

    @web.post("/resources/models", status_code=202)
    async def install_model(request: Request):
        require_auth(request)
        require_request_size(request, MAX_JSON_REQUEST_BYTES)
        body = await request.json()
        try:
            call = await ModelDownloader().download_model.spawn.aio(
                str(body.get("repoId", "")),
                str(body.get("repoFile", "")),
                str(body.get("category", "")),
                str(body.get("filename", "")),
                str(body.get("revision", "main")),
                str(body.get("sourceKind", "huggingface")),
                str(body.get("sourceUrl", "")),
                str(body.get("sha256", "")),
            )
            return {
                "jobId": call.object_id,
                "status": "processing",
                "message": "模型下载任务已提交到 Modal",
            }
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.post("/resources/nodes", status_code=202)
    async def install_node(request: Request):
        require_auth(request)
        require_request_size(request, MAX_JSON_REQUEST_BYTES)
        body = await request.json()
        expected_node_types = body.get("nodeTypes")
        if not isinstance(expected_node_types, list):
            expected_node_types = [str(body.get("nodeType", ""))]
        try:
            call = await NodeInstaller().install_node.spawn.aio(
                str(body.get("registryId", "")),
                expected_node_types,
                str(body.get("sourceRepository", "")),
                str(body.get("sourceRevision", "")),
            )
            return {
                "jobId": call.object_id,
                "status": "processing",
                "message": "节点安装任务已提交到 Modal",
            }
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.post("/resources/runtime/rollback", status_code=202)
    async def rollback_runtime(request: Request):
        require_auth(request)
        try:
            call = await NodeInstaller().rollback_runtime.spawn.aio()
            return {
                "jobId": call.object_id,
                "status": "processing",
                "message": "节点环境回滚任务已提交到 Modal",
            }
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.post("/resources/runtime/packages", status_code=202)
    async def install_runtime_package(request: Request):
        require_auth(request)
        require_request_size(request, MAX_JSON_REQUEST_BYTES)
        body = await request.json()
        try:
            call = await NodeInstaller().install_node.spawn.aio(
                "",
                [],
                "",
                "",
                str(body.get("packageId", "")),
            )
            return {
                "jobId": call.object_id,
                "status": "processing",
                "message": "运行扩展安装任务已提交到 Modal",
            }
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @web.get("/resources/jobs/{job_id}")
    async def resource_job_status(job_id: str, request: Request):
        require_auth(request)
        try:
            call = modal.functions.FunctionCall.from_id(job_id)
            result = await call.get.aio(timeout=0)
        except TimeoutError:
            return JSONResponse(
                {"jobId": job_id, "status": "processing", "message": "云端正在安装资源"},
                status_code=202,
            )
        except Exception as error:
            return {"jobId": job_id, "status": "failed", "message": str(error)}
        if not isinstance(result, dict) or not isinstance(result.get("assetVersion"), str):
            return {"jobId": job_id, "status": "failed", "message": "资源任务结果格式不正确"}
        return {
            "jobId": job_id,
            "status": "succeeded",
            "message": "资源安装完成",
            "assetVersion": result["assetVersion"],
        }

    @web.delete("/resources/jobs/{job_id}")
    async def cancel_resource_job(job_id: str, request: Request):
        require_auth(request)
        call = modal.functions.FunctionCall.from_id(job_id)
        try:
            await call.hydrate.aio()
            await call.cancel.aio()
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {"jobId": job_id, "status": "cancelled", "message": "资源任务已取消"}

    @web.post("/jobs", status_code=202)
    async def create_job(request: Request):
        require_auth(request)
        require_request_size(request, MAX_RUN_REQUEST_BYTES)
        form = await request.form()
        asset_version = await current_asset_version()
        runtime_revision = await current_runtime_revision()
        workflow_reference: dict[str, str] | None = None
        runtime_schema: dict[str, Any] | None = None
        workflow_id = str(form.get("workflowId", "")).strip()
        workflow_revision_id = str(form.get("workflowRevisionId", "")).strip()
        if workflow_id:
            await workflow_catalog.reload.aio()
            try:
                stored_manifest, workflow = (
                    load_stored_workflow_revision(
                        WORKFLOW_ROOT, workflow_id, workflow_revision_id
                    )
                    if workflow_revision_id
                    else load_stored_workflow(WORKFLOW_ROOT, workflow_id)
                )
            except ValueError as error:
                raise HTTPException(status_code=404, detail=str(error)) from error
            current_record = workflow_record_for_runtime(
                stored_manifest, runtime_revision
            )
            if current_record.get("status") != "ready":
                raise HTTPException(
                    status_code=409,
                    detail=str(
                        current_record.get(
                            "statusMessage", "工作流当前不可运行，请重新检查"
                        )
                    ),
                )
            runtime_schema = stored_manifest
            variant_id = str(form.get("variantId", "")).strip()
            if variant_id:
                variants = stored_manifest.get("variants")
                variant = next(
                    (
                        item
                        for item in variants
                        if isinstance(item, dict) and item.get("id") == variant_id
                    ),
                    None,
                ) if isinstance(variants, list) else None
                if not isinstance(variant, dict):
                    raise HTTPException(status_code=400, detail="工作流变体不存在")
                try:
                    _, workflow = load_stored_workflow_variant(
                        WORKFLOW_ROOT,
                        workflow_id,
                        variant_id,
                        workflow_revision_id or None,
                    )
                except ValueError as error:
                    raise HTTPException(status_code=400, detail=str(error)) from error
                runtime_schema = variant
            workflow_reference = {
                "workflowId": str(stored_manifest["id"]),
                "workflowRevisionId": str(stored_manifest["revisionId"]),
                "workflowName": str(stored_manifest["name"]),
            }
            if variant_id:
                workflow_reference.update(
                    {
                        "workflowVariantId": variant_id,
                        "workflowVariantName": str(runtime_schema.get("name", variant_id)),
                    }
                )
        else:
            if workflow_revision_id:
                raise HTTPException(
                    status_code=400,
                    detail="工作流版本需要 workflowId",
                )
            if str(form.get("variantId", "")).strip():
                raise HTTPException(status_code=400, detail="工作流变体需要 workflowId")
            workflow = await workflow_from_form(form)
        assets: dict[str, bytes] = {}
        total_upload_bytes = 0
        upload_count = 0
        for field_name, upload in form.multi_items():
            if not isinstance(field_name, str) or not field_name.startswith("asset_"):
                continue
            if not hasattr(upload, "read"):
                raise HTTPException(status_code=400, detail=f"输入 {field_name} 不是文件")
            upload_count += 1
            if upload_count > 50:
                raise HTTPException(status_code=413, detail="运行时图像不能超过 50 个")
            data = await upload.read(MAX_UPLOAD_BYTES + 1)
            if len(data) > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="单个图像不能超过 25 MB")
            total_upload_bytes += len(data)
            if total_upload_bytes > MAX_TOTAL_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="运行时图像总大小不能超过 100 MB")
            try:
                validate_uploaded_image(data)
            except ValueError as error:
                raise HTTPException(
                    status_code=400,
                    detail=f"输入 {field_name}：{error}",
                ) from error
            assets[field_name] = data

        text_values: dict[str, str] = {}
        total_text_length = 0
        for field_name, value in form.multi_items():
            if not isinstance(field_name, str) or not field_name.startswith("param_"):
                continue
            if not isinstance(value, str):
                raise HTTPException(status_code=400, detail=f"参数 {field_name} 不是文本")
            if len(value) > 20_000:
                raise HTTPException(status_code=413, detail="单个提示词不能超过 20000 个字符")
            total_text_length += len(value)
            if total_text_length > 100_000:
                raise HTTPException(status_code=413, detail="运行参数总长度不能超过 100000 个字符")
            text_values[field_name] = value

        raw_parameter_values: dict[str, str] = {}
        for field_name, value in form.multi_items():
            if not isinstance(field_name, str) or not field_name.startswith("control_"):
                continue
            if not isinstance(value, str) or len(value) > 200:
                raise HTTPException(status_code=400, detail=f"参数 {field_name} 格式不正确")
            raw_parameter_values[field_name] = value

        parameter_values: dict[str, Any] = {}

        if runtime_schema is not None:
            expected_assets = {
                str(item.get("fieldName"))
                for item in runtime_schema.get("imageInputs", [])
                if isinstance(item, dict)
            }
            unexpected_assets = sorted(set(assets) - expected_assets)
            if unexpected_assets:
                raise HTTPException(
                    status_code=400,
                    detail="工作流不支持图像输入：" + ", ".join(unexpected_assets),
                )
            missing_assets = sorted(expected_assets - set(assets))
            if missing_assets:
                raise HTTPException(
                    status_code=400,
                    detail="缺少工作流图像输入：" + ", ".join(missing_assets),
                )
            expected_text = {
                str(item.get("fieldName"))
                for item in runtime_schema.get("textInputs", [])
                if isinstance(item, dict)
            }
            unexpected_text = sorted(set(text_values) - expected_text)
            if unexpected_text:
                raise HTTPException(
                    status_code=400,
                    detail="工作流不支持运行参数：" + ", ".join(unexpected_text),
                )
            parameter_input_map = {
                str(item.get("fieldName")): item
                for item in runtime_schema.get("parameterInputs", [])
                if isinstance(item, dict)
            }
            unexpected_parameters = sorted(
                set(raw_parameter_values) - set(parameter_input_map)
            )
            if unexpected_parameters:
                raise HTTPException(
                    status_code=400,
                    detail="工作流不支持运行参数：" + ", ".join(unexpected_parameters),
                )
            for field_name, raw_value in raw_parameter_values.items():
                try:
                    parameter_values[field_name] = coerce_runtime_parameter_value(
                        parameter_input_map[field_name], raw_value
                    )
                except ValueError as error:
                    raise HTTPException(status_code=400, detail=str(error)) from error
        elif raw_parameter_values:
            raise HTTPException(status_code=400, detail="运行参数需要使用已保存工作流")

        call = await ComfyWorker(
            asset_version=asset_version,
            runtime_revision=runtime_revision,
        ).run.spawn.aio(
            workflow,
            assets,
            text_values,
            parameter_values,
            workflow_reference,
        )
        state = {"status": "processing", **(workflow_reference or {})}
        await job_state.put.aio(call.object_id, state)
        return {
            "jobId": call.object_id,
            "status": "processing",
            "message": "工作流已提交到 Modal",
            "assetVersion": asset_version,
            **(workflow_reference or {}),
        }

    @web.get("/jobs/{job_id}")
    async def job_status(job_id: str, request: Request):
        require_auth(request)
        saved_state = await job_state.get.aio(job_id, None)
        if isinstance(saved_state, dict) and saved_state.get("status") == "cancelled":
            return {
                "jobId": job_id,
                "status": "cancelled",
                "message": "任务已取消",
                **workflow_reference_from_state(saved_state),
            }
        if isinstance(saved_state, dict) and saved_state.get("status") == "failed":
            return {
                "jobId": job_id,
                "status": "failed",
                "message": str(saved_state.get("message", "任务运行失败")),
                **workflow_reference_from_state(saved_state),
            }
        try:
            result = await completed_or_active_job_result(job_id)
        except HTTPException:
            raise
        except Exception as error:
            workflow_state = workflow_reference_from_state(saved_state)
            await job_state.put.aio(
                job_id,
                {"status": "failed", "message": str(error), **workflow_state},
            )
            return {
                "jobId": job_id,
                "status": "failed",
                "message": str(error),
                **workflow_state,
            }
        if result is None:
            workflow_state = workflow_reference_from_state(saved_state)
            return JSONResponse(
                {
                    "jobId": job_id,
                    "status": "processing",
                    "message": "ComfyUI 正在执行工作流",
                    **workflow_state,
                },
                status_code=202,
            )
        manifest = validated_job_result(result)
        outputs = [
            {
                "index": index,
                "filename": output.get("filename", f"output-{index}"),
                "mediaType": output.get("mediaType", "application/octet-stream"),
                "bytes": output.get("bytes", 0),
                "url": f"/jobs/{job_id}/results/{index}",
            }
            for index, output in enumerate(manifest["outputs"])
            if isinstance(output, dict)
        ]
        reference = {
            key: str(manifest[key])
            for key in (
                "workflowId",
                "workflowRevisionId",
                "workflowName",
                "workflowVariantId",
                "workflowVariantName",
            )
            if isinstance(manifest.get(key), str)
        }
        await job_state.put.aio(
            job_id,
            {"status": "succeeded", "artifactId": manifest["artifactId"], **reference},
        )
        return {
            "jobId": job_id,
            "status": "succeeded",
            "message": f"生成完成，共 {len(outputs)} 个输出",
            "outputs": outputs,
            **reference,
        }

    @web.delete("/jobs/{job_id}")
    async def cancel_job(job_id: str, request: Request):
        require_auth(request)
        saved_state = await job_state.get.aio(job_id, None)
        call = modal.functions.FunctionCall.from_id(job_id)
        try:
            await call.hydrate.aio()
            await call.cancel.aio()
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        workflow_state = workflow_reference_from_state(saved_state)
        await job_state.put.aio(job_id, {"status": "cancelled", **workflow_state})
        return {
            "jobId": job_id,
            "status": "cancelled",
            "message": "任务已取消",
            **workflow_state,
        }

    @web.get("/jobs/{job_id}/result")
    async def job_result(job_id: str, request: Request):
        require_auth(request)
        result = await completed_or_active_job_result(job_id)
        if result is None:
            return JSONResponse({"message": "任务仍在处理中"}, status_code=202)
        return await artifact_response(result, 0)

    @web.get("/jobs/{job_id}/results/{output_index}")
    async def job_output(job_id: str, output_index: int, request: Request):
        require_auth(request)
        result = await completed_or_active_job_result(job_id)
        if result is None:
            return JSONResponse({"message": "任务仍在处理中"}, status_code=202)
        return await artifact_response(result, output_index)

    return web


@app.local_entrypoint()
def main() -> None:
    print("Deploy with: modal deploy modal_app/comfy_app.py")

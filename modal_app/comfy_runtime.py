from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import uuid
from collections.abc import Iterable
from io import BytesIO
from pathlib import Path
from pathlib import PurePosixPath


def standard_prompt_id(artifact_id: str) -> str:
    return str(uuid.UUID(artifact_id))


def comfy_execution_error_message(messages: object) -> str:
    if isinstance(messages, list):
        for entry in reversed(messages):
            if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                continue
            detail = entry[1]
            if not isinstance(detail, dict):
                continue
            exception_message = detail.get("exception_message")
            if not isinstance(exception_message, str) or not exception_message.strip():
                continue
            if (
                "sageattention" in exception_message.casefold()
                and "cannot import name" in exception_message.casefold()
            ):
                return (
                    "SageAttention 加速模式与云端版本不兼容。"
                    "系统已关闭该加速，请重新运行工作流"
                )
            node_id = detail.get("node_id")
            node_type = detail.get("node_type")
            node_label = ""
            if isinstance(node_id, str) and isinstance(node_type, str):
                node_label = f"节点 {node_id}（{node_type}）："
            return f"{node_label}{exception_message.strip()}"[:1000]
    return "ComfyUI 节点执行失败，请检查工作流参数或节点环境"


def comfy_prompt_error_message(detail: str) -> str:
    try:
        payload = json.loads(detail)
    except json.JSONDecodeError:
        return "ComfyUI 拒绝了工作流，请检查节点参数和当前节点环境"
    if not isinstance(payload, dict):
        return "ComfyUI 拒绝了工作流，请检查节点参数和当前节点环境"
    messages: list[str] = []
    node_errors = payload.get("node_errors")
    if isinstance(node_errors, dict):
        for node_id, node_error in node_errors.items():
            if not isinstance(node_error, dict):
                continue
            class_type = node_error.get("class_type")
            errors = node_error.get("errors")
            if not isinstance(errors, list):
                continue
            for error in errors:
                if not isinstance(error, dict):
                    continue
                extra = error.get("extra_info")
                extra = extra if isinstance(extra, dict) else {}
                input_name = extra.get("input_name")
                received = extra.get("received_value")
                message = error.get("message")
                node_label = f"节点 {node_id}"
                if isinstance(class_type, str) and class_type:
                    node_label += f"（{class_type}）"
                if isinstance(input_name, str) and input_name:
                    parameter = f"参数 {input_name}"
                    if received is not None:
                        parameter += f" 的值 {received!r}"
                    messages.append(f"{node_label}的{parameter}不受当前云端支持")
                elif isinstance(message, str) and message:
                    messages.append(f"{node_label}：{message}")
                if len(messages) >= 5:
                    break
            if len(messages) >= 5:
                break
    if messages:
        return "ComfyUI 拒绝了工作流：" + "；".join(messages)
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message:
            return f"ComfyUI 拒绝了工作流：{message}"
    return "ComfyUI 拒绝了工作流，请检查节点参数和当前节点环境"


def validate_uploaded_image(data: bytes) -> None:
    from PIL import Image, UnidentifiedImageError

    if not data:
        raise ValueError("上传图像不能为空")
    try:
        with Image.open(BytesIO(data)) as image:
            image.verify()
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError, ValueError) as error:
        raise ValueError("上传文件不是有效图像") from error


def validate_python_runtime_package(
    python_root: Path,
    *,
    module: str,
    distribution: str,
    version: str,
    quiet: bool = False,
) -> None:
    if (
        not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", module)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", distribution)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+-]*", version)
    ):
        raise ValueError("运行扩展包信息不正确")
    environment = os.environ.copy()
    current_python_path = environment.get("PYTHONPATH", "")
    environment["PYTHONPATH"] = str(python_root) + (
        os.pathsep + current_python_path if current_python_path else ""
    )
    subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import importlib, importlib.metadata, sys; "
                "actual = importlib.metadata.version(sys.argv[1]); "
                "assert actual == sys.argv[2], (actual, sys.argv[2]); "
                "importlib.import_module(sys.argv[3])"
            ),
            distribution,
            version,
            module,
        ],
        check=True,
        env=environment,
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.DEVNULL if quiet else None,
        timeout=300,
    )


def python_runtime_package_available(
    python_root: Path,
    *,
    module: str,
    distribution: str,
    version: str,
) -> bool:
    try:
        validate_python_runtime_package(
            python_root,
            module=module,
            distribution=distribution,
            version=version,
            quiet=True,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
    return True


def discover_repository_file(
    requested_file: str,
    target_filename: str,
    repository_files: Iterable[str],
) -> str | None:
    requested_basename = PurePosixPath(requested_file.replace("\\", "/")).name
    target_basename = PurePosixPath(target_filename.replace("\\", "/")).name
    basenames = {requested_basename, target_basename} - {""}
    matches = sorted(
        {
            candidate
            for candidate in repository_files
            if isinstance(candidate, str)
            and candidate
            and not PurePosixPath(candidate).is_absolute()
            and ".." not in PurePosixPath(candidate).parts
            and PurePosixPath(candidate).name in basenames
        }
    )
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        preview = "、".join(matches[:5])
        raise ValueError(
            f"仓库中存在 {len(matches)} 个同名模型文件（{preview}），请填写完整仓库内路径"
        )
    return None


def huggingface_download_error_message(
    error_name: str,
    repo_id: str,
    repo_file: str,
    revision: str,
) -> str:
    if "EntryNotFound" in error_name:
        return f"Hugging Face 文件不存在：{repo_id}/{repo_file}（版本 {revision}）"
    if "RepositoryNotFound" in error_name:
        return f"Hugging Face 仓库不存在或无权访问：{repo_id}"
    if "RevisionNotFound" in error_name:
        return f"Hugging Face 版本不存在：{repo_id}@{revision}"
    return f"Hugging Face 模型下载失败：{repo_id}/{repo_file}"

from __future__ import annotations

import json
from io import BytesIO
from pathlib import PurePath
from typing import Any, Mapping

from modal_app.workflow_analysis import WorkflowFormatError, validate_api_workflow
from modal_app.workflow_conversion import is_canvas_workflow, validate_canvas_workflow


IMAGE_SUFFIXES = {".png", ".webp"}


def _json_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, bytes):
        try:
            if value.startswith(b"ASCII\x00\x00\x00"):
                value = value[8:].decode("utf-8")
            elif value.startswith(b"UNICODE\x00"):
                value = value[8:].decode("utf-16")
            elif value.startswith(b"JIS\x00\x00\x00\x00\x00"):
                value = value[8:].decode("shift_jis")
            else:
                value = value.decode("utf-8")
            value = value.strip("\x00")
        except UnicodeDecodeError as error:
            raise WorkflowFormatError("图片中的 ComfyUI prompt 元数据编码不正确") from error
    if not isinstance(value, str):
        raise WorkflowFormatError("图片中的 ComfyUI prompt 元数据格式不正确")
    try:
        return json.loads(value)
    except json.JSONDecodeError as error:
        raise WorkflowFormatError("图片中的 ComfyUI prompt 元数据不是有效 JSON") from error


def _embedded_prompt(data: bytes) -> Any:
    from PIL import Image

    try:
        with Image.open(BytesIO(data)) as image:
            prompt = image.info.get("prompt")
            text = getattr(image, "text", None)
            if prompt is None and isinstance(text, Mapping):
                prompt = text.get("prompt")

            if prompt is None:
                exif = image.getexif()
                for tag in (0x9286, 0x010E):
                    candidate = exif.get(tag)
                    if candidate:
                        prompt = candidate
                        break

            if prompt is None:
                canvas_workflow = image.info.get("workflow")
                if canvas_workflow is None and isinstance(text, Mapping):
                    canvas_workflow = text.get("workflow")
                if canvas_workflow is not None:
                    raise WorkflowFormatError(
                        "图片只包含 ComfyUI 画布 Workflow，没有可执行的 prompt 元数据"
                    )
                raise WorkflowFormatError("图片中没有找到 ComfyUI prompt 元数据")
    except WorkflowFormatError:
        raise
    except Exception as error:
        raise WorkflowFormatError("无法读取 PNG/WebP 工作流元数据") from error

    parsed = _json_value(prompt)
    if isinstance(parsed, Mapping) and isinstance(parsed.get("prompt"), Mapping):
        return parsed["prompt"]
    return parsed


def load_workflow_document(data: bytes, filename: str) -> dict[str, Any]:
    suffix = PurePath(filename).suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        return validate_api_workflow(_embedded_prompt(data))
    if suffix not in {"", ".json"}:
        raise WorkflowFormatError("仅支持 ComfyUI JSON 或带 prompt 的 PNG/WebP")
    try:
        raw = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkflowFormatError("工作流不是有效的 UTF-8 JSON") from error
    if is_canvas_workflow(raw):
        return validate_canvas_workflow(raw)
    return validate_api_workflow(raw)

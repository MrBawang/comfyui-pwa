from __future__ import annotations

import math
from pathlib import PurePosixPath
from typing import Any, Callable, Mapping, Optional


class WorkflowFormatError(ValueError):
    """Raised when a JSON document is not a runnable ComfyUI API workflow."""


MODEL_INPUTS = {
    "ckpt_name": "checkpoints",
    "control_net_name": "controlnet",
    "vae_name": "vae",
    "lora_name": "loras",
    "unet_name": "diffusion_models",
    "clip_name": "clip",
    "clip_name1": "clip",
    "clip_name2": "clip",
    "clip_name3": "clip",
    "style_model_name": "style_models",
    "gligen_name": "gligen",
    "upscale_model": "upscale_models",
}

IMAGE_NODE_TYPES = {"LoadImage", "LoadImageMask"}
OUTPUT_NODE_TYPES = {"SaveImage"}
PROMPT_INPUT_NAMES = {
    "prompt",
    "positive",
    "negative",
    "positive_prompt",
    "negative_prompt",
}
RUNTIME_OPTION_PACKAGES = {
    ("KSamplerSelect", "sampler_name", "res_2m"): {
        "kind": "registry",
        "registryId": "RES4LYF",
        "name": "RES4LYF",
        "repository": "https://github.com/ClownsharkBatwing/RES4LYF",
        "sourceRevision": "419de2d7c78f415dde9aa352a7231820ebfc17a4",
        "nodeTypes": ["ClownModelLoader"],
    }
}
RUNTIME_PYTHON_PACKAGES = {
    "sageattention": {
        "kind": "python",
        "packageId": "sageattention",
        "name": "SageAttention",
        "version": "1.0.6",
        "requirement": "sageattention==1.0.6",
        "module": "sageattention",
        "installPaths": ["sageattention", "sageattention-1.0.6.dist-info"],
        "nodeTypes": ["PathchSageAttentionKJ"],
    }
}
RUNTIME_INPUT_DEPENDENCIES = {
    ("PathchSageAttentionKJ", "sage_attention"): {
        "packageId": "sageattention",
        "disabledValues": {"disabled"},
    }
}
RUNTIME_PARAMETER_INPUTS = {
    "QwenMultiangleCameraNode": {
        "horizontal_angle": "水平角度",
        "vertical_angle": "垂直角度",
        "zoom": "缩放",
    }
}


def _declared_inputs(node_definition: Any) -> dict[str, Any]:
    if not isinstance(node_definition, Mapping):
        return {}
    input_definition = node_definition.get("input")
    if not isinstance(input_definition, Mapping):
        return {}
    declared = {}
    for section_name in ("required", "optional"):
        section = input_definition.get(section_name)
        if isinstance(section, Mapping):
            declared.update(section)
    return declared


def _upload_options(input_definition: Any) -> dict[str, Any] | None:
    if not isinstance(input_definition, (list, tuple)) or len(input_definition) < 2:
        return None
    options = input_definition[1]
    if not isinstance(options, Mapping) or options.get("image_upload") is not True:
        return None
    return dict(options)


def _string_options(input_definition: Any) -> dict[str, Any] | None:
    if not isinstance(input_definition, (list, tuple)) or not input_definition:
        return None
    if input_definition[0] != "STRING":
        return None
    if len(input_definition) >= 2 and isinstance(input_definition[1], Mapping):
        return dict(input_definition[1])
    return {}


def _runtime_parameter(
    node_id: str,
    class_type: str,
    input_name: str,
    input_definition: Any,
    current_value: Any,
) -> dict[str, Any] | None:
    label = RUNTIME_PARAMETER_INPUTS.get(class_type, {}).get(input_name)
    if label is None or not isinstance(input_definition, (list, tuple)) or not input_definition:
        return None
    declared_type = input_definition[0]
    options = (
        dict(input_definition[1])
        if len(input_definition) >= 2 and isinstance(input_definition[1], Mapping)
        else {}
    )
    if declared_type == "INT" and isinstance(current_value, int) and not isinstance(current_value, bool):
        kind = "integer"
    elif declared_type == "FLOAT" and isinstance(current_value, (int, float)) and not isinstance(current_value, bool):
        kind = "number"
    elif declared_type == "BOOLEAN" and isinstance(current_value, bool):
        kind = "boolean"
    else:
        return None
    result = {
        "nodeId": node_id,
        "classType": class_type,
        "inputName": input_name,
        "fieldName": f"control_{node_id}_{input_name}",
        "label": label,
        "kind": kind,
        "currentValue": current_value,
    }
    if kind in {"integer", "number"}:
        for source, target in (("min", "minimum"), ("max", "maximum"), ("step", "step")):
            value = options.get(source)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                result[target] = value
    return result


def validate_runtime_parameter_value(item: Mapping[str, Any], value: Any) -> Any:
    kind = item.get("kind")
    if kind == "integer":
        valid = isinstance(value, int) and not isinstance(value, bool)
    elif kind == "number":
        valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    elif kind == "boolean":
        valid = isinstance(value, bool)
    else:
        raise ValueError("运行参数类型不受支持")
    if not valid:
        raise ValueError(f"参数 {item.get('label', item.get('inputName', ''))} 格式不正确")
    if kind in {"integer", "number"}:
        minimum = item.get("minimum")
        maximum = item.get("maximum")
        if isinstance(minimum, (int, float)) and value < minimum:
            raise ValueError(f"参数 {item.get('label')} 不能小于 {minimum}")
        if isinstance(maximum, (int, float)) and value > maximum:
            raise ValueError(f"参数 {item.get('label')} 不能大于 {maximum}")
    return value


def coerce_runtime_parameter_value(item: Mapping[str, Any], raw_value: str) -> Any:
    kind = item.get("kind")
    try:
        if kind == "integer":
            value: Any = int(raw_value)
        elif kind == "number":
            value = float(raw_value)
        elif kind == "boolean" and raw_value in {"true", "false"}:
            value = raw_value == "true"
        else:
            raise ValueError
    except (TypeError, ValueError) as error:
        raise ValueError(f"参数 {item.get('label', item.get('inputName', ''))} 格式不正确") from error
    return validate_runtime_parameter_value(item, value)


def _enum_options(input_definition: Any) -> list[Any] | None:
    if not isinstance(input_definition, (list, tuple)) or not input_definition:
        return None
    declared_type = input_definition[0]
    if isinstance(declared_type, (list, tuple)):
        return list(declared_type)
    if (
        declared_type == "COMBO"
        and len(input_definition) >= 2
        and isinstance(input_definition[1], Mapping)
        and isinstance(input_definition[1].get("options"), (list, tuple))
    ):
        return list(input_definition[1]["options"])
    return None


def _is_workflow_link(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], str)
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
    )


def _unsupported_input_values(
    workflow: Mapping[str, Mapping[str, Any]], node_info: Mapping[str, Any]
) -> list[dict[str, Any]]:
    unsupported = []
    for node_id, node in workflow.items():
        class_type = node["class_type"]
        declared_inputs = _declared_inputs(node_info.get(class_type))
        for input_name, value in node["inputs"].items():
            if _is_workflow_link(value):
                continue
            input_definition = declared_inputs.get(input_name)
            if input_name in MODEL_INPUTS or _upload_options(input_definition) is not None:
                continue
            options = _enum_options(input_definition)
            if options is None or value in options:
                continue
            unsupported.append(
                {
                    "nodeId": node_id,
                    "classType": class_type,
                    "inputName": input_name,
                    "value": value,
                    "availableValues": options[:100],
                    "availableValueCount": len(options),
                }
            )
    return unsupported


def _runtime_packages_for_unsupported_inputs(
    unsupported_inputs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    packages: dict[str, dict[str, Any]] = {}
    for item in unsupported_inputs:
        package = RUNTIME_OPTION_PACKAGES.get(
            (item.get("classType"), item.get("inputName"), item.get("value"))
        )
        if package is not None:
            packages[str(package["registryId"])] = dict(package)
    return list(packages.values())


def _missing_runtime_python_packages(
    workflow: Mapping[str, Mapping[str, Any]],
    runtime_dependency_exists: Callable[[str], bool] | None,
) -> tuple[list[dict[str, Any]], list[str]]:
    if runtime_dependency_exists is None:
        return [], []
    packages: dict[str, dict[str, Any]] = {}
    issues: list[str] = []
    for node_id, node in workflow.items():
        class_type = node["class_type"]
        for input_name, value in node["inputs"].items():
            dependency = RUNTIME_INPUT_DEPENDENCIES.get((class_type, input_name))
            if dependency is None:
                continue
            if isinstance(value, str) and value in dependency["disabledValues"]:
                continue
            package_id = str(dependency["packageId"])
            package = RUNTIME_PYTHON_PACKAGES[package_id]
            if runtime_dependency_exists(str(package["module"])):
                continue
            packages[package_id] = {
                key: package_value
                for key, package_value in package.items()
                if key not in {"module", "requirement", "installPaths"}
            }
            issues.append(
                f"节点 {node_id}（{class_type}）启用了 {package['name']}，"
                "但云端缺少对应运行扩展"
            )
    return list(packages.values()), issues


def _conditioning_role(
    workflow: Mapping[str, Mapping[str, Any]], source_node_id: str
) -> str | None:
    queue = [source_node_id]
    visited: set[str] = set()
    roles: set[str] = set()
    while queue and len(visited) <= len(workflow):
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        for destination_id, node in workflow.items():
            for input_name, value in node.get("inputs", {}).items():
                if not _is_workflow_link(value) or value[0] != current:
                    continue
                normalized_input = input_name.casefold()
                if normalized_input in {"positive", "negative"}:
                    roles.add(normalized_input)
                elif destination_id not in visited:
                    queue.append(destination_id)
    return next(iter(roles)) if len(roles) == 1 else None


def _prompt_label(class_type: str, input_name: str, conditioning_role: str | None = None) -> str | None:
    normalized_input = input_name.casefold()
    normalized_class = class_type.casefold()
    if normalized_input in PROMPT_INPUT_NAMES:
        return "负面提示词" if "negative" in normalized_input or conditioning_role == "negative" else "提示词"
    if normalized_input == "text" or normalized_input.startswith("text_"):
        if not any(token in normalized_class for token in ("clip", "prompt", "textencode")):
            return None
        suffix = "" if normalized_input == "text" else normalized_input.removeprefix("text_")
        return "提示词" if not suffix else f"提示词 {suffix.upper()}"
    return None


def validate_api_workflow(raw: Any) -> dict[str, dict[str, Any]]:
    if isinstance(raw, Mapping) and isinstance(raw.get("nodes"), list):
        raise WorkflowFormatError(
            "检测到普通 ComfyUI Canvas Workflow；需要先经过云端转换"
        )
    if not isinstance(raw, Mapping) or not raw:
        raise WorkflowFormatError("工作流必须是非空 JSON 对象")

    workflow: dict[str, dict[str, Any]] = {}
    for raw_node_id, raw_node in raw.items():
        node_id = str(raw_node_id)
        if not isinstance(raw_node, Mapping):
            raise WorkflowFormatError(f"节点 {node_id} 不是有效对象")
        class_type = raw_node.get("class_type")
        inputs = raw_node.get("inputs")
        if not isinstance(class_type, str) or not class_type:
            raise WorkflowFormatError(f"节点 {node_id} 缺少 class_type")
        if not isinstance(inputs, Mapping):
            raise WorkflowFormatError(f"节点 {node_id} 缺少 inputs")
        workflow[node_id] = {"class_type": class_type, "inputs": dict(inputs)}
    return workflow


def safe_model_reference(filename: str) -> bool:
    path = PurePosixPath(filename.replace("\\", "/"))
    return bool(filename) and not path.is_absolute() and ".." not in path.parts


def _workflow_structure_issues(
    workflow: Mapping[str, Mapping[str, Any]], node_info: Mapping[str, Any]
) -> list[str]:
    issues: list[str] = []
    for node_id, node in workflow.items():
        class_type = node["class_type"]
        inputs = node["inputs"]
        definition = node_info.get(class_type)
        if not isinstance(definition, Mapping):
            continue
        input_definition = definition.get("input")
        required = (
            input_definition.get("required")
            if isinstance(input_definition, Mapping)
            else None
        )
        if isinstance(required, Mapping):
            missing_inputs = sorted(set(required) - set(inputs))
            if missing_inputs:
                issues.append(
                    f"节点 {node_id}（{class_type}）缺少必填输入："
                    + "、".join(missing_inputs)
                )

        for input_name, value in inputs.items():
            if not _is_workflow_link(value):
                continue
            source_id, output_index = value
            source = workflow.get(source_id)
            if source is None:
                issues.append(
                    f"节点 {node_id} 的输入 {input_name} 引用了不存在的节点 {source_id}"
                )
                continue
            source_definition = node_info.get(source["class_type"])
            source_outputs = (
                source_definition.get("output")
                if isinstance(source_definition, Mapping)
                else None
            )
            if (
                isinstance(source_outputs, (list, tuple))
                and (output_index < 0 or output_index >= len(source_outputs))
            ):
                issues.append(
                    f"节点 {node_id} 的输入 {input_name} 引用了无效输出 "
                    f"{source_id}:{output_index}"
                )
    return issues


def analyze_workflow(
    raw: Any,
    *,
    installed_nodes: Optional[set[str]] = None,
    model_exists: Optional[Callable[[str, str], bool]] = None,
    node_info: Optional[Mapping[str, Any]] = None,
    runtime_dependency_exists: Optional[Callable[[str], bool]] = None,
) -> dict[str, Any]:
    workflow = validate_api_workflow(raw)
    node_types = sorted({node["class_type"] for node in workflow.values()})

    missing_nodes = []
    if installed_nodes is not None:
        missing_nodes = sorted(node_type for node_type in node_types if node_type not in installed_nodes)

    model_refs: dict[tuple[str, str], dict[str, Any]] = {}
    image_inputs = []
    text_inputs = []
    parameter_inputs = []
    output_nodes = []

    for node_id, node in workflow.items():
        class_type = node["class_type"]
        inputs = node["inputs"]

        declared_inputs = _declared_inputs(node_info.get(class_type)) if node_info else {}
        upload_fields = []
        if declared_inputs:
            upload_fields = [
                (input_name, options)
                for input_name, definition in declared_inputs.items()
                if (options := _upload_options(definition)) is not None
            ]
        elif class_type in IMAGE_NODE_TYPES:
            upload_fields = [("image", {})]

        for input_name, options in upload_fields:
            current_filename = inputs.get(input_name)
            if not isinstance(current_filename, str):
                continue
            folder = str(options.get("image_folder", "input"))
            if folder not in {"input", "output", "temp"}:
                folder = "input"
            image_inputs.append(
                {
                    "nodeId": node_id,
                    "classType": class_type,
                    "inputName": input_name,
                    "currentFilename": current_filename,
                    "fieldName": f"asset_{node_id}_{input_name}",
                    "folder": folder,
                }
            )

        for input_name, input_definition in declared_inputs.items():
            current_value = inputs.get(input_name)
            options = _string_options(input_definition)
            if (
                options is None
                or not isinstance(current_value, str)
                or _prompt_label(class_type, input_name) is None
            ):
                continue
            label = _prompt_label(
                class_type,
                input_name,
                _conditioning_role(workflow, node_id),
            )
            text_inputs.append(
                {
                    "nodeId": node_id,
                    "classType": class_type,
                    "inputName": input_name,
                    "fieldName": f"param_{node_id}_{input_name}",
                    "label": label,
                    "currentValue": current_value,
                    "multiline": bool(options.get("multiline", len(current_value) > 80)),
                }
            )

        for input_name, input_definition in declared_inputs.items():
            parameter = _runtime_parameter(
                node_id,
                class_type,
                input_name,
                input_definition,
                inputs.get(input_name),
            )
            if parameter is not None:
                parameter_inputs.append(parameter)

        definition = node_info.get(class_type) if node_info else None
        if (
            isinstance(definition, Mapping)
            and definition.get("output_node") is True
        ) or (node_info is None and class_type in OUTPUT_NODE_TYPES):
            output_nodes.append(node_id)

        for input_name, category in MODEL_INPUTS.items():
            filename = inputs.get(input_name)
            if not isinstance(filename, str):
                continue
            if not safe_model_reference(filename):
                raise WorkflowFormatError(
                    f"节点 {node_id} 的模型路径不安全：{filename}"
                )
            key = (category, filename)
            if key not in model_refs:
                status = "unknown"
                if model_exists is not None:
                    status = "present" if model_exists(category, filename) else "missing"
                model_refs[key] = {
                    "category": category,
                    "filename": filename,
                    "status": status,
                    "nodes": [],
                }
            model_refs[key]["nodes"].append({"nodeId": node_id, "input": input_name})

    issues = _workflow_structure_issues(workflow, node_info) if node_info else []
    unsupported_inputs = (
        _unsupported_input_values(workflow, node_info) if node_info else []
    )
    missing_runtime_packages, runtime_dependency_issues = (
        _missing_runtime_python_packages(workflow, runtime_dependency_exists)
    )
    for item in unsupported_inputs:
        issues.append(
            f"节点 {item['nodeId']}（{item['classType']}）的 {item['inputName']} 值"
            f"“{item['value']}”不受当前云端支持"
        )
    issues.extend(runtime_dependency_issues)
    if missing_nodes:
        issues.append(f"缺少 {len(missing_nodes)} 个自定义节点类型")
    missing_models = [item for item in model_refs.values() if item["status"] == "missing"]
    if missing_models:
        issues.append(f"缺少 {len(missing_models)} 个模型文件")
    if not output_nodes:
        issues.append("工作流没有可执行的文件输出节点")

    return {
        "format": "comfyui-api",
        "nodeCount": len(workflow),
        "nodeTypes": node_types,
        "missingNodes": missing_nodes,
        "models": sorted(model_refs.values(), key=lambda item: (item["category"], item["filename"])),
        "imageInputs": sorted(image_inputs, key=lambda item: item["nodeId"]),
        "textInputs": sorted(text_inputs, key=lambda item: (item["nodeId"], item["inputName"])),
        "parameterInputs": sorted(parameter_inputs, key=lambda item: item["nodeId"]),
        "outputNodes": sorted(output_nodes),
        "unsupportedInputs": unsupported_inputs,
        "missingRuntimePackages": [
            *_runtime_packages_for_unsupported_inputs(unsupported_inputs),
            *missing_runtime_packages,
        ],
        "issues": issues,
        "runnable": not issues,
        "workflow": workflow,
    }


def merge_workflow_resource_findings(
    target: dict[str, Any], source: Mapping[str, Any]
) -> None:
    for key in ("missingNodes", "unresolvedNodes"):
        target[key] = sorted(
            {
                str(value)
                for collection in (target.get(key, []), source.get(key, []))
                if isinstance(collection, list)
                for value in collection
                if isinstance(value, str) and value
            }
        )

    target_models = target.setdefault("models", [])
    if isinstance(target_models, list):
        model_index = {
            (item.get("category"), item.get("filename")): item
            for item in target_models
            if isinstance(item, dict)
            and isinstance(item.get("category"), str)
            and isinstance(item.get("filename"), str)
        }
        source_models = source.get("models")
        if isinstance(source_models, list):
            for raw_model in source_models:
                if not isinstance(raw_model, Mapping):
                    continue
                key = (raw_model.get("category"), raw_model.get("filename"))
                if not all(isinstance(value, str) for value in key):
                    continue
                existing = model_index.get(key)
                if existing is None:
                    existing = dict(raw_model)
                    target_models.append(existing)
                    model_index[key] = existing
                else:
                    if raw_model.get("status") == "missing":
                        existing["status"] = "missing"
                    if not isinstance(existing.get("source"), Mapping) and isinstance(
                        raw_model.get("source"), Mapping
                    ):
                        existing["source"] = dict(raw_model["source"])
                    existing_nodes = existing.setdefault("nodes", [])
                    raw_nodes = raw_model.get("nodes")
                    if isinstance(existing_nodes, list) and isinstance(raw_nodes, list):
                        for node in raw_nodes:
                            if isinstance(node, Mapping) and dict(node) not in existing_nodes:
                                existing_nodes.append(dict(node))
        target_models.sort(
            key=lambda item: (
                str(item.get("category", "")) if isinstance(item, Mapping) else "",
                str(item.get("filename", "")) if isinstance(item, Mapping) else "",
            )
        )

    for collection_key in (
        "missingNodePackages",
        "suggestedNodePackages",
        "missingRuntimePackages",
    ):
        target_items = target.get(collection_key)
        source_items = source.get(collection_key)
        if not isinstance(source_items, list):
            continue
        if not isinstance(target_items, list):
            target_items = []
            target[collection_key] = target_items
        item_index = {
            (
                item.get("kind"),
                item.get("registryId") or item.get("name"),
                item.get("repository"),
            ): item
            for item in target_items
            if isinstance(item, dict)
        }
        for raw_item in source_items:
            if not isinstance(raw_item, Mapping):
                continue
            identity = (
                raw_item.get("kind"),
                raw_item.get("registryId") or raw_item.get("name"),
                raw_item.get("repository"),
            )
            existing = item_index.get(identity)
            if existing is None:
                existing = dict(raw_item)
                target_items.append(existing)
                item_index[identity] = existing
                continue
            existing_nodes = existing.setdefault("nodeTypes", [])
            raw_nodes = raw_item.get("nodeTypes")
            if isinstance(existing_nodes, list) and isinstance(raw_nodes, list):
                existing["nodeTypes"] = sorted(
                    {
                        str(node_type)
                        for node_type in (*existing_nodes, *raw_nodes)
                        if isinstance(node_type, str) and node_type
                    }
                )

    if source.get("nodePackageLookupStatus") == "failed":
        target["nodePackageLookupStatus"] = "failed"
        if isinstance(source.get("nodePackageLookupMessage"), str):
            target["nodePackageLookupMessage"] = source["nodePackageLookupMessage"]
    elif "nodePackageLookupStatus" not in target and isinstance(
        source.get("nodePackageLookupStatus"), str
    ):
        target["nodePackageLookupStatus"] = source["nodePackageLookupStatus"]

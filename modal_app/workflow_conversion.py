from __future__ import annotations

import copy
import hashlib
import re
import urllib.parse
from pathlib import PurePosixPath
from typing import Any, Mapping

from modal_app.workflow_analysis import (
    RUNTIME_PYTHON_PACKAGES,
    WorkflowFormatError,
    safe_model_reference,
    validate_api_workflow,
)


UI_ONLY_NODE_TYPES = {
    "GetNode",
    "LoadImageOutput",
    "MarkdownNote",
    "Note",
    "PrimitiveNode",
    "Reroute",
    "SetNode",
}
EXTRA_UI_ONLY_NODE_TYPES = {
    "Bookmark (rgthree)",
    "Fast Actions Button (rgthree)",
    "Fast Bypasser (rgthree)",
    "Fast Groups Bypasser (rgthree)",
    "Fast Groups Muter (rgthree)",
    "Fast Muter (rgthree)",
    "Label (rgthree)",
    "Mute / Bypass Relay (rgthree)",
    "Mute / Bypass Repeater (rgthree)",
    "Node Collector (rgthree)",
    "Random Unmuter (rgthree)",
}
EXTRA_PASSTHROUGH_NODE_TYPES = {"Reroute (rgthree)": "Reroute"}
UI_ONLY_NODE_TYPES.update(EXTRA_UI_ONLY_NODE_TYPES)
UI_ONLY_NODE_TYPES.update(EXTRA_PASSTHROUGH_NODE_TYPES)
INACTIVE_NODE_MODES = {2, 4}
PACKAGE_HINT_KEYS = ("cnr_id", "aux_id")
OPTIONAL_IMAGE_NODE_TYPES = {"LoadImage", "LoadImageMask"}
MAX_OPTIONAL_IMAGE_VARIANTS = 8


def _version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", value))


def _apply_runtime_compatibility(
    workflow: dict[str, dict[str, Any]],
    adjustments: list[dict[str, str]] | None = None,
) -> dict[str, dict[str, Any]]:
    sageattention = RUNTIME_PYTHON_PACKAGES.get("sageattention", {})
    version = str(sageattention.get("version", "0"))
    if _version_tuple(version) >= (2, 2, 0):
        return workflow
    for node_id, node in workflow.items():
        if node.get("class_type") != "PathchSageAttentionKJ":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        mode = inputs.get("sage_attention")
        if isinstance(mode, str) and mode != "disabled":
            inputs["sage_attention"] = "disabled"
        if inputs.get("allow_compile") is True:
            inputs["allow_compile"] = False
        if adjustments is not None:
            adjustment = {
                "code": "sageattention-disabled",
                "nodeId": node_id,
                "classType": "PathchSageAttentionKJ",
                "message": (
                    f"节点 {node_id} 的 SageAttention 加速保持关闭："
                    f"云端当前安装 {version}，已验证该节点加速会导致报错或无效输出"
                ),
            }
            if adjustment not in adjustments:
                adjustments.append(adjustment)
    return workflow


def _optional_image_variant_id(node_id: str) -> str:
    candidate = f"optional-image-{node_id}".casefold()
    if re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", candidate):
        return candidate
    digest = hashlib.sha256(node_id.encode("utf-8")).hexdigest()[:16]
    return f"optional-image-{digest}"


def is_canvas_workflow(raw: Any) -> bool:
    return isinstance(raw, Mapping) and isinstance(raw.get("nodes"), list)


def validate_canvas_workflow(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise WorkflowFormatError("Canvas 工作流必须是 JSON 对象")
    nodes = raw.get("nodes")
    links = raw.get("links")
    if not isinstance(nodes, list) or not nodes:
        raise WorkflowFormatError("Canvas 工作流必须包含非空 nodes 列表")
    if not isinstance(links, list):
        raise WorkflowFormatError("Canvas 工作流缺少 links 列表")

    node_ids: set[str] = set()
    for index, node in enumerate(nodes):
        if not isinstance(node, Mapping):
            raise WorkflowFormatError(f"Canvas 节点 {index + 1} 不是有效对象")
        node_id = node.get("id")
        node_type = node.get("type")
        if not isinstance(node_id, (str, int)) or isinstance(node_id, bool):
            raise WorkflowFormatError(f"Canvas 节点 {index + 1} 缺少有效 id")
        if not isinstance(node_type, str) or not node_type:
            raise WorkflowFormatError(f"Canvas 节点 {node_id} 缺少 type")
        node_id_string = str(node_id)
        if node_id_string in node_ids:
            raise WorkflowFormatError(f"Canvas 节点 id 重复：{node_id_string}")
        node_ids.add(node_id_string)
    return dict(raw)


def _subgraph_definitions(raw: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    definitions = raw.get("definitions")
    if not isinstance(definitions, Mapping):
        return []
    subgraphs = definitions.get("subgraphs")
    if not isinstance(subgraphs, list):
        return []
    return [item for item in subgraphs if isinstance(item, Mapping)]


def _node_type(node: Mapping[str, Any]) -> str:
    properties = node.get("properties")
    if isinstance(properties, Mapping):
        search_name = properties.get("Node name for S&R")
        if isinstance(search_name, str) and search_name:
            return search_name
    node_type = node.get("type")
    return node_type if isinstance(node_type, str) else ""


def _active_nodes(raw: Mapping[str, Any], *, include_subgraphs: bool) -> list[Mapping[str, Any]]:
    subgraphs = _subgraph_definitions(raw)
    subgraph_ids = {
        item["id"] for item in subgraphs if isinstance(item.get("id"), str)
    }
    nodes = raw.get("nodes")
    result = []
    if isinstance(nodes, list):
        for node in nodes:
            if not isinstance(node, Mapping) or node.get("mode", 0) in INACTIVE_NODE_MODES:
                continue
            raw_type = node.get("type")
            node_type = _node_type(node)
            if (
                not node_type
                or raw_type in subgraph_ids
                or raw_type in UI_ONLY_NODE_TYPES
                or node_type in UI_ONLY_NODE_TYPES
            ):
                continue
            result.append(node)
    if include_subgraphs:
        for subgraph in subgraphs:
            result.extend(_active_nodes(subgraph, include_subgraphs=True))
    return result


def canvas_node_types(raw: Mapping[str, Any]) -> list[str]:
    return sorted({_node_type(node) for node in _active_nodes(raw, include_subgraphs=True)})


def canvas_node_count(raw: Mapping[str, Any]) -> int:
    return len(_active_nodes(raw, include_subgraphs=True))


def _canvas_group_title(raw: Mapping[str, Any], node: Mapping[str, Any]) -> tuple[str, str]:
    position = node.get("pos")
    size = node.get("size")
    if not (
        isinstance(position, (list, tuple))
        and len(position) >= 2
        and all(isinstance(value, (int, float)) for value in position[:2])
    ):
        return "双图", "额外图像输入"
    width = size[0] if isinstance(size, (list, tuple)) and size and isinstance(size[0], (int, float)) else 0
    node_x = float(position[0]) + float(width) / 2
    node_y = float(position[1])
    contextual: list[tuple[float, str]] = []
    containing: list[tuple[float, str]] = []
    groups = raw.get("groups")
    if isinstance(groups, list):
        for group in groups:
            if not isinstance(group, Mapping):
                continue
            title = group.get("title")
            bounding = group.get("bounding")
            if not (
                isinstance(title, str)
                and isinstance(bounding, (list, tuple))
                and len(bounding) >= 4
                and all(isinstance(value, (int, float)) for value in bounding[:4])
            ):
                continue
            x, y, group_width, group_height = map(float, bounding[:4])
            area = group_width * group_height
            if x <= node_x <= x + group_width and y <= node_y <= y + group_height:
                containing.append((area, title))
            gap = node_y - (y + group_height)
            if (
                x <= node_x <= x + group_width
                and 0 <= gap <= 320
                and ("双图" in title or "可选" in title)
            ):
                contextual.append((gap, title))

    source_title = min(contextual, default=(0, "双图"))[1]
    detail_title = min(containing, default=(0, "额外图像输入"))[1]

    def clean(value: str) -> str:
        value = re.sub(r"^[\s▶▷▼△①②③④⑤⑥⑦⑧⑨⑩]+", "", value)
        value = re.sub(r"[\s▶▷▼△]+$", "", value)
        return value.strip()[:80]

    name = clean(source_title).replace("可选", "").strip() or "双图"
    return name, clean(detail_title) or "额外图像输入"


def canvas_optional_image_variants(raw: Mapping[str, Any]) -> list[dict[str, Any]]:
    nodes = raw.get("nodes")
    links = raw.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list):
        return []
    node_map = {
        str(node["id"]): node
        for node in nodes
        if isinstance(node, Mapping) and isinstance(node.get("id"), (str, int))
    }
    outgoing: dict[str, set[str]] = {}
    for link in links:
        if not isinstance(link, (list, tuple)) or len(link) < 4:
            continue
        outgoing.setdefault(str(link[1]), set()).add(str(link[3]))

    def meaningful_active(node: Mapping[str, Any]) -> bool:
        node_type = _node_type(node)
        return (
            node.get("mode", 0) not in INACTIVE_NODE_MODES
            and node_type not in UI_ONLY_NODE_TYPES
            and bool(node_type)
        )

    def enabled_path(start_id: str) -> set[str]:
        visiting: set[str] = set()

        def visit(node_id: str, *, start: bool = False) -> tuple[bool, set[str]]:
            if node_id in visiting:
                return False, set()
            node = node_map.get(node_id)
            if node is None:
                return False, set()
            if not start and meaningful_active(node):
                return True, set()
            mode = node.get("mode", 0)
            node_type = _node_type(node)
            if not start and mode != 4 and node_type not in UI_ONLY_NODE_TYPES:
                return False, set()
            visiting.add(node_id)
            found = False
            collected: set[str] = set()
            for destination_id in outgoing.get(node_id, set()):
                reaches_active, branch = visit(destination_id)
                if reaches_active:
                    found = True
                    collected.update(branch)
            visiting.remove(node_id)
            if found and mode == 4:
                collected.add(node_id)
            return found, collected

        reaches_graph, nodes_to_enable = visit(start_id, start=True)
        return nodes_to_enable if reaches_graph else set()

    variants = []
    seen_paths: set[frozenset[str]] = set()
    for node_id, node in node_map.items():
        if len(variants) >= MAX_OPTIONAL_IMAGE_VARIANTS:
            break
        if node.get("mode", 0) != 4 or _node_type(node) not in OPTIONAL_IMAGE_NODE_TYPES:
            continue
        nodes_to_enable = enabled_path(node_id)
        path_key = frozenset(nodes_to_enable)
        if not nodes_to_enable or path_key in seen_paths:
            continue
        seen_paths.add(path_key)
        canvas = copy.deepcopy(dict(raw))
        for candidate in canvas.get("nodes", []):
            if isinstance(candidate, dict) and str(candidate.get("id")) in nodes_to_enable:
                candidate["mode"] = 0
        name, description = _canvas_group_title(raw, node)
        variants.append(
            {
                "id": _optional_image_variant_id(node_id),
                "name": name,
                "description": description,
                "canvas": canvas,
            }
        )
    return variants


def missing_canvas_nodes(raw: Mapping[str, Any], installed_nodes: set[str]) -> list[str]:
    return sorted(set(canvas_node_types(raw)) - installed_nodes)


def canvas_node_package_hints(
    raw: Mapping[str, Any], node_types: list[str]
) -> dict[str, list[str]]:
    requested = {node_type.casefold() for node_type in node_types}
    hints: dict[str, set[str]] = {}
    for node in _active_nodes(raw, include_subgraphs=True):
        node_type = _node_type(node)
        if node_type.casefold() not in requested:
            continue
        properties = node.get("properties")
        if not isinstance(properties, Mapping):
            continue
        package_ids = {
            value.strip()
            for key in PACKAGE_HINT_KEYS
            if isinstance((value := properties.get(key)), str) and value.strip()
        }
        package_ids = {package_id for package_id in package_ids if len(package_id) <= 160}
        if not package_ids:
            continue
        version = properties.get("ver")
        for package_id in package_ids:
            reference = package_id
            if (
                "@" not in reference
                and isinstance(version, str)
                and version.strip()
                and len(version.strip()) <= 80
            ):
                reference = f"{reference}@{version.strip()}"
            hints.setdefault(node_type, set()).add(reference)
    return {node_type: sorted(values) for node_type, values in hints.items()}


def _hugging_face_model_source(url: Any) -> dict[str, str] | None:
    if not isinstance(url, str) or len(url) > 2_000:
        return None
    try:
        parsed = urllib.parse.urlsplit(url)
        segments = [urllib.parse.unquote(item) for item in parsed.path.split("/") if item]
    except ValueError:
        return None
    if (
        parsed.scheme != "https"
        or parsed.netloc.casefold() != "huggingface.co"
        or len(segments) < 5
        or segments[2] != "resolve"
    ):
        return None
    owner, repository, _, revision, *file_parts = segments
    repo_id = f"{owner}/{repository}"
    repo_file = "/".join(file_parts)
    if (
        not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo_id)
        or not revision
        or len(revision) > 200
        or not re.fullmatch(r"[A-Za-z0-9_./-]+", revision)
        or ".." in revision.split("/")
        or not safe_model_reference(repo_file)
    ):
        return None
    return {
        "kind": "huggingface",
        "repoId": repo_id,
        "repoFile": repo_file,
        "revision": revision,
        "origin": "workflow-metadata",
    }


def apply_canvas_model_sources(
    models: list[dict[str, Any]], raw: Mapping[str, Any]
) -> None:
    exact: dict[str, set[tuple[str, str, str]]] = {}
    by_basename: dict[str, set[tuple[str, str, str]]] = {}
    for node in _active_nodes(raw, include_subgraphs=True):
        properties = node.get("properties")
        metadata = properties.get("models") if isinstance(properties, Mapping) else None
        if not isinstance(metadata, list):
            continue
        for item in metadata:
            if not isinstance(item, Mapping):
                continue
            name = item.get("name")
            source = _hugging_face_model_source(item.get("url"))
            if not isinstance(name, str) or not name.strip() or source is None:
                continue
            normalized_name = name.replace("\\", "/").strip()
            if PurePosixPath(source["repoFile"]).name != PurePosixPath(
                normalized_name
            ).name:
                continue
            source_key = (source["repoId"], source["repoFile"], source["revision"])
            exact.setdefault(normalized_name, set()).add(source_key)
            by_basename.setdefault(PurePosixPath(normalized_name).name, set()).add(source_key)

    for model in models:
        filename = model.get("filename")
        if not isinstance(filename, str):
            continue
        normalized_filename = filename.replace("\\", "/")
        candidates = exact.get(normalized_filename)
        if not candidates:
            candidates = by_basename.get(PurePosixPath(normalized_filename).name)
        if not candidates or len(candidates) != 1:
            continue
        repo_id, repo_file, revision = next(iter(candidates))
        model["source"] = {
            "kind": "huggingface",
            "repoId": repo_id,
            "repoFile": repo_file,
            "revision": revision,
            "origin": "workflow-metadata",
        }


def _prepare_canvas_for_conversion(raw: Mapping[str, Any]) -> dict[str, Any]:
    prepared = copy.deepcopy(dict(raw))

    def name_widget_values(node: dict[str, Any]) -> None:
        values = node.get("widgets_values")
        inputs = node.get("inputs")
        if (
            not isinstance(values, list)
            or not isinstance(inputs, list)
            or any(isinstance(value, dict) for value in values)
        ):
            return
        names = []
        for item in inputs:
            if not isinstance(item, Mapping):
                continue
            widget = item.get("widget")
            name = widget.get("name") if isinstance(widget, Mapping) else None
            if isinstance(name, str) and name:
                names.append(name)
        if len(names) == len(values) and len(set(names)) == len(names):
            node["widgets_values"] = dict(zip(names, values))

    def prepare_document(document: dict[str, Any]) -> None:
        nodes = document.get("nodes")
        if isinstance(nodes, list):
            prepared_nodes = []
            for node in nodes:
                if not isinstance(node, Mapping):
                    prepared_nodes.append(node)
                    continue
                raw_type = node.get("type")
                node_type = _node_type(node)
                if (
                    raw_type in EXTRA_UI_ONLY_NODE_TYPES
                    or node_type in EXTRA_UI_ONLY_NODE_TYPES
                ):
                    continue
                replacement = EXTRA_PASSTHROUGH_NODE_TYPES.get(
                    raw_type
                ) or EXTRA_PASSTHROUGH_NODE_TYPES.get(node_type)
                if replacement:
                    node = dict(node)
                    node["type"] = replacement
                if isinstance(node, dict):
                    name_widget_values(node)
                prepared_nodes.append(node)
            document["nodes"] = prepared_nodes
        definitions = document.get("definitions")
        subgraphs = definitions.get("subgraphs") if isinstance(definitions, dict) else None
        if isinstance(subgraphs, list):
            for subgraph in subgraphs:
                if isinstance(subgraph, dict):
                    prepare_document(subgraph)

    prepare_document(prepared)
    return prepared


def _validate_converted_workflow(
    workflow: Mapping[str, Mapping[str, Any]],
    object_info: Mapping[str, Any],
) -> None:
    for node_id, node in workflow.items():
        class_type = node["class_type"]
        inputs = node["inputs"]
        definition = object_info.get(class_type)
        if isinstance(definition, Mapping):
            declared_inputs = definition.get("input")
            required = (
                declared_inputs.get("required")
                if isinstance(declared_inputs, Mapping)
                else None
            )
            if isinstance(required, Mapping):
                missing_inputs = sorted(set(required) - set(inputs))
                if missing_inputs:
                    raise WorkflowFormatError(
                        f"Canvas 节点 {node_id} 转换后缺少必填输入："
                        + "、".join(missing_inputs)
                    )

        for input_name, value in inputs.items():
            if (
                isinstance(value, list)
                and len(value) == 2
                and isinstance(value[0], str)
                and isinstance(value[1], int)
                and value[0] not in workflow
            ):
                raise WorkflowFormatError(
                    f"Canvas 节点 {node_id} 的输入 {input_name} 引用了未转换节点 {value[0]}"
                )


def convert_workflow_document(
    raw: Any,
    object_info: Mapping[str, Any],
    compatibility_adjustments: list[dict[str, str]] | None = None,
) -> tuple[dict[str, dict[str, Any]], bool]:
    if not is_canvas_workflow(raw):
        return _apply_runtime_compatibility(
            validate_api_workflow(raw), compatibility_adjustments
        ), False

    canvas = validate_canvas_workflow(raw)
    missing_nodes = missing_canvas_nodes(canvas, set(object_info))
    if missing_nodes:
        raise WorkflowFormatError("Canvas 工作流缺少节点类型：" + "、".join(missing_nodes))

    try:
        from comfy_cli.workflow_to_api import WorkflowConversionError, convert_ui_to_api
    except ImportError as error:
        raise WorkflowFormatError("云端缺少 Canvas 工作流转换器") from error

    try:
        converted = convert_ui_to_api(
            _prepare_canvas_for_conversion(canvas), dict(object_info)
        )
    except WorkflowConversionError as error:
        raise WorkflowFormatError(f"Canvas 工作流转换失败：{error}") from error
    except Exception as error:
        raise WorkflowFormatError("Canvas 工作流转换失败") from error

    workflow = _apply_runtime_compatibility(
        validate_api_workflow(converted), compatibility_adjustments
    )
    expected_root_ids = {
        str(node["id"]) for node in _active_nodes(canvas, include_subgraphs=False)
    }
    skipped_ids = sorted(expected_root_ids - set(workflow))
    if skipped_ids:
        raise WorkflowFormatError(
            "Canvas 工作流有节点未能转换：" + "、".join(skipped_ids)
        )
    _validate_converted_workflow(workflow, object_info)
    return workflow, True

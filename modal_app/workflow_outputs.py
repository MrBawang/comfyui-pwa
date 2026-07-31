from __future__ import annotations

from typing import Any


FINAL_UPSCALE_NODE_TYPES = {"UltimateSDUpscale"}
FALLBACK_UPSCALE_NODE_TYPES = {
    "UltimateSDUpscale",
    "ImageUpscaleWithModel",
    "LatentUpscale",
    "LatentUpscaleBy",
}


def history_file_entries(history: Any) -> list[dict[str, str]]:
    if not isinstance(history, dict) or not isinstance(history.get("outputs"), dict):
        return []
    entries: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def visit(value: Any, node_id: str) -> None:
        if isinstance(value, dict):
            filename = value.get("filename")
            file_type = value.get("type")
            subfolder = value.get("subfolder", "")
            if isinstance(filename, str) and isinstance(file_type, str) and isinstance(subfolder, str):
                key = (file_type, subfolder, filename)
                if key not in seen:
                    seen.add(key)
                    entries.append(
                        {
                            "nodeId": node_id,
                            "filename": filename,
                            "subfolder": subfolder,
                            "type": file_type,
                        }
                    )
            for nested in value.values():
                visit(nested, node_id)
        elif isinstance(value, list):
            for nested in value:
                visit(nested, node_id)

    for node_id, output in history["outputs"].items():
        visit(output, str(node_id))
    return entries


def preferred_upscale_output_nodes(
    workflow: Any, output_nodes: Any
) -> set[str]:
    """Return output nodes whose input graph contains an upscale node.

    Workflows often save both an intermediate image and its final high-resolution
    version. Prefer the latter when the graph makes that distinction explicit,
    while leaving unrelated multi-output workflows unchanged.
    """
    if not isinstance(workflow, dict) or not isinstance(output_nodes, list):
        return set()
    primary: set[str] = set()
    fallback: set[str] = set()
    for output_node in output_nodes:
        if not isinstance(output_node, str):
            continue
        queue = [output_node]
        visited: set[str] = set()
        while queue:
            node_id = queue.pop()
            if node_id in visited:
                continue
            visited.add(node_id)
            node = workflow.get(node_id)
            if not isinstance(node, dict):
                continue
            class_type = node.get("class_type")
            if class_type in FINAL_UPSCALE_NODE_TYPES:
                primary.add(output_node)
                break
            if class_type in FALLBACK_UPSCALE_NODE_TYPES:
                fallback.add(output_node)
                break
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for value in inputs.values():
                if (
                    isinstance(value, list)
                    and len(value) == 2
                    and isinstance(value[0], str)
                    and isinstance(value[1], int)
                ):
                    queue.append(value[0])
    return primary or fallback


def final_history_file_entries(
    history: Any, preferred_output_nodes: set[str] | None = None
) -> list[dict[str, str]]:
    entries = history_file_entries(history)
    final_entries = [entry for entry in entries if entry["type"] == "output"]
    if preferred_output_nodes:
        preferred = [
            entry for entry in final_entries
            if entry["nodeId"] in preferred_output_nodes
        ]
        if preferred:
            return preferred
    return final_entries or entries

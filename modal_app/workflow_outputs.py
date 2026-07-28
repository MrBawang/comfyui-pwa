from __future__ import annotations

from typing import Any


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


def final_history_file_entries(history: Any) -> list[dict[str, str]]:
    entries = history_file_entries(history)
    final_entries = [entry for entry in entries if entry["type"] == "output"]
    return final_entries or entries

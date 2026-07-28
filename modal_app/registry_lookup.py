from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from functools import lru_cache
from typing import Any, Callable, Mapping


MANAGER_NODE_MAP_SOURCES = (
    (
        "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/"
        "main/extension-node-map.json",
        "raw.githubusercontent.com",
    ),
    (
        "https://cdn.jsdelivr.net/gh/ltdrdata/ComfyUI-Manager@main/"
        "extension-node-map.json",
        "cdn.jsdelivr.net",
    ),
)
REGISTRY_SEARCH_URL = "https://api.comfy.org/nodes/search"
REGISTRY_VERSIONS_URL = "https://api.comfy.org/nodes/{node_id}/versions"
COMFYUI_REPOSITORY = "https://github.com/comfyanonymous/comfyui"
MAX_MANAGER_MAP_BYTES = 5 * 1024 * 1024
MAX_REGISTRY_RESPONSE_BYTES = 1024 * 1024
MAX_REGISTRY_VERSIONS_BYTES = 5 * 1024 * 1024
GIT_COMMIT = re.compile(r"^[a-fA-F0-9]{40}$")


def _read_json(url: str, *, hostname: str, maximum: int) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": "Comfy-Desk/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            resolved = urllib.parse.urlparse(response.geturl())
            if resolved.scheme != "https" or resolved.hostname != hostname:
                raise ValueError("节点包查询发生了不受信任的重定向")
            data = response.read(maximum + 1)
    except (urllib.error.HTTPError, urllib.error.URLError) as error:
        raise ValueError("无法查询节点包信息") from error
    if len(data) > maximum:
        raise ValueError("节点包查询响应过大")
    try:
        return json.loads(data)
    except json.JSONDecodeError as error:
        raise ValueError("节点包查询响应格式不正确") from error


def _repository_key(repository: str) -> str:
    return repository.strip().rstrip("/").removesuffix(".git").casefold()


def _name_tokens(name: str) -> tuple[str, ...]:
    separated = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    return tuple(sorted(token.casefold() for token in re.findall(r"[A-Za-z0-9]+", separated)))


def _repository_indexes(
    node_map: Mapping[str, Any],
) -> tuple[dict[str, set[str]], dict[tuple[str, ...], set[str]]]:
    exact: dict[str, set[str]] = {}
    tokens: dict[tuple[str, ...], set[str]] = {}
    for repository, metadata in node_map.items():
        if not isinstance(repository, str) or not isinstance(metadata, list) or not metadata:
            continue
        node_types = metadata[0]
        if not isinstance(node_types, list):
            continue
        for node_type in node_types:
            if not isinstance(node_type, str) or not node_type:
                continue
            exact.setdefault(node_type.casefold(), set()).add(repository)
            node_tokens = _name_tokens(node_type)
            if len(node_tokens) >= 2:
                tokens.setdefault(node_tokens, set()).add(repository)
    return exact, tokens


@lru_cache(maxsize=1)
def _manager_indexes() -> tuple[dict[str, set[str]], dict[tuple[str, ...], set[str]]]:
    last_error: ValueError | None = None
    for url, hostname in MANAGER_NODE_MAP_SOURCES:
        try:
            raw = _read_json(
                url,
                hostname=hostname,
                maximum=MAX_MANAGER_MAP_BYTES,
            )
            if not isinstance(raw, Mapping):
                raise ValueError("节点类型映射格式不正确")
            return _repository_indexes(raw)
        except ValueError as error:
            last_error = error
    raise ValueError("节点类型映射暂时不可用") from last_error


def _search_registry(query: str) -> list[Mapping[str, Any]]:
    url = REGISTRY_SEARCH_URL + "?" + urllib.parse.urlencode({"search": query, "limit": 20})
    raw = _read_json(url, hostname="api.comfy.org", maximum=MAX_REGISTRY_RESPONSE_BYTES)
    if not isinstance(raw, Mapping) or not isinstance(raw.get("nodes"), list):
        raise ValueError("Registry 搜索响应格式不正确")
    return [item for item in raw["nodes"] if isinstance(item, Mapping)]


@lru_cache(maxsize=256)
def _registry_versions(node_id: str) -> frozenset[str]:
    url = REGISTRY_VERSIONS_URL.format(
        node_id=urllib.parse.quote(node_id, safe="")
    )
    raw = _read_json(
        url,
        hostname="api.comfy.org",
        maximum=MAX_REGISTRY_VERSIONS_BYTES,
    )
    if not isinstance(raw, list):
        raise ValueError("Registry 版本响应格式不正确")
    return frozenset(
        str(item["version"])
        for item in raw
        if isinstance(item, Mapping)
        and isinstance(item.get("version"), str)
        and item["version"]
    )


def _package_from_repository(
    repository: str,
    search: Callable[[str], list[Mapping[str, Any]]],
) -> Mapping[str, Any] | None:
    repository_key = _repository_key(repository)
    query = urllib.parse.urlparse(repository).path.rstrip("/").rsplit("/", 1)[-1]
    matches = [
        item
        for item in search(query)
        if isinstance(item.get("repository"), str)
        and _repository_key(item["repository"]) == repository_key
    ]
    return matches[0] if len(matches) == 1 else None


def _package_from_marker(
    marker: str,
    search: Callable[[str], list[Mapping[str, Any]]],
) -> Mapping[str, Any] | None:
    if len(marker) > 120 or not re.fullmatch(r"[A-Za-z0-9_. -]+", marker):
        return None
    marker_key = "".join(_name_tokens(marker))
    if not marker_key:
        return None
    matches = []
    for item in search(marker):
        fields = [item.get("id"), item.get("name")]
        repository = item.get("repository")
        if isinstance(repository, str):
            fields.extend(urllib.parse.urlparse(repository).path.strip("/").split("/"))
        normalized = {"".join(_name_tokens(value)) for value in fields if isinstance(value, str)}
        if any(value == marker_key or value.startswith(marker_key) for value in normalized):
            matches.append(item)
    return matches[0] if len(matches) == 1 else None


def _package_from_registry_reference(
    reference: str,
    search: Callable[[str], list[Mapping[str, Any]]],
    version_lookup: Callable[[str], frozenset[str]] | None = None,
) -> tuple[Mapping[str, Any] | None, str, str]:
    registry_id, separator, version = reference.strip().partition("@")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", registry_id):
        return None, "", ""
    if separator and not re.fullmatch(r"[A-Za-z0-9_.+-]{1,80}", version):
        return None, "", ""
    matches = [
        item
        for item in search(registry_id)
        if isinstance(item.get("id"), str)
        and item["id"].casefold() == registry_id.casefold()
    ]
    if len(matches) != 1:
        return None, "", ""
    package = matches[0]
    if GIT_COMMIT.fullmatch(version):
        return package, "", version.lower()
    if not version or version_lookup is None:
        return package, version, ""
    try:
        available_versions = version_lookup(str(package["id"]))
    except ValueError:
        return package, "", ""
    return package, version if version in available_versions else "", ""


def resolve_node_packages_from_catalog(
    node_types: list[str],
    indexes: tuple[dict[str, set[str]], dict[tuple[str, ...], set[str]]],
    search: Callable[[str], list[Mapping[str, Any]]],
    package_hints: Mapping[str, Any] | None = None,
    version_lookup: Callable[[str], frozenset[str]] | None = None,
) -> dict[str, Any]:
    exact, tokens = indexes
    package_groups: dict[tuple[str, str], dict[str, Any]] = {}
    suggestion_groups: dict[tuple[str, str], dict[str, Any]] = {}
    unresolved = []
    search_cache: dict[str, list[Mapping[str, Any]]] = {}

    def cached_search(query: str) -> list[Mapping[str, Any]]:
        if query not in search_cache:
            search_cache[query] = search(query)
        return search_cache[query]

    normalized_hints = {
        node_type.casefold(): [str(value) for value in values if isinstance(value, str)]
        for node_type, values in (package_hints or {}).items()
        if isinstance(node_type, str) and isinstance(values, list)
    }

    def add_package(
        package: Mapping[str, Any],
        node_type: str,
        *,
        suggestion_source: str | None = None,
        version_override: str = "",
        source_revision: str = "",
    ) -> bool:
        registry_id = package.get("id")
        if not isinstance(registry_id, str) or not registry_id:
            return False
        latest = package.get("latest_version")
        latest_version = latest.get("version") if isinstance(latest, Mapping) else None
        version = version_override or (latest_version if isinstance(latest_version, str) else "")
        package_repository = package.get("repository")
        groups = suggestion_groups if suggestion_source else package_groups
        group = groups.setdefault(
            ("registry", registry_id.casefold()),
            {
                "kind": "registry",
                "registryId": registry_id,
                "name": str(package.get("name") or registry_id),
                "repository": package_repository if isinstance(package_repository, str) else "",
                "version": version,
                **({"sourceRevision": source_revision} if source_revision else {}),
                "nodeTypes": [],
                **(
                    {"confidence": "low", "source": suggestion_source}
                    if suggestion_source
                    else {}
                ),
            },
        )
        if node_type not in group["nodeTypes"]:
            group["nodeTypes"].append(node_type)
        return True

    for node_type in sorted(set(node_types)):
        hinted_packages: dict[str, tuple[Mapping[str, Any], str, str]] = {}
        for reference in normalized_hints.get(node_type.casefold(), []):
            package, hinted_version, source_revision = _package_from_registry_reference(
                reference, cached_search, version_lookup
            )
            registry_id = package.get("id") if package else None
            if isinstance(registry_id, str) and registry_id:
                hinted_packages[registry_id.casefold()] = (
                    package,
                    hinted_version,
                    source_revision,
                )
        if len(hinted_packages) == 1:
            package, hinted_version, source_revision = next(
                iter(hinted_packages.values())
            )
            add_package(
                package,
                node_type,
                version_override=hinted_version,
                source_revision=source_revision,
            )
            continue
        if len(hinted_packages) > 1:
            for package, hinted_version, source_revision in hinted_packages.values():
                add_package(
                    package,
                    node_type,
                    suggestion_source="workflow-metadata-conflict",
                    version_override=hinted_version,
                    source_revision=source_revision,
                )
            continue

        repositories = exact.get(node_type.casefold(), set())
        match_source = "exact" if repositories else ""
        if not repositories:
            node_tokens = _name_tokens(node_type)
            if len(node_tokens) >= 2:
                repositories = tokens.get(node_tokens, set())
                if repositories:
                    match_source = "tokens"

        repository = next(iter(repositories)) if len(repositories) == 1 else None
        if (
            match_source == "exact"
            and repository
            and _repository_key(repository) == COMFYUI_REPOSITORY
        ):
            group = package_groups.setdefault(
                ("core", COMFYUI_REPOSITORY),
                {
                    "kind": "core",
                    "name": "ComfyUI 核心",
                    "repository": repository,
                    "nodeTypes": [],
                },
            )
            group["nodeTypes"].append(node_type)
            continue

        if match_source == "exact" and len(repositories) > 1:
            candidate_packages: dict[str, Mapping[str, Any]] = {}
            for candidate_repository in sorted(repositories):
                candidate = _package_from_repository(
                    candidate_repository, cached_search
                )
                candidate_id = candidate.get("id") if candidate else None
                if isinstance(candidate_id, str) and candidate_id:
                    candidate_packages[candidate_id.casefold()] = candidate
            if candidate_packages:
                for candidate in candidate_packages.values():
                    add_package(
                        candidate,
                        node_type,
                        suggestion_source="ambiguous-manager-map",
                    )
                continue

        package = _package_from_repository(repository, cached_search) if repository else None
        suggestion_source = "node-name-heuristic" if package is not None and match_source != "exact" else None
        if package is None:
            markers = re.findall(r"\(([^)]+)\)", node_type)
            package = _package_from_marker(markers[-1], cached_search) if markers else None
            suggestion_source = "node-name-heuristic" if package is not None else None
        if package is None:
            unresolved.append(node_type)
            continue
        add_package(package, node_type, suggestion_source=suggestion_source)

    packages = sorted(
        package_groups.values(),
        key=lambda item: (item["kind"] != "registry", item["name"].casefold()),
    )
    suggestions = sorted(
        suggestion_groups.values(), key=lambda item: item["name"].casefold()
    )
    return {
        "missingNodePackages": packages,
        "suggestedNodePackages": suggestions,
        "unresolvedNodes": unresolved,
        "nodePackageLookupStatus": "ready",
    }


def resolve_missing_node_packages(
    node_types: list[str], package_hints: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    return resolve_node_packages_from_catalog(
        node_types,
        _manager_indexes(),
        _search_registry,
        package_hints,
        _registry_versions,
    )


def with_node_package_lookup_failure(
    result: Mapping[str, Any], missing_nodes: list[Any]
) -> dict[str, Any]:
    return {
        **result,
        "missingNodePackages": [],
        "suggestedNodePackages": [],
        "unresolvedNodes": list(missing_nodes),
        "nodePackageLookupStatus": "failed",
        "nodePackageLookupMessage": (
            "节点包在线目录暂时不可用；请重新检查，"
            "或核对后手动填写 Registry 包名"
        ),
    }

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


MAX_NODE_ARCHIVE_BYTES = 250 * 1024 * 1024
MAX_NODE_EXTRACTED_BYTES = 500 * 1024 * 1024
REGISTRY_ID = re.compile(r"^[A-Za-z0-9_.@-]{1,160}$")
REGISTRY_NODE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
REGISTRY_VERSION = re.compile(r"^[A-Za-z0-9_.+-]{1,40}$")
GITHUB_COMMIT = re.compile(r"^[a-fA-F0-9]{40}$")
PROTECTED_RUNTIME_PACKAGES = frozenset(
    {"torch", "torchvision", "torchaudio", "triton"}
)


def parse_registry_reference(registry_id: str) -> tuple[str, str | None]:
    if not REGISTRY_ID.fullmatch(registry_id):
        raise ValueError("Registry 包名格式不正确")
    if "@" not in registry_id:
        node_id, version = registry_id, None
    else:
        node_id, version = registry_id.rsplit("@", 1)
    if not REGISTRY_NODE_ID.fullmatch(node_id):
        raise ValueError("Registry 节点 ID 格式不正确")
    if version is not None and not REGISTRY_VERSION.fullmatch(version):
        raise ValueError("Registry 节点版本格式不正确")
    return node_id, version


def _github_archive_url(repository: str, revision: str) -> tuple[str, str]:
    parsed = urllib.parse.urlparse(repository.strip().rstrip("/"))
    path_parts = parsed.path.strip("/").split("/")
    if (
        parsed.scheme != "https"
        or parsed.hostname != "github.com"
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or len(path_parts) != 2
        or not all(re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", part) for part in path_parts)
        or not GITHUB_COMMIT.fullmatch(revision)
    ):
        raise ValueError("GitHub 节点源码地址或 commit 不正确")
    owner, repository_name = path_parts
    repository_name = repository_name.removesuffix(".git")
    normalized = f"https://github.com/{owner}/{repository_name}"
    archive = (
        f"https://codeload.github.com/{owner}/{repository_name}/tar.gz/"
        f"{revision.lower()}"
    )
    return normalized, archive


def _registry_repository(node_id: str) -> str:
    url = "https://api.comfy.org/nodes/search?" + urllib.parse.urlencode(
        {"search": node_id, "limit": 20}
    )
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            resolved = urllib.parse.urlparse(response.geturl())
            if resolved.scheme != "https" or resolved.hostname != "api.comfy.org":
                raise ValueError("Registry 节点信息发生了不受信任的重定向")
            data = response.read(1024 * 1024 + 1)
    except (urllib.error.HTTPError, urllib.error.URLError) as error:
        raise ValueError("无法从 ComfyUI Registry 验证节点仓库") from error
    if len(data) > 1024 * 1024:
        raise ValueError("Registry 节点仓库响应过大")
    try:
        payload = json.loads(data)
    except json.JSONDecodeError as error:
        raise ValueError("Registry 节点仓库响应格式不正确") from error
    nodes = payload.get("nodes") if isinstance(payload, dict) else None
    if not isinstance(nodes, list):
        raise ValueError("Registry 节点仓库响应格式不正确")
    matches = [
        item
        for item in nodes if isinstance(item, dict)
        if isinstance(item.get("id"), str)
        and item["id"].casefold() == node_id.casefold()
        and isinstance(item.get("repository"), str)
    ]
    if len(matches) != 1:
        raise ValueError("Registry 中无法唯一确认节点仓库")
    return str(matches[0]["repository"])


def _requirements_from_node_root(node_root: Path) -> list[str]:
    requirements = node_root / "requirements.txt"
    if not requirements.is_file():
        return []
    if requirements.stat().st_size > 512 * 1024:
        raise ValueError("节点 requirements.txt 过大")
    result = []
    for raw_line in requirements.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-") or len(line) > 500:
            raise ValueError("节点 requirements.txt 包含不支持的依赖声明")
        result.append(line)
    if len(result) > 200:
        raise ValueError("节点 requirements.txt 依赖过多")
    return result


def _dependency_project_name(specification: str) -> str:
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9_.-]*)", specification)
    if match is None:
        return ""
    return re.sub(r"[-_.]+", "-", match.group(1)).casefold()


def _install_python_dependencies(
    dependency_specs: list[str], python_packages: Path
) -> list[str]:
    protected = sorted(
        {
            _dependency_project_name(specification)
            for specification in dependency_specs
            if _dependency_project_name(specification) in PROTECTED_RUNTIME_PACKAGES
        }
    )
    install_specs = [
        specification
        for specification in dependency_specs
        if _dependency_project_name(specification) not in PROTECTED_RUNTIME_PACKAGES
    ]
    if not install_specs:
        return protected

    environment = os.environ.copy()
    existing_python_path = environment.get("PYTHONPATH", "")
    environment["PYTHONPATH"] = str(python_packages) + (
        os.pathsep + existing_python_path if existing_python_path else ""
    )
    environment["PIP_TARGET"] = str(python_packages)

    install_projects = {
        _dependency_project_name(specification) for specification in install_specs
    }
    if (
        "transparent-background" in install_projects
        and "stringzilla" not in install_projects
    ):
        install_specs.append("stringzilla<4.6.2")
    no_build_isolation_packages = []
    if "image-reward" in install_projects:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "uv",
                "pip",
                "install",
                "--upgrade",
                "--target",
                str(python_packages),
                "setuptools<81",
            ],
            check=True,
            env=environment,
            timeout=300,
        )
        no_build_isolation_packages.extend(
            ["--no-build-isolation-package", "image-reward"]
        )

    if "image-reward" in install_projects and "torchscale" in install_projects:
        torchscale_specs = [
            specification
            for specification in install_specs
            if _dependency_project_name(specification) == "torchscale"
        ]
        install_specs = [
            specification
            for specification in install_specs
            if _dependency_project_name(specification) != "torchscale"
        ]
        subprocess.run(
            [
                sys.executable,
                "-m",
                "uv",
                "pip",
                "install",
                "--upgrade",
                "--no-deps",
                "--target",
                str(python_packages),
                *torchscale_specs,
            ],
            check=True,
            env=environment,
            timeout=300,
        )

    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix="comfy-desk-uv-excludes-",
        suffix=".txt",
    ) as exclusions:
        exclusions.write("\n".join(sorted(PROTECTED_RUNTIME_PACKAGES)) + "\n")
        exclusions.flush()
        subprocess.run(
            [
                sys.executable,
                "-m",
                "uv",
                "pip",
                "install",
                "--upgrade",
                "--strict",
                "--target",
                str(python_packages),
                "--excludes",
                exclusions.name,
                *no_build_isolation_packages,
                *install_specs,
            ],
            check=True,
            env=environment,
            timeout=1_800,
        )
    return protected


def _safe_archive_target(root: Path, name: str) -> Path:
    normalized = Path(*Path(name.replace("\\", "/")).parts)
    if normalized.is_absolute() or ".." in normalized.parts:
        raise ValueError("节点压缩包包含不安全路径")
    target = (root / normalized).resolve()
    resolved_root = root.resolve()
    if target != resolved_root and resolved_root not in target.parents:
        raise ValueError("节点压缩包包含不安全路径")
    return target


def extract_node_archive(archive_path: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=False)
    extracted_bytes = 0

    if zipfile.is_zipfile(archive_path):
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                extracted_bytes += member.file_size
                if extracted_bytes > MAX_NODE_EXTRACTED_BYTES:
                    raise ValueError("节点解压后不能超过 500 MB")
                mode = (member.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    raise ValueError("节点压缩包不能包含符号链接")
                target = _safe_archive_target(destination, member.filename)
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
    else:
        try:
            archive = tarfile.open(archive_path, mode="r:*")
        except tarfile.TarError as error:
            raise ValueError("Registry 返回了不支持的节点压缩包") from error
        with archive:
            for member in archive.getmembers():
                extracted_bytes += member.size
                if extracted_bytes > MAX_NODE_EXTRACTED_BYTES:
                    raise ValueError("节点解压后不能超过 500 MB")
                if member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
                    raise ValueError("节点压缩包包含不支持的文件类型")
                target = _safe_archive_target(destination, member.name)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("无法读取节点压缩包文件")
                with source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)

    entries = [entry for entry in destination.iterdir() if entry.name != "__MACOSX"]
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return destination


def install_registry_node(
    registry_id: str,
    *,
    custom_node_root: Path,
    python_packages: Path,
) -> dict[str, str]:
    node_id, requested_version = parse_registry_reference(registry_id)
    query = ""
    if requested_version is not None:
        query = "?version=" + urllib.parse.quote(requested_version, safe="")
    metadata_url = (
        "https://api.comfy.org/nodes/"
        + urllib.parse.quote(node_id, safe="")
        + "/install"
        + query
    )

    try:
        with urllib.request.urlopen(metadata_url, timeout=30) as response:
            resolved_metadata = urllib.parse.urlparse(response.geturl())
            if resolved_metadata.scheme != "https" or resolved_metadata.hostname != "api.comfy.org":
                raise ValueError("Registry 节点信息发生了不受信任的重定向")
            metadata_bytes = response.read(1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            if requested_version is not None:
                raise ValueError(
                    f"Registry 中不存在节点包版本：{node_id}@{requested_version}"
                ) from error
            raise ValueError(f"Registry 中不存在节点包：{node_id}") from error
        raise ValueError("无法从 ComfyUI Registry 获取节点信息") from error
    except urllib.error.URLError as error:
        raise ValueError("无法从 ComfyUI Registry 获取节点信息") from error
    if len(metadata_bytes) > 1024 * 1024:
        raise ValueError("Registry 节点信息响应过大")
    try:
        metadata = json.loads(metadata_bytes)
    except json.JSONDecodeError as error:
        raise ValueError("Registry 节点信息格式不正确") from error
    if not isinstance(metadata, dict):
        raise ValueError("Registry 节点信息格式不正确")

    resolved_node_id = str(metadata.get("node_id", ""))
    resolved_version = str(metadata.get("version", ""))
    download_url = str(metadata.get("downloadUrl", ""))
    dependencies = metadata.get("dependencies", [])
    if resolved_node_id.casefold() != node_id.casefold():
        raise ValueError("Registry 返回了不匹配的节点")
    if not REGISTRY_VERSION.fullmatch(resolved_version):
        raise ValueError("Registry 返回了不正确的节点版本")
    if requested_version is not None and resolved_version != requested_version:
        raise ValueError("Registry 返回了不匹配的节点版本")
    parsed_download = urllib.parse.urlparse(download_url)
    if parsed_download.scheme != "https" or parsed_download.hostname != "cdn.comfy.org":
        raise ValueError("Registry 节点下载地址不受信任")
    if not isinstance(dependencies, list) or len(dependencies) > 200:
        raise ValueError("Registry 节点依赖格式不正确")
    dependency_specs = []
    for dependency in dependencies:
        if not isinstance(dependency, str) or not dependency or len(dependency) > 500:
            raise ValueError("Registry 节点依赖格式不正确")
        if dependency.startswith("-") or "\n" in dependency or "\r" in dependency:
            raise ValueError("Registry 节点依赖包含不安全参数")
        dependency_specs.append(dependency)

    with tempfile.TemporaryDirectory(prefix="comfy-desk-node-") as temporary:
        temporary_root = Path(temporary)
        archive_path = temporary_root / "node-archive"
        try:
            with urllib.request.urlopen(download_url, timeout=120) as response, archive_path.open("wb") as output:
                resolved_download = urllib.parse.urlparse(response.geturl())
                if resolved_download.scheme != "https" or resolved_download.hostname != "cdn.comfy.org":
                    raise ValueError("Registry 节点下载发生了不受信任的重定向")
                downloaded = 0
                while chunk := response.read(1024 * 1024):
                    downloaded += len(chunk)
                    if downloaded > MAX_NODE_ARCHIVE_BYTES:
                        raise ValueError("节点压缩包不能超过 250 MB")
                    output.write(chunk)
        except (urllib.error.HTTPError, urllib.error.URLError) as error:
            raise ValueError("无法下载 Registry 节点压缩包") from error

        package_root = extract_node_archive(archive_path, temporary_root / "extracted")
        target = custom_node_root / node_id
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.exists():
            shutil.rmtree(target)
        shutil.copytree(package_root, target)

    protected_dependencies = _install_python_dependencies(
        dependency_specs, python_packages
    )

    (target / ".comfy-desk-install.json").write_text(
        json.dumps(
            {
                "nodeId": node_id,
                "version": resolved_version,
                "protectedDependencies": protected_dependencies,
            }
        ),
        encoding="utf-8",
    )
    return {
        "registryId": node_id,
        "version": resolved_version,
        "protectedDependencies": ",".join(protected_dependencies),
    }


def install_github_node(
    registry_id: str,
    repository: str,
    revision: str,
    *,
    custom_node_root: Path,
    python_packages: Path,
) -> dict[str, str]:
    node_id, requested_version = parse_registry_reference(registry_id)
    if requested_version is not None:
        raise ValueError("GitHub 源码安装请使用不带版本的 Registry ID")
    normalized_repository, download_url = _github_archive_url(repository, revision)
    trusted_repository, _ = _github_archive_url(
        _registry_repository(node_id), revision
    )
    if normalized_repository.casefold() != trusted_repository.casefold():
        raise ValueError("GitHub 仓库与 Registry 节点包不匹配")

    with tempfile.TemporaryDirectory(prefix="comfy-desk-node-") as temporary:
        temporary_root = Path(temporary)
        archive_path = temporary_root / "node-archive"
        request = urllib.request.Request(
            download_url, headers={"User-Agent": "Comfy-Desk/1.0"}
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response, archive_path.open("wb") as output:
                resolved_download = urllib.parse.urlparse(response.geturl())
                if (
                    resolved_download.scheme != "https"
                    or resolved_download.hostname != "codeload.github.com"
                ):
                    raise ValueError("GitHub 节点下载发生了不受信任的重定向")
                downloaded = 0
                while chunk := response.read(1024 * 1024):
                    downloaded += len(chunk)
                    if downloaded > MAX_NODE_ARCHIVE_BYTES:
                        raise ValueError("节点压缩包不能超过 250 MB")
                    output.write(chunk)
        except (urllib.error.HTTPError, urllib.error.URLError) as error:
            raise ValueError("无法下载 GitHub 节点源码") from error

        package_root = extract_node_archive(
            archive_path, temporary_root / "extracted"
        )
        dependency_specs = _requirements_from_node_root(package_root)
        target = custom_node_root / node_id
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.exists():
            shutil.rmtree(target)
        shutil.copytree(package_root, target)

    protected_dependencies = _install_python_dependencies(
        dependency_specs, python_packages
    )
    (target / ".comfy-desk-install.json").write_text(
        json.dumps(
            {
                "nodeId": node_id,
                "version": revision.lower(),
                "repository": normalized_repository,
                "source": "github",
                "protectedDependencies": protected_dependencies,
            }
        ),
        encoding="utf-8",
    )
    return {
        "registryId": node_id,
        "version": revision.lower(),
        "repository": normalized_repository,
        "source": "github",
        "protectedDependencies": ",".join(protected_dependencies),
    }

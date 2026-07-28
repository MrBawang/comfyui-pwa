#!/usr/bin/env python3
"""Dry-run and selectively import legacy ~/.lorachef/projects data."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


WARNING_BYTES = 8 * 1024**3
STOP_BYTES = 9_500 * 1024**2


def projects(root: Path, selected: set[str]) -> list[tuple[dict[str, Any], Path, list[tuple[dict[str, Any], dict[str, Any], Path]]]]:
    result = []
    for manifest_path in sorted(root.glob("*/project.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if selected and manifest.get("id") not in selected:
            continue
        directory = manifest_path.parent
        reference = directory / "reference" / manifest["referenceFilename"]
        candidates = []
        batches = {item["id"]: item for item in manifest.get("batches") or []}
        for candidate in manifest.get("candidates") or []:
            path = (directory / candidate["relativePath"]).resolve()
            if path.is_file() and (path == directory or directory in path.parents):
                candidates.append((candidate, batches.get(candidate.get("batchId"), {}), path))
        if reference.is_file():
            result.append((manifest, reference, candidates))
    return result


def api(url: str, path: str, headers: dict[str, str], payload: dict[str, Any] | None = None):
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    request_headers = {**headers, "accept": "application/json"}
    if data is not None:
        request_headers["content-type"] = "application/json"
    request = urllib.request.Request(f"{url.rstrip('/')}{path}", data=data, headers=request_headers)
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def upload(url: str, headers: dict[str, str], path: Path) -> dict[str, Any]:
    media_type = {
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
    }.get(path.suffix.lower(), "image/jpeg")
    request = urllib.request.Request(
        f"{url.rstrip('/')}/api/uploads",
        data=path.read_bytes(),
        headers={
            **headers,
            "accept": "application/json",
            "content-type": media_type,
            "x-file-name": urllib.parse.quote(path.name),
            "x-file-size": str(path.stat().st_size),
        },
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("~/.lorachef/projects").expanduser())
    parser.add_argument("--project", action="append", default=[], help="legacy project id; repeat to select")
    parser.add_argument("--url", default=os.environ.get("LORACHEF_CLOUD_URL", ""))
    parser.add_argument("--access-client-id", default=os.environ.get("CF_ACCESS_CLIENT_ID", ""))
    parser.add_argument("--access-client-secret", default=os.environ.get("CF_ACCESS_CLIENT_SECRET", ""))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    found = projects(args.root.expanduser().resolve(), set(args.project))
    total = sum(reference.stat().st_size + sum(path.stat().st_size for _, _, path in candidates)
                for _, reference, candidates in found)
    print(f"Projects: {len(found)}")
    print(f"Objects: {sum(1 + len(item[2]) for item in found)}")
    print(f"Upload bytes: {total:,} ({total / 1024**3:.2f} GiB)")
    if total >= WARNING_BYTES:
        print("WARNING: selected local data alone reaches the 8 GiB storage warning line.")
    if not args.apply:
        print("Dry-run only. Re-run with --apply and --url after selecting projects.")
        return
    if not args.url or not args.access_client_id or not args.access_client_secret:
        parser.error("--apply requires URL and Cloudflare Access service-token credentials")
    headers = {
        "cf-access-client-id": args.access_client_id,
        "cf-access-client-secret": args.access_client_secret,
    }
    usage = api(args.url, "/api/storage", headers)
    if int(usage.get("usedBytes", 0)) + total >= int(usage.get("stopBytes", STOP_BYTES)):
        raise SystemExit("Import would cross the cloud storage protection line; select fewer projects")
    for manifest, reference, candidates in found:
        reference_upload = upload(args.url, headers, reference)
        imported = api(args.url, "/api/migrations/legacy-projects", headers, {
            "sourceId": manifest["id"], "manifest": manifest, "uploadKey": reference_upload["uploadKey"],
        })
        target_id = imported["id"]
        print(f"{manifest['name']}: {target_id}")
        for index, (candidate, batch, path) in enumerate(candidates, 1):
            candidate_upload = upload(args.url, headers, path)
            api(args.url, f"/api/migrations/legacy-projects/{target_id}/candidates", headers, {
                "candidate": candidate, "batch": batch, "uploadKey": candidate_upload["uploadKey"],
            })
            print(f"  {index}/{len(candidates)} {path.name}")
    print("Import complete. Legacy files were not modified or deleted.")


if __name__ == "__main__":
    main()

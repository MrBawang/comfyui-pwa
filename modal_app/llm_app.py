"""Independent Modal deployment for the Qwen3.6 GGUF chat service."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any

import modal


APP_NAME = "lorachef-qwen36"
LLAMA_CPP_COMMIT = "0e4a0362239713ea95a6864a17a8de4b0ad90d62"
MODEL_REPO = "HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive"
MODEL_REVISION = "f12a584fecbeb5f20001130d8ecd66c9327ae685"
MODEL_ID = "qwen3.6-35b-a3b-hauhaucs"
MODEL_ROOT = Path("/models")
MANIFEST_PATH = MODEL_ROOT / "manifest.json"
QUANTS = {
    "Q6_K_P": "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf",
    "Q5_K_P": "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q5_K_P.gguf",
    "Q4_K_M": "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf",
}
PRIORITY = tuple(QUANTS)

models = modal.Volume.from_name("lorachef-qwen36-models", create_if_missing=True)
huggingface = modal.Secret.from_name("huggingface-secret")
llm_config = modal.Secret.from_name("lorachef-qwen36-config")

download_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("huggingface-hub[hf_xet]==0.36.0")
)

server_image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("build-essential", "cmake", "curl", "git")
    .run_commands(
        "git clone --filter=blob:none https://github.com/ggml-org/llama.cpp /opt/llama.cpp",
        f"git -C /opt/llama.cpp checkout {LLAMA_CPP_COMMIT}",
        "cmake -S /opt/llama.cpp -B /opt/llama.cpp/build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DCMAKE_BUILD_TYPE=Release",
        "ln -sf /usr/local/cuda/lib64/stubs/libcuda.so /usr/local/cuda/lib64/stubs/libcuda.so.1 && LIBRARY_PATH=/usr/local/cuda/lib64/stubs LD_LIBRARY_PATH=/usr/local/cuda/lib64/stubs cmake --build /opt/llama.cpp/build --config Release -j 4 --target llama-server",
    )
    .uv_pip_install(
        "fastapi==0.115.4",
        "httpx==0.28.1",
        "uvicorn[standard]==0.32.0",
    )
    .add_local_python_source("modal_app")
)

app = modal.App(APP_NAME)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_manifest() -> dict[str, Any]:
    try:
        value = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


@app.function(
    image=download_image,
    volumes={str(MODEL_ROOT): models},
    secrets=[huggingface, llm_config],
    timeout=24 * 60 * 60,
    max_containers=1,
)
def download_model(quant: str = "Q6_K_P", activate: bool = True) -> dict[str, Any]:
    """Download one pinned quantization and verify its operator-supplied LFS SHA-256."""
    from huggingface_hub import hf_hub_download

    if quant not in QUANTS:
        raise ValueError(f"quant must be one of: {', '.join(PRIORITY)}")
    checksum_key = f"LLM_MODEL_SHA256_{quant}"
    expected = os.environ.get(checksum_key, "").lower()
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
        raise RuntimeError(f"Modal secret lorachef-qwen36-config must define {checksum_key}")
    models.reload()
    filename = QUANTS[quant]
    target = MODEL_ROOT / filename
    if not target.is_file() or _sha256(target) != expected:
        if target.exists():
            target.unlink()
        downloaded = Path(
            hf_hub_download(
                repo_id=MODEL_REPO,
                filename=filename,
                revision=MODEL_REVISION,
                local_dir=MODEL_ROOT,
            )
        )
        if downloaded != target:
            downloaded.replace(target)
        actual = _sha256(target)
        if actual != expected:
            target.unlink(missing_ok=True)
            raise RuntimeError(f"SHA-256 mismatch for {filename}: expected {expected}, got {actual}")
    manifest = _read_manifest()
    installed = manifest.get("installed") if isinstance(manifest.get("installed"), dict) else {}
    installed[quant] = {
        "filename": filename,
        "sha256": expected,
        "bytes": target.stat().st_size,
        "revision": MODEL_REVISION,
    }
    manifest = {
        "repo": MODEL_REPO,
        "revision": MODEL_REVISION,
        "activeQuant": quant if activate else manifest.get("activeQuant", quant),
        "installed": installed,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=True, indent=2), encoding="utf-8")
    models.commit()
    return {"status": "ready", "quant": quant, **installed[quant], "active": manifest["activeQuant"]}


def _candidate_models() -> list[tuple[str, Path, str]]:
    models.reload()
    manifest = _read_manifest()
    installed = manifest.get("installed") if isinstance(manifest.get("installed"), dict) else {}
    active = str(manifest.get("activeQuant", "Q6_K_P"))
    start = PRIORITY.index(active) if active in PRIORITY else 0
    candidates = []
    for quant in PRIORITY[start:]:
        record = installed.get(quant)
        if not isinstance(record, dict) or record.get("revision") != MODEL_REVISION:
            continue
        path = MODEL_ROOT / QUANTS[quant]
        if path.is_file() and path.stat().st_size == int(record.get("bytes", -1)):
            candidates.append((quant, path, str(record.get("sha256", "unknown"))))
    return candidates


def _wait_for_server(process: subprocess.Popen[bytes], timeout: int = 1_200) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen("http://127.0.0.1:8001/health", timeout=2) as response:
                if response.status == 200:
                    return True
        except OSError:
            pass
        time.sleep(2)
    return False


def _used_gpu_mib() -> int:
    output = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
        text=True,
        timeout=5,
    )
    return int(output.strip().splitlines()[0])


@app.cls(
    image=server_image,
    gpu="L40S",
    volumes={str(MODEL_ROOT): models},
    secrets=[llm_config],
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    scaledown_window=60,
    startup_timeout=1_800,
    timeout=900,
)
@modal.concurrent(max_inputs=1)
class QwenServer:
    @modal.enter()
    def start(self) -> None:
        candidates = _candidate_models()
        if not candidates:
            raise RuntimeError("No verified model is installed; run download_model first")
        log_path = Path("/tmp/llama-server.log")
        for quant, model_path, checksum in candidates:
            log_handle = log_path.open("wb")
            command = [
                "/opt/llama.cpp/build/bin/llama-server",
                "--model", str(model_path),
                "--alias", MODEL_ID,
                "--host", "127.0.0.1",
                "--port", "8001",
                "--ctx-size", "65536",
                "--parallel", "1",
                "--n-gpu-layers", "999",
                "--cache-type-k", "q8_0",
                "--cache-type-v", "q8_0",
                "--batch-size", "512",
                "--ubatch-size", "128",
                "--threads", "4",
                "--flash-attn", "on",
                "--jinja",
                "--no-webui",
            ]
            process = subprocess.Popen(command, stdout=log_handle, stderr=subprocess.STDOUT)
            if _wait_for_server(process):
                used_mib = _used_gpu_mib()
                if used_mib <= 44 * 1024:
                    self.llama_process = process
                    self.log_handle = log_handle
                    os.environ.update(
                        {
                            "LLM_MODEL_ID": MODEL_ID,
                            "LLM_MODEL_REVISION": MODEL_REVISION,
                            "LLM_ACTIVE_QUANT": quant,
                            "LLM_ACTIVE_SHA256": checksum,
                        }
                    )
                    return
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
            log_handle.close()
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-4_000:] if log_path.exists() else ""
        raise RuntimeError(f"All installed quantizations failed the 44 GiB startup gate: {tail}")

    @modal.exit()
    def stop(self) -> None:
        process = getattr(self, "llama_process", None)
        if process and process.poll() is None:
            process.terminate()
        handle = getattr(self, "log_handle", None)
        if handle:
            handle.close()

    @modal.web_server(8000, startup_timeout=1_800)
    def serve(self) -> None:
        subprocess.Popen(
            [
                "uvicorn",
                "modal_app.llm_proxy:app",
                "--host", "0.0.0.0",
                "--port", "8000",
                "--no-access-log",
            ]
        )


@app.local_entrypoint()
def main(quant: str = "Q6_K_P", activate: bool = True) -> None:
    result = download_model.remote(quant=quant, activate=activate)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("Deploy with: modal deploy modal_app/llm_app.py")

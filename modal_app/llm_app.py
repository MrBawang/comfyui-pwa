"""Independent Modal deployment for the Qwen3.6 GGUF chat service."""

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
api_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install(
        "fastapi==0.115.4",
        "httpx==0.28.1",
    )
    .add_local_python_source("modal_app")
)

app = modal.App(APP_NAME)
job_state = modal.Dict.from_name("lorachef-qwen36-job-state", create_if_missing=True)


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
    scaledown_window=300,
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

    @modal.method()
    def generate(self, operation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Generate one durable, non-streaming reply after the GPU container is ready."""
        import httpx

        try:
            job_state.put(
                f"operation-stage:{operation_id}",
                {"status": "generating", "message": "模型已加载，正在生成回复"},
            )
        except Exception:
            pass
        request_payload = dict(payload)
        request_payload["stream"] = False
        response = httpx.post(
            "http://127.0.0.1:8001/v1/chat/completions",
            json=request_payload,
            timeout=600,
        )
        response.raise_for_status()
        body = response.json()
        choices = body.get("choices") if isinstance(body, dict) else None
        message = choices[0].get("message") if isinstance(choices, list) and choices else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("模型返回了空内容")
        return {"content": content, "model": MODEL_ID}

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


@app.function(
    image=api_image,
    secrets=[llm_config],
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    timeout=660,
)
@modal.concurrent(max_inputs=1)
@modal.asgi_app()
def api():
    """Lightweight control plane that survives Qwen GPU cold starts."""
    import hmac

    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse

    from modal_app.llm_proxy import _validated_payload

    web = FastAPI(title="Qwen3.6 Modal Jobs API", docs_url=None, redoc_url=None)

    def authorize(request: Request) -> None:
        expected = os.environ.get("LLM_API_TOKEN", "")
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not expected:
            raise HTTPException(status_code=503, detail="LLM authentication is not configured")
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="invalid bearer token")

    @web.get("/health")
    async def health(request: Request) -> dict[str, str]:
        authorize(request)
        return {"status": "ready", "app": APP_NAME}

    @web.post("/jobs", status_code=202)
    async def create_job(request: Request):
        authorize(request)
        raw_length = request.headers.get("content-length")
        if raw_length and (not raw_length.isdigit() or int(raw_length) > 512 * 1024):
            raise HTTPException(status_code=413, detail="request body is too large")
        raw = await request.body()
        if len(raw) > 512 * 1024:
            raise HTTPException(status_code=413, detail="request body is too large")
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, TypeError) as error:
            raise HTTPException(status_code=400, detail="invalid JSON request") from error
        operation_id = body.get("operationId") if isinstance(body, dict) else None
        if (
            not isinstance(operation_id, str)
            or len(operation_id) != 32
            or any(character not in "0123456789abcdef" for character in operation_id)
        ):
            raise HTTPException(status_code=400, detail="invalid operationId")
        payload = _validated_payload(body.get("payload"))
        payload["stream"] = False
        existing_job_id = await job_state.get.aio(f"operation-job:{operation_id}", None)
        if isinstance(existing_job_id, str):
            metadata = await job_state.get.aio(f"job:{existing_job_id}", None)
            return {
                "jobId": existing_job_id,
                "status": metadata.get("status", "warming") if isinstance(metadata, dict) else "warming",
                "message": "Modal 已接收该任务，不会重复启动 GPU",
            }
        call = await QwenServer().generate.spawn.aio(operation_id, payload)
        await job_state.put.aio(
            f"job:{call.object_id}",
            {
                "operationId": operation_id,
                "status": "warming",
                "message": "正在启动 GPU 并加载模型",
            },
        )
        await job_state.put.aio(f"operation-job:{operation_id}", call.object_id)
        return {
            "jobId": call.object_id,
            "status": "warming",
            "message": "Modal 已接收任务，正在启动 GPU",
        }

    @web.get("/jobs/{job_id}")
    async def job_status(job_id: str, request: Request):
        authorize(request)
        metadata = await job_state.get.aio(f"job:{job_id}", None)
        if not isinstance(metadata, dict):
            raise HTTPException(status_code=404, detail="job not found")
        call = modal.functions.FunctionCall.from_id(job_id)
        try:
            result = await call.get.aio(timeout=0)
        except TimeoutError:
            operation_id = metadata.get("operationId")
            stage = (
                await job_state.get.aio(f"operation-stage:{operation_id}", None)
                if isinstance(operation_id, str)
                else None
            )
            current = stage if isinstance(stage, dict) else metadata
            return JSONResponse(
                {
                    "jobId": job_id,
                    "status": current.get("status", "warming"),
                    "message": current.get("message", "正在启动 GPU"),
                },
                status_code=202,
            )
        except Exception as error:
            return {"jobId": job_id, "status": "failed", "message": str(error)}
        if not isinstance(result, dict) or not isinstance(result.get("content"), str):
            return {"jobId": job_id, "status": "failed", "message": "模型结果格式不正确"}
        return {
            "jobId": job_id,
            "status": "succeeded",
            "message": "回复生成完成",
            "content": result["content"],
        }

    @web.delete("/jobs/{job_id}")
    async def cancel_job(job_id: str, request: Request):
        authorize(request)
        metadata = await job_state.get.aio(f"job:{job_id}", None)
        if not isinstance(metadata, dict):
            raise HTTPException(status_code=404, detail="job not found")
        call = modal.functions.FunctionCall.from_id(job_id)
        try:
            await call.hydrate.aio()
            await call.cancel.aio()
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {"jobId": job_id, "status": "cancelled", "message": "任务已取消"}

    return web


@app.local_entrypoint()
def main(quant: str = "Q6_K_P", activate: bool = True) -> None:
    result = download_model.remote(quant=quant, activate=activate)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("Deploy with: modal deploy modal_app/llm_app.py")

"""Small authenticated proxy in front of the loopback llama.cpp server."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse


UPSTREAM = "http://127.0.0.1:8001"
MAX_REQUEST_BYTES = 512 * 1024
MAX_SYSTEM_CHARS = 12_000
MAX_MESSAGE_CHARS = 20_000
GPU_PEAK_USED_MIB = 0

app = FastAPI(title="Qwen3.6 Modal API", docs_url=None, redoc_url=None)


def _authorize(request: Request) -> None:
    expected = os.environ.get("LLM_API_TOKEN", "")
    supplied = request.headers.get("authorization", "").removeprefix("Bearer ")
    if not expected:
        raise HTTPException(status_code=503, detail="LLM authentication is not configured")
    import hmac

    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid bearer token")


def _gpu_memory() -> dict[str, int] | None:
    try:
        output = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            timeout=5,
        ).strip().splitlines()[0]
        used, total = (int(value.strip()) for value in output.split(","))
        return {"usedMiB": used, "totalMiB": total}
    except (OSError, ValueError, subprocess.SubprocessError, IndexError):
        return None


def _record_gpu_memory() -> dict[str, int] | None:
    global GPU_PEAK_USED_MIB
    memory = _gpu_memory()
    if memory:
        GPU_PEAK_USED_MIB = max(GPU_PEAK_USED_MIB, memory["usedMiB"])
        return {**memory, "peakUsedMiB": GPU_PEAK_USED_MIB}
    return None


async def _sample_gpu_memory(stop: asyncio.Event) -> None:
    while not stop.is_set():
        await asyncio.to_thread(_record_gpu_memory)
        try:
            await asyncio.wait_for(stop.wait(), timeout=2)
        except TimeoutError:
            pass


def _validated_payload(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("messages"), list):
        raise HTTPException(status_code=400, detail="messages must be an array")
    messages = []
    for index, item in enumerate(raw["messages"]):
        if not isinstance(item, dict) or item.get("role") not in {"system", "user", "assistant"}:
            raise HTTPException(status_code=400, detail=f"message {index} has an invalid role")
        content = item.get("content")
        if not isinstance(content, str) or not content or len(content) > MAX_MESSAGE_CHARS:
            raise HTTPException(status_code=400, detail=f"message {index} has invalid content")
        if item["role"] == "system" and (index != 0 or len(content) > MAX_SYSTEM_CHARS):
            raise HTTPException(status_code=400, detail="system message must be first and at most 12,000 characters")
        messages.append({"role": item["role"], "content": content})
    if not messages or messages[0]["role"] != "system":
        raise HTTPException(status_code=400, detail="the first message must be a system message")
    template_kwargs = raw.get("chat_template_kwargs") or {}
    if not isinstance(template_kwargs, dict):
        raise HTTPException(status_code=400, detail="chat_template_kwargs must be an object")
    max_tokens = max(1, min(int(raw.get("max_tokens", 1024)), 2048))
    return {
        "model": os.environ.get("LLM_MODEL_ID", "qwen3.6-35b-a3b-hauhaucs"),
        "messages": messages,
        "stream": bool(raw.get("stream", False)),
        "max_tokens": max_tokens,
        "temperature": max(0.0, min(float(raw.get("temperature", 0.7)), 2.0)),
        "top_p": max(0.0, min(float(raw.get("top_p", 0.95)), 1.0)),
        "chat_template_kwargs": {
            "enable_thinking": bool(template_kwargs.get("enable_thinking", True))
        },
    }


@app.get("/health")
async def health(request: Request) -> JSONResponse:
    _authorize(request)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{UPSTREAM}/health")
        ready = response.is_success
    except httpx.HTTPError:
        ready = False
    return JSONResponse(
        {
            "status": "ready" if ready else "starting",
            "model": os.environ.get("LLM_MODEL_ID", "qwen3.6-35b-a3b-hauhaucs"),
            "quant": os.environ.get("LLM_ACTIVE_QUANT", "unknown"),
            "revision": os.environ.get("LLM_MODEL_REVISION", "unknown"),
            "sha256": os.environ.get("LLM_ACTIVE_SHA256", "unknown"),
            "contextSize": 16_384,
            "concurrency": 1,
            "gpuMemory": _record_gpu_memory(),
        },
        status_code=200 if ready else 503,
    )


async def _stream_response(client: httpx.AsyncClient, response: httpx.Response) -> AsyncIterator[bytes]:
    stop_sampling = asyncio.Event()
    sampler = asyncio.create_task(_sample_gpu_memory(stop_sampling))
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        stop_sampling.set()
        await sampler
        await response.aclose()
        await client.aclose()


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Response:
    _authorize(request)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError as error:
            raise HTTPException(status_code=400, detail="invalid content-length") from error
        if declared_size < 0 or declared_size > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="request body is too large")
    body = await request.body()
    if len(body) > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="request body is too large")
    try:
        payload = _validated_payload(json.loads(body))
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail="invalid JSON request") from error

    client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10))
    if payload["stream"]:
        upstream = await client.send(
            client.build_request("POST", f"{UPSTREAM}/v1/chat/completions", json=payload),
            stream=True,
        )
        if not upstream.is_success:
            detail = (await upstream.aread())[:2_000]
            await upstream.aclose()
            await client.aclose()
            return Response(detail, status_code=upstream.status_code, media_type="application/json")
        return StreamingResponse(
            _stream_response(client, upstream),
            media_type="text/event-stream",
            headers={"cache-control": "no-store", "x-accel-buffering": "no"},
        )

    try:
        upstream = await client.post(f"{UPSTREAM}/v1/chat/completions", json=payload)
        return Response(
            upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
        )
    finally:
        await client.aclose()

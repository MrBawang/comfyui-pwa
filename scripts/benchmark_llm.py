#!/usr/bin/env python3
"""Explicit, operator-run GPU acceptance check for the deployed Modal LLM."""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request


PROMPTS = [
    "用一句中文描述柔和窗边人像摄影。",
    "为 ComfyUI 写一段正面半身人像提示词。",
    "解释为什么系统提示词应固定版本。",
    "给出一个雨夜街景提示词，不要标题。",
    "把‘侧面肖像’扩写为简洁提示词。",
] * 4


def health(url: str, token: str) -> dict:
    base = url.rstrip("/")
    suffix = "/v1/chat/completions"
    if base.endswith(suffix):
        base = base[: -len(suffix)]
    call = urllib.request.Request(
        f"{base}/health",
        headers={"authorization": f"Bearer {token}", "accept": "application/json"},
    )
    with urllib.request.urlopen(call, timeout=60) as response:
        return json.loads(response.read())


def request(url: str, token: str, payload: dict) -> tuple[float, float, int]:
    body = json.dumps(payload).encode()
    call = urllib.request.Request(
        f"{url.rstrip('/')}/v1/chat/completions",
        data=body,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    started = time.perf_counter()
    first_token = None
    tokens = 0
    with urllib.request.urlopen(call, timeout=600) as response:
        for raw_line in response:
            line = raw_line.decode(errors="replace").strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            try:
                delta = json.loads(line[5:]).get("choices", [{}])[0].get("delta", {}).get("content", "")
            except (json.JSONDecodeError, IndexError):
                continue
            if delta:
                first_token = first_token or time.perf_counter()
                tokens += max(1, len(delta) // 2)
    finished = time.perf_counter()
    if first_token is None:
        raise RuntimeError("model returned no tokens")
    return first_token - started, finished - first_token, tokens


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--confirm-gpu", action="store_true", help="required because this wakes an L40S")
    args = parser.parse_args()
    if not args.confirm_gpu:
        parser.error("pass --confirm-gpu to acknowledge that this starts billable GPU work")
    print("Warm-up request (cold-start timing is reported but excluded from the hot-start gate)")
    cold_ttft, _, _ = request(
        args.url,
        args.token,
        {
            "model": "qwen3.6-35b-a3b-hauhaucs",
            "messages": [
                {"role": "system", "content": "你是可靠的中文提示词助手。"},
                {"role": "user", "content": "回复：已就绪"},
            ],
            "stream": True,
            "max_tokens": 16,
            "chat_template_kwargs": {"enable_thinking": False},
        },
    )
    print(f"cold-start ttft={cold_ttft:.2f}s")
    results = []
    for index, prompt in enumerate(PROMPTS, 1):
        ttft, generation_seconds, tokens = request(
            args.url,
            args.token,
            {
                "model": "qwen3.6-35b-a3b-hauhaucs",
                "messages": [
                    {"role": "system", "content": "你是可靠的中文提示词助手。严格遵守用户要求。"},
                    {"role": "user", "content": prompt},
                ],
                "stream": True,
                "max_tokens": 96,
                "chat_template_kwargs": {"enable_thinking": False},
            },
        )
        speed = tokens / max(generation_seconds, 0.001)
        results.append((ttft, speed))
        print(f"{index:02d}/20 ttft={ttft:.2f}s speed~{speed:.1f} token/s")
    ttfts = sorted(item[0] for item in results)
    p95 = ttfts[min(len(ttfts) - 1, int(len(ttfts) * 0.95))]
    minimum_speed = min(item[1] for item in results)
    server_health = health(args.url, args.token)
    peak_memory_mib = int((server_health.get("gpuMemory") or {}).get("peakUsedMiB", 0))
    context_size = int(server_health.get("contextSize", 0))
    passed = p95 <= 5 and minimum_speed >= 15 and 0 < peak_memory_mib <= 44 * 1024 and context_size >= 65_536
    print(json.dumps({
        "coldStartTtft": cold_ttft,
        "hotTtftP95": p95,
        "minimumTokenPerSecond": minimum_speed,
        "peakGpuMemoryMiB": peak_memory_mib,
        "contextSize": context_size,
        "activeQuant": server_health.get("quant"),
        "passed": passed,
    }, indent=2))
    if not passed:
        raise SystemExit("acceptance gate failed; activate Q5_K_P, then Q4_K_M if necessary")


if __name__ == "__main__":
    main()

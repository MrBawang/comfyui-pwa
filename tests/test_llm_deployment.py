from pathlib import Path
import unittest


class LlmDeploymentTests(unittest.TestCase):
    def test_cuda_image_targets_the_l40s_architecture(self) -> None:
        source = Path("modal_app/llm_app.py").read_text(encoding="utf-8")

        self.assertIn("-DCMAKE_CUDA_ARCHITECTURES=89", source)
        self.assertIn("/usr/local/cuda/lib64/stubs/libcuda.so.1", source)
        self.assertIn('gpu="L40S"', source)
        self.assertIn('"--ctx-size", "65536"', source)

    def test_chat_uses_a_cpu_control_plane_and_durable_gpu_call(self) -> None:
        source = Path("modal_app/llm_app.py").read_text(encoding="utf-8")

        self.assertNotIn("from __future__ import annotations", source)
        self.assertIn("async def health(request: Request)", source)
        self.assertIn("@modal.asgi_app()", source)
        self.assertIn("@modal.method()", source)
        self.assertIn("QwenServer().generate.spawn.aio", source)
        self.assertIn('request_payload["stream"] = False', source)
        self.assertIn("scaledown_window=300", source)
        self.assertIn("@modal.concurrent(max_inputs=1)\n@modal.asgi_app()", source)
        self.assertIn('f"operation-job:{operation_id}"', source)


if __name__ == "__main__":
    unittest.main()

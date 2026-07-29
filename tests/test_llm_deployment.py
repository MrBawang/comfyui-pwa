from pathlib import Path
import unittest


class LlmDeploymentTests(unittest.TestCase):
    def test_cuda_image_targets_the_l40s_architecture(self) -> None:
        source = Path("modal_app/llm_app.py").read_text(encoding="utf-8")

        self.assertIn("-DCMAKE_CUDA_ARCHITECTURES=89", source)
        self.assertIn("/usr/local/cuda/lib64/stubs/libcuda.so.1", source)
        self.assertIn('gpu="L40S"', source)


if __name__ == "__main__":
    unittest.main()

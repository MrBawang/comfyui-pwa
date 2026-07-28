import unittest
import tempfile
from io import BytesIO
from pathlib import Path

from PIL import Image

from modal_app.comfy_runtime import (
    comfy_execution_error_message,
    comfy_prompt_error_message,
    discover_repository_file,
    huggingface_download_error_message,
    python_runtime_package_available,
    standard_prompt_id,
    validate_uploaded_image,
    validate_python_runtime_package,
)


class ComfyRuntimeTests(unittest.TestCase):
    def test_gpu_worker_allows_only_one_container(self):
        source = (Path(__file__).parents[1] / "modal_app" / "comfy_app.py").read_text(
            encoding="utf-8"
        )
        worker_config = source.split("class ComfyWorker", 1)[0].rsplit("@app.cls(", 1)[1]
        self.assertIn("max_containers=1", worker_config)

    def test_extracts_readable_sageattention_execution_error(self):
        message = comfy_execution_error_message(
            [
                [
                    "execution_error",
                    {
                        "node_id": "111",
                        "node_type": "PathchSageAttentionKJ",
                        "exception_message": (
                            "cannot import name 'sageattn_qk_int8_pv_fp16_cuda' "
                            "from 'sageattention'"
                        ),
                    },
                ]
            ]
        )

        self.assertIn("已关闭该加速", message)

    def test_extracts_readable_prompt_validation_error(self):
        message = comfy_prompt_error_message(
            '{"error":{"message":"Prompt outputs failed validation"},'
            '"node_errors":{"99":{"class_type":"KSamplerSelect","errors":['
            '{"message":"Value not in list","extra_info":{'
            '"input_name":"sampler_name","received_value":"res_2m"}}]}}}'
        )

        self.assertEqual(
            message,
            "ComfyUI 拒绝了工作流：节点 99（KSamplerSelect）的参数 sampler_name 的值 'res_2m'不受当前云端支持",
        )

    def test_formats_standard_lowercase_prompt_uuid(self):
        self.assertEqual(
            standard_prompt_id("1234567890ABCDEF1234567890ABCDEF"),
            "12345678-90ab-cdef-1234-567890abcdef",
        )

    def test_discovers_unique_nested_repository_file(self):
        self.assertEqual(
            discover_repository_file(
                "flux2-vae.safetensors",
                "flux2-vae.safetensors",
                [
                    "README.md",
                    "split_files/vae/flux2-vae.safetensors",
                ],
            ),
            "split_files/vae/flux2-vae.safetensors",
        )

    def test_does_not_guess_between_duplicate_model_filenames(self):
        with self.assertRaisesRegex(ValueError, "请填写完整仓库内路径"):
            discover_repository_file(
                "model.safetensors",
                "model.safetensors",
                ["fp8/model.safetensors", "bf16/model.safetensors"],
            )

    def test_returns_none_without_matching_model_file(self):
        self.assertIsNone(
            discover_repository_file(
                "missing.safetensors",
                "missing.safetensors",
                ["README.md", "weights/model.safetensors"],
            )
        )

    def test_converts_remote_huggingface_errors_to_plain_messages(self):
        self.assertIn(
            "文件不存在",
            huggingface_download_error_message(
                "RemoteEntryNotFoundError",
                "owner/repo",
                "model.safetensors",
                "main",
            ),
        )
        self.assertIn(
            "仓库不存在或无权访问",
            huggingface_download_error_message(
                "RepositoryNotFoundError",
                "owner/repo",
                "model.safetensors",
                "main",
            ),
        )

    def test_validates_uploaded_images_before_gpu_submission(self):
        buffer = BytesIO()
        Image.new("RGB", (2, 2), "white").save(buffer, format="PNG")

        validate_uploaded_image(buffer.getvalue())
        with self.assertRaisesRegex(ValueError, "有效图像"):
            validate_uploaded_image(b"not-an-image")
        with self.assertRaisesRegex(ValueError, "不能为空"):
            validate_uploaded_image(b"")

    def test_runtime_package_check_imports_exact_installed_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "demo_runtime"
            package.mkdir()
            (package / "__init__.py").write_text("VALUE = 1\n", encoding="utf-8")
            metadata = root / "demo_runtime-1.2.3.dist-info"
            metadata.mkdir()
            (metadata / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: demo-runtime\nVersion: 1.2.3\n",
                encoding="utf-8",
            )

            validate_python_runtime_package(
                root,
                module="demo_runtime",
                distribution="demo-runtime",
                version="1.2.3",
            )
            self.assertTrue(
                python_runtime_package_available(
                    root,
                    module="demo_runtime",
                    distribution="demo-runtime",
                    version="1.2.3",
                )
            )
            self.assertFalse(
                python_runtime_package_available(
                    root,
                    module="demo_runtime",
                    distribution="demo-runtime",
                    version="9.9.9",
                )
            )

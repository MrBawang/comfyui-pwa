import json
import tempfile
import unittest
from pathlib import Path

from modal_app.model_assets import (
    apply_model_bindings,
    list_model_assets,
    require_matching_sha256,
    validate_model_bindings,
    validate_model_download_url,
)


class ModelBindingTests(unittest.TestCase):
    def test_rewrites_only_matching_model_category_and_filename(self):
        workflow = {
            "1": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "expected/model.safetensors"},
            },
            "2": {
                "class_type": "VAELoader",
                "inputs": {"vae_name": "expected/model.safetensors"},
            },
        }

        prepared = apply_model_bindings(
            workflow,
            [{
                "category": "checkpoints",
                "expectedFilename": "expected/model.safetensors",
                "actualFilename": "shared/real-model.safetensors",
            }],
        )

        self.assertEqual(
            prepared["1"]["inputs"]["ckpt_name"], "shared/real-model.safetensors"
        )
        self.assertEqual(
            prepared["2"]["inputs"]["vae_name"], "expected/model.safetensors"
        )
        self.assertEqual(
            workflow["1"]["inputs"]["ckpt_name"], "expected/model.safetensors"
        )

    def test_rejects_duplicate_or_unsafe_bindings(self):
        duplicate = [{
            "category": "vae",
            "expectedFilename": "old.safetensors",
            "actualFilename": "new.safetensors",
        }] * 2
        with self.assertRaisesRegex(ValueError, "重复"):
            validate_model_bindings(duplicate)
        with self.assertRaisesRegex(ValueError, "不安全"):
            validate_model_bindings([{
                "category": "vae",
                "expectedFilename": "old.safetensors",
                "actualFilename": "../secret",
            }])


class ModelCatalogTests(unittest.TestCase):
    def test_lists_models_and_ignores_sidecars_hidden_and_partial_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "checkpoints" / "shared" / "portrait.safetensors"
            model.parent.mkdir(parents=True)
            model.write_bytes(b"model")
            model.with_name(f".{model.name}.comfy-desk.json").write_text(
                json.dumps({
                    "sourceKind": "url",
                    "sourceUrl": "https://civitai.com/model",
                    "sha256": "a" * 64,
                }),
                encoding="utf-8",
            )
            (model.parent / ".download.partial").write_bytes(b"partial")
            (model.parent / "ignored.partial").write_bytes(b"partial")

            assets = list_model_assets(root)

        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["category"], "checkpoints")
        self.assertEqual(assets[0]["filename"], "shared/portrait.safetensors")
        self.assertEqual(assets[0]["source"]["sourceKind"], "url")


class ModelDownloadSafetyTests(unittest.TestCase):
    def test_allows_trusted_https_hosts_and_rejects_credentials_or_other_hosts(self):
        self.assertEqual(
            validate_model_download_url("https://civitai.com/api/download/models/42?type=Model"),
            "https://civitai.com/api/download/models/42?type=Model",
        )
        delivery_url = (
            "https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf"
            ".r2.cloudflarestorage.com/model/file.safetensors?X-Amz-Signature=abc"
        )
        self.assertEqual(validate_model_download_url(delivery_url), delivery_url)
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            validate_model_download_url(
                "https://untrusted.r2.cloudflarestorage.com/model.safetensors"
            )
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            validate_model_download_url("https://example.com/model.safetensors")
        with self.assertRaisesRegex(ValueError, "Token"):
            validate_model_download_url("https://huggingface.co/file?token=secret")

    def test_rejects_sha256_mismatch(self):
        with self.assertRaisesRegex(ValueError, "校验失败"):
            require_matching_sha256("a" * 64, "b" * 64)
        require_matching_sha256("a" * 64, "a" * 64)


if __name__ == "__main__":
    unittest.main()

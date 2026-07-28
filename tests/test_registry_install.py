import tempfile
import unittest
import urllib.error
import zipfile
import os
from pathlib import Path
from unittest.mock import patch

from modal_app.registry_install import (
    PROTECTED_RUNTIME_PACKAGES,
    _github_archive_url,
    _install_python_dependencies,
    _requirements_from_node_root,
    extract_node_archive,
    install_registry_node,
    parse_registry_reference,
)


class RegistryInstallTests(unittest.TestCase):
    def test_parses_versioned_registry_id(self):
        self.assertEqual(
            parse_registry_reference("basic_data_handling@1.5.1"),
            ("basic_data_handling", "1.5.1"),
        )

    def test_extracts_safe_zip(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "node.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("package/__init__.py", "NODE_CLASS_MAPPINGS = {}")
            package = extract_node_archive(archive, root / "output")
            self.assertTrue((package / "__init__.py").is_file())

    def test_rejects_zip_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "node.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("../escape.py", "bad")
            with self.assertRaisesRegex(ValueError, "不安全路径"):
                extract_node_archive(archive, root / "output")

    def test_reports_missing_registry_version_for_404(self):
        error = urllib.error.HTTPError(
            "https://api.comfy.org/nodes/example/install?version=deadbeef",
            404,
            "Not Found",
            {},
            None,
        )
        with tempfile.TemporaryDirectory() as temporary, patch(
            "modal_app.registry_install.urllib.request.urlopen",
            side_effect=error,
        ):
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "不存在节点包版本"):
                install_registry_node(
                    "example@deadbeef",
                    custom_node_root=root / "nodes",
                    python_packages=root / "python",
                )

    def test_builds_fixed_github_commit_archive_url(self):
        repository, archive = _github_archive_url(
            "https://github.com/cubiq/ComfyUI_essentials",
            "9d9f4bedfc9f0321c19faf71855e228c93bd0dc9",
        )

        self.assertEqual(
            repository, "https://github.com/cubiq/ComfyUI_essentials"
        )
        self.assertEqual(
            archive,
            "https://codeload.github.com/cubiq/ComfyUI_essentials/tar.gz/"
            "9d9f4bedfc9f0321c19faf71855e228c93bd0dc9",
        )

    def test_rejects_unpinned_or_non_github_node_source(self):
        with self.assertRaisesRegex(ValueError, "commit"):
            _github_archive_url(
                "https://github.com/cubiq/ComfyUI_essentials", "main"
            )
        with self.assertRaisesRegex(ValueError, "GitHub"):
            _github_archive_url(
                "https://example.com/cubiq/ComfyUI_essentials",
                "9d9f4bedfc9f0321c19faf71855e228c93bd0dc9",
            )

    def test_reads_safe_node_requirements(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "requirements.txt").write_text(
                "# dependencies\nnumba\ncolour-science\n", encoding="utf-8"
            )

            self.assertEqual(
                _requirements_from_node_root(root), ["numba", "colour-science"]
            )

    def test_dependency_install_does_not_shadow_core_torch_packages(self):
        captured: dict[str, object] = {}

        def capture(command, **kwargs):
            excludes_path = Path(command[command.index("--excludes") + 1])
            captured["command"] = command
            captured["excludes"] = set(
                excludes_path.read_text(encoding="utf-8").splitlines()
            )
            captured["kwargs"] = kwargs

        with tempfile.TemporaryDirectory() as temporary, patch(
            "modal_app.registry_install.subprocess.run",
            side_effect=capture,
        ):
            protected = _install_python_dependencies(
                ["diffusers", "torch>=2", "torchvision"],
                Path(temporary),
            )

        command = captured["command"]
        self.assertIn("diffusers", command)
        self.assertNotIn("torch>=2", command)
        self.assertNotIn("torchvision", command)
        self.assertEqual(captured["excludes"], set(PROTECTED_RUNTIME_PACKAGES))
        self.assertEqual(protected, ["torch", "torchvision"])
        kwargs = captured["kwargs"]
        self.assertTrue(kwargs["check"])
        self.assertEqual(kwargs["timeout"], 1_800)
        self.assertEqual(
            kwargs["env"]["PYTHONPATH"].split(os.pathsep)[0], temporary
        )
        self.assertEqual(kwargs["env"]["PIP_TARGET"], temporary)

    def test_image_reward_uses_legacy_setuptools_build_compatibility(self):
        commands: list[list[str]] = []

        def capture(command, **_kwargs):
            commands.append(command)

        with tempfile.TemporaryDirectory() as temporary, patch(
            "modal_app.registry_install.subprocess.run",
            side_effect=capture,
        ):
            _install_python_dependencies(
                ["image-reward", "diffusers"], Path(temporary)
            )

        self.assertEqual(len(commands), 2)
        self.assertIn("setuptools<81", commands[0])
        self.assertIn("--no-build-isolation-package", commands[1])
        option_index = commands[1].index("--no-build-isolation-package")
        self.assertEqual(commands[1][option_index + 1], "image-reward")

    def test_image_reward_and_torchscale_avoid_fairscale_resolution_conflict(self):
        commands: list[list[str]] = []

        def capture(command, **_kwargs):
            commands.append(command)

        with tempfile.TemporaryDirectory() as temporary, patch(
            "modal_app.registry_install.subprocess.run",
            side_effect=capture,
        ):
            _install_python_dependencies(
                ["image-reward", "torchscale", "diffusers"], Path(temporary)
            )

        self.assertEqual(len(commands), 3)
        self.assertIn("--no-deps", commands[1])
        self.assertIn("torchscale", commands[1])
        self.assertNotIn("torchscale", commands[2])
        self.assertIn("image-reward", commands[2])

    def test_transparent_background_uses_stringzilla_with_python311_wheel(self):
        commands: list[list[str]] = []

        def capture(command, **_kwargs):
            commands.append(command)

        with tempfile.TemporaryDirectory() as temporary, patch(
            "modal_app.registry_install.subprocess.run",
            side_effect=capture,
        ):
            _install_python_dependencies(
                ["transparent-background", "pixeloe"], Path(temporary)
            )

        self.assertEqual(len(commands), 1)
        self.assertIn("stringzilla<4.6.2", commands[0])


if __name__ == "__main__":
    unittest.main()

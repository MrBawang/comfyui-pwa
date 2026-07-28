import json
import tempfile
import unittest
from pathlib import Path

from modal_app.object_info_cache import (
    OBJECT_INFO_CACHE_SCHEMA_VERSION,
    load_object_info_cache,
    load_or_refresh_object_info,
    load_previous_object_info_cache,
    migrate_asset_scoped_object_info_cache,
    object_info_cache_path,
    previous_object_info_cache_path,
    valid_object_info_cache,
    write_object_info_cache,
)


class ObjectInfoCacheTests(unittest.TestCase):
    def setUp(self):
        self.revision = "a" * 32
        self.version = "0.27.0"
        self.asset_version = "asset-a"
        self.object_info = {
            "LoadImage": {"input": {"required": {}}, "output_node": False},
            "SaveImage": {"input": {"required": {}}, "output_node": True},
        }

    def test_path_is_scoped_by_version_and_runtime_revision(self):
        root = Path("/vol/runtime")
        first = object_info_cache_path(
            root, self.revision, self.version, self.asset_version
        )
        second = object_info_cache_path(
            root, "b" * 32, self.version, self.asset_version
        )
        upgraded = object_info_cache_path(
            root, self.revision, "0.28.0", self.asset_version
        )
        changed_asset = object_info_cache_path(
            root, self.revision, self.version, "asset-b"
        )
        legacy = object_info_cache_path(
            root, "legacy", self.version, self.asset_version
        )

        self.assertNotEqual(first, second)
        self.assertNotEqual(first, upgraded)
        self.assertEqual(first, changed_asset)
        self.assertEqual(first.parent, root / "revisions" / self.revision / "schema-cache")
        self.assertEqual(legacy.parent, root / "schema-cache" / "legacy")
        self.assertIn(f"object-info-v{OBJECT_INFO_CACHE_SCHEMA_VERSION}-", first.name)

    def test_validator_rejects_stale_and_malformed_payloads(self):
        payload = {
            "cacheSchemaVersion": OBJECT_INFO_CACHE_SCHEMA_VERSION,
            "comfyuiVersion": self.version,
            "runtimeRevision": self.revision,
            "nodeCount": len(self.object_info),
            "objectInfo": self.object_info,
        }
        self.assertTrue(
            valid_object_info_cache(
                payload, self.revision, self.version, self.asset_version
            )
        )

        wrong_version = {**payload, "comfyuiVersion": "0.28.0"}
        wrong_revision = {**payload, "runtimeRevision": "b" * 32}
        wrong_count = {**payload, "nodeCount": 99}
        malformed_info = {**payload, "objectInfo": {"LoadImage": []}, "nodeCount": 1}
        for invalid in (
            wrong_version,
            wrong_revision,
            wrong_count,
            malformed_info,
        ):
            self.assertFalse(
                valid_object_info_cache(
                    invalid, self.revision, self.version, self.asset_version
                )
            )

    def test_loader_returns_only_valid_object_info(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "object-info.json"
            write_object_info_cache(
                path,
                self.object_info,
                self.revision,
                self.version,
                self.asset_version,
            )
            self.assertEqual(
                load_object_info_cache(
                    path,
                    self.revision,
                    self.version,
                    self.asset_version,
                ),
                self.object_info,
            )

            path.write_text(json.dumps({"objectInfo": self.object_info}), encoding="utf-8")
            self.assertIsNone(
                load_object_info_cache(
                    path,
                    self.revision,
                    self.version,
                    self.asset_version,
                )
            )

    def test_loads_previous_cache_only_as_migration_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = previous_object_info_cache_path(
                root, self.revision, self.version
            )
            path.parent.mkdir(parents=True)
            path.write_text(
                json.dumps(
                    {
                        "comfyuiVersion": self.version,
                        "runtimeRevision": self.revision,
                        "nodeCount": len(self.object_info),
                        "objectInfo": self.object_info,
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                load_previous_object_info_cache(
                    path, self.revision, self.version
                ),
                self.object_info,
            )

    def test_cache_hit_does_not_fetch_object_info(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "object-info.json"
            write_object_info_cache(
                path,
                self.object_info,
                self.revision,
                self.version,
                self.asset_version,
            )

            def unexpected_fetch():
                raise AssertionError("cache hit must not start ComfyUI")

            result, source = load_or_refresh_object_info(
                path,
                self.revision,
                self.version,
                self.asset_version,
                unexpected_fetch,
                expected_node_types=set(self.object_info),
            )
            self.assertEqual(result, self.object_info)
            self.assertEqual(source, "cache")

    def test_model_asset_change_reuses_runtime_schema_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = object_info_cache_path(
                root, self.revision, self.version, self.asset_version
            )
            write_object_info_cache(
                path,
                self.object_info,
                self.revision,
                self.version,
                self.asset_version,
            )

            def unexpected_fetch():
                raise AssertionError("model change must not start ComfyUI")

            result, source = load_or_refresh_object_info(
                object_info_cache_path(
                    root, self.revision, self.version, "asset-b"
                ),
                self.revision,
                self.version,
                "asset-b",
                unexpected_fetch,
                expected_node_types=set(self.object_info),
            )
            self.assertEqual(result, self.object_info)
            self.assertEqual(source, "cache")

    def test_migrates_complete_asset_scoped_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = object_info_cache_path(
                root, self.revision, self.version, "asset-b"
            )
            previous = target.parent / (
                f"object-info-v{OBJECT_INFO_CACHE_SCHEMA_VERSION - 1}-"
                f"{self.version}-0123456789abcdef.json"
            )
            previous.parent.mkdir(parents=True)
            previous.write_text(
                json.dumps(
                    {
                        "comfyuiVersion": self.version,
                        "runtimeRevision": self.revision,
                        "nodeCount": len(self.object_info),
                        "objectInfo": self.object_info,
                    }
                ),
                encoding="utf-8",
            )

            self.assertTrue(
                migrate_asset_scoped_object_info_cache(
                    target,
                    self.revision,
                    self.version,
                    "asset-b",
                    expected_node_types=set(self.object_info),
                )
            )
            self.assertEqual(
                load_object_info_cache(
                    target,
                    self.revision,
                    self.version,
                    "asset-b",
                ),
                self.object_info,
            )

    def test_invalid_cache_fetches_and_replaces_object_info(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "object-info.json"
            path.write_text("{}", encoding="utf-8")
            fetch_count = 0

            def fetch():
                nonlocal fetch_count
                fetch_count += 1
                return self.object_info

            result, source = load_or_refresh_object_info(
                path,
                self.revision,
                self.version,
                self.asset_version,
                fetch,
            )
            self.assertEqual(fetch_count, 1)
            self.assertEqual(result, self.object_info)
            self.assertEqual(source, "comfyui-cpu")
            self.assertEqual(
                load_object_info_cache(
                    path,
                    self.revision,
                    self.version,
                    self.asset_version,
                ),
                self.object_info,
            )

    def test_incomplete_refresh_is_not_cached(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "object-info.json"
            with self.assertRaisesRegex(ValueError, "已验证节点类型"):
                load_or_refresh_object_info(
                    path,
                    self.revision,
                    self.version,
                    self.asset_version,
                    lambda: {"LoadImage": self.object_info["LoadImage"]},
                    expected_node_types=set(self.object_info),
                )
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()

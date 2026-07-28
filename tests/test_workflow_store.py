import tempfile
import unittest
from pathlib import Path

from modal_app.workflow_store import (
    WORKFLOW_VALIDATION_VERSION,
    create_stored_workflow,
    list_stored_workflows,
    load_stored_workflow,
    load_stored_workflow_revision,
    load_stored_workflow_variant,
    refresh_stored_workflow,
    workflow_record_for_runtime,
)


class WorkflowStoreTests(unittest.TestCase):
    def analysis(self):
        return {
            "runnable": True,
            "format": "comfyui-canvas",
            "nodeCount": 2,
            "nodeTypes": ["LoadImage", "SaveImage"],
            "models": [],
            "imageInputs": [{"fieldName": "asset_1_image", "label": "image"}],
            "parameterInputs": [{"fieldName": "control_1_value", "kind": "integer"}],
            "outputNodes": ["2"],
            "compatibilityAdjustments": [
                {
                    "code": "demo",
                    "nodeId": "1",
                    "classType": "Demo",
                    "message": "adjusted",
                }
            ],
        }

    def test_creates_lists_and_loads_immutable_workflow_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workflow = {"1": {"class_type": "LoadImage", "inputs": {}}}
            created = create_stored_workflow(
                root,
                workflow,
                self.analysis(),
                name="  Portrait   edit  ",
                source_filename="canvas.json",
                runtime_revision="runtime-a",
                asset_version="assets-a",
            )

            records = list_stored_workflows(root, "runtime-a")
            manifest, stored = load_stored_workflow(root, created["id"])

            self.assertEqual(created["name"], "Portrait edit")
            self.assertEqual(records[0]["status"], "ready")
            self.assertEqual(manifest["revisionId"], created["revisionId"])
            self.assertEqual(stored, workflow)
            self.assertEqual(created["compatibilityAdjustments"][0]["code"], "demo")

    def test_marks_ready_workflow_stale_after_runtime_change(self):
        record = workflow_record_for_runtime(
            {"status": "ready", "runtimeRevision": "runtime-a"}, "runtime-b"
        )

        self.assertEqual(record["status"], "stale")
        self.assertIn("节点环境", record["statusMessage"])

    def test_normalizes_new_manifest_fields_for_older_workflows(self):
        record = workflow_record_for_runtime(
            {"status": "ready", "runtimeRevision": "runtime-a"}, "runtime-a"
        )

        self.assertEqual(record["textInputs"], [])
        self.assertEqual(record["parameterInputs"], [])
        self.assertEqual(record["variants"], [])
        self.assertEqual(record["compatibilityAdjustments"], [])
        self.assertEqual(record["status"], "stale")
        self.assertIn("检查规则", record["statusMessage"])

    def test_current_validation_version_remains_ready(self):
        record = workflow_record_for_runtime(
            {
                "status": "ready",
                "runtimeRevision": "runtime-a",
                "validationVersion": WORKFLOW_VALIDATION_VERSION,
            },
            "runtime-a",
        )

        self.assertEqual(record["status"], "ready")

    def test_refreshes_stale_workflow_as_new_immutable_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = {"1": {"class_type": "LoadImage", "inputs": {}}}
            created = create_stored_workflow(
                root,
                original,
                self.analysis(),
                name="Portrait edit",
                source_filename="canvas.json",
                runtime_revision="runtime-a",
                asset_version="assets-a",
            )
            replacement = {"2": {"class_type": "SaveImage", "inputs": {}}}

            refreshed = refresh_stored_workflow(
                root,
                created["id"],
                replacement,
                self.analysis(),
                runtime_revision="runtime-b",
                asset_version="assets-b",
            )

            manifest, stored = load_stored_workflow(root, created["id"])
            old_revision = (
                root
                / created["id"]
                / "revisions"
                / created["revisionId"]
                / "workflow.json"
            )
            self.assertNotEqual(refreshed["revisionId"], created["revisionId"])
            self.assertEqual(manifest["sourceFormat"], "comfyui-canvas")
            self.assertEqual(manifest["runtimeRevision"], "runtime-b")
            self.assertEqual(stored, replacement)
            self.assertTrue(old_revision.is_file())
            old_manifest, old_workflow = load_stored_workflow_revision(
                root, created["id"], created["revisionId"]
            )
            self.assertEqual(old_manifest["runtimeRevision"], "runtime-a")
            self.assertEqual(old_workflow, original)

    def test_rejects_unchecked_workflow_and_invalid_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "检查通过"):
                create_stored_workflow(
                    root,
                    {},
                    {"runnable": False},
                    name="Blocked",
                    source_filename="blocked.json",
                    runtime_revision="runtime-a",
                    asset_version="assets-a",
                )
            with self.assertRaisesRegex(ValueError, "ID"):
                load_stored_workflow(root, "../escape")

    def test_stores_and_loads_variant_workflow_with_manifest_schema(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            analysis = self.analysis()
            analysis["textInputs"] = [{"fieldName": "param_1_text"}]
            analysis["parameterInputs"] = [{"fieldName": "control_1_value"}]
            analysis["variants"] = [
                {
                    "id": "optional-image-11",
                    "name": "双图",
                    "nodeCount": 3,
                    "imageInputs": [
                        {"fieldName": "asset_1_image"},
                        {"fieldName": "asset_11_image"},
                    ],
                    "textInputs": [{"fieldName": "param_1_text"}],
                    "parameterInputs": [{"fieldName": "control_1_value"}],
                    "outputNodes": ["2"],
                }
            ]
            default_workflow = {"1": {"class_type": "LoadImage", "inputs": {}}}
            variant_workflow = {
                "1": {"class_type": "LoadImage", "inputs": {}},
                "11": {"class_type": "LoadImage", "inputs": {}},
            }

            created = create_stored_workflow(
                root,
                default_workflow,
                analysis,
                variant_workflows={"optional-image-11": variant_workflow},
                name="Dual input",
                source_filename="canvas.json",
                runtime_revision="runtime-a",
                asset_version="assets-a",
            )

            manifest, stored_variant = load_stored_workflow_variant(
                root, created["id"], "optional-image-11"
            )
            self.assertEqual(manifest["textInputs"], analysis["textInputs"])
            self.assertEqual(manifest["parameterInputs"], analysis["parameterInputs"])
            self.assertEqual(manifest["variants"], analysis["variants"])
            self.assertEqual(stored_variant, variant_workflow)

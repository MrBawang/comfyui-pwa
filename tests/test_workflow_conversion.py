import unittest

from modal_app.workflow_analysis import WorkflowFormatError
from modal_app.workflow_conversion import (
    apply_canvas_model_sources,
    canvas_optional_image_variants,
    canvas_node_package_hints,
    canvas_node_count,
    canvas_node_types,
    convert_workflow_document,
    missing_canvas_nodes,
)


class WorkflowConversionTests(unittest.TestCase):
    def setUp(self):
        self.canvas = {
            "last_node_id": 2,
            "last_link_id": 1,
            "nodes": [
                {
                    "id": 1,
                    "type": "LoadImage",
                    "mode": 0,
                    "inputs": [],
                    "outputs": [
                        {"name": "IMAGE", "type": "IMAGE", "links": [1], "slot_index": 0}
                    ],
                    "widgets_values": ["input.png"],
                    "properties": {"Node name for S&R": "LoadImage"},
                },
                {
                    "id": 2,
                    "type": "SaveImage",
                    "mode": 0,
                    "inputs": [{"name": "images", "type": "IMAGE", "link": 1}],
                    "outputs": [],
                    "widgets_values": ["ComfyUI"],
                    "properties": {"Node name for S&R": "SaveImage"},
                },
            ],
            "links": [[1, 1, 0, 2, 0, "IMAGE"]],
            "groups": [],
            "config": {},
            "extra": {},
            "version": 0.4,
        }
        self.object_info = {
            "LoadImage": {
                "input": {
                    "required": {
                        "image": [["input.png"], {"image_upload": True}],
                    }
                },
                "input_order": {"required": ["image"]},
                "output_node": False,
            },
            "SaveImage": {
                "input": {
                    "required": {
                        "images": ["IMAGE"],
                        "filename_prefix": ["STRING", {"default": "ComfyUI"}],
                    }
                },
                "input_order": {"required": ["images", "filename_prefix"]},
                "output_node": True,
            },
        }

    def test_converts_canvas_widgets_and_links(self):
        workflow, converted = convert_workflow_document(self.canvas, self.object_info)
        self.assertTrue(converted)
        self.assertEqual(workflow["1"]["inputs"]["image"], "input.png")
        self.assertEqual(workflow["2"]["inputs"]["images"], ["1", 0])
        self.assertEqual(workflow["2"]["inputs"]["filename_prefix"], "ComfyUI")

    def test_uses_sageattention_mode_supported_by_the_cloud_runtime(self):
        workflow = {
            "1": {
                "class_type": "PathchSageAttentionKJ",
                "inputs": {
                    "model": ["2", 0],
                    "sage_attention": "sageattn_qk_int8_pv_fp16_cuda",
                    "allow_compile": True,
                },
            },
            "2": {"class_type": "ModelLoader", "inputs": {}},
            "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 1]}},
        }

        adjustments = []
        converted, was_canvas = convert_workflow_document(
            workflow, {}, adjustments
        )

        self.assertFalse(was_canvas)
        self.assertEqual(converted["1"]["inputs"]["sage_attention"], "disabled")
        self.assertFalse(converted["1"]["inputs"]["allow_compile"])
        self.assertEqual(adjustments[0]["code"], "sageattention-disabled")
        self.assertIn("1.0.6", adjustments[0]["message"])

    def test_uses_canvas_widget_names_when_custom_connection_types_shift_schema_mapping(self):
        canvas = {
            "nodes": [
                {
                    "id": 1,
                    "type": "ReelProducer",
                    "mode": 0,
                    "inputs": [],
                    "outputs": [
                        {"name": "reel", "type": "Reel", "links": [1]}
                    ],
                    "widgets_values": [],
                },
                {
                    "id": 2,
                    "type": "ReelComposite",
                    "mode": 0,
                    "inputs": [
                        {"name": "reel", "type": "Reel", "link": 1},
                        {
                            "name": "font_file",
                            "type": "COMBO",
                            "link": None,
                            "widget": {"name": "font_file"},
                        },
                        {
                            "name": "font_size",
                            "type": "INT",
                            "link": None,
                            "widget": {"name": "font_size"},
                        },
                    ],
                    "outputs": [],
                    "widgets_values": ["font.ttf", 40],
                },
            ],
            "links": [[1, 1, 0, 2, 0, "Reel"]],
        }
        object_info = {
            "ReelProducer": {
                "input": {"required": {}},
                "output": ["Reel"],
                "output_node": False,
            },
            "ReelComposite": {
                "input": {
                    "required": {
                        "reel": ["Reel"],
                        "font_file": [["font.ttf"], {}],
                        "font_size": ["INT", {"default": 40}],
                    }
                },
                "input_order": {
                    "required": ["reel", "font_file", "font_size"]
                },
                "output_node": True,
            },
        }

        workflow, _ = convert_workflow_document(canvas, object_info)

        self.assertEqual(workflow["2"]["inputs"]["reel"], ["1", 0])
        self.assertEqual(workflow["2"]["inputs"]["font_file"], "font.ttf")
        self.assertEqual(workflow["2"]["inputs"]["font_size"], 40)

    def test_blocks_conversion_until_nodes_are_installed(self):
        with self.assertRaisesRegex(WorkflowFormatError, "SaveImage"):
            convert_workflow_document(self.canvas, {"LoadImage": self.object_info["LoadImage"]})

    def test_rejects_conversion_with_missing_required_link(self):
        self.canvas["nodes"][1]["inputs"] = []
        self.canvas["links"] = []
        with self.assertRaisesRegex(WorkflowFormatError, "images"):
            convert_workflow_document(self.canvas, self.object_info)

    def test_ignores_ui_only_and_inactive_nodes(self):
        self.canvas["nodes"].extend(
            [
                {"id": 3, "type": "Note", "mode": 0},
                {"id": 4, "type": "MissingButMuted", "mode": 2},
                {"id": 6, "type": "LoadImageOutput", "mode": 0},
                {"id": 7, "type": "Fast Groups Bypasser (rgthree)", "mode": 0},
                {
                    "id": 5,
                    "type": "RenamedDisplayNode",
                    "mode": 0,
                    "properties": {"Node name for S&R": "ActualNode"},
                },
            ]
        )
        self.assertEqual(
            canvas_node_types(self.canvas),
            ["ActualNode", "LoadImage", "SaveImage"],
        )
        self.assertEqual(canvas_node_count(self.canvas), 3)
        self.assertEqual(
            missing_canvas_nodes(self.canvas, {"LoadImage", "SaveImage"}),
            ["ActualNode"],
        )

    def test_omits_extra_frontend_nodes_from_converted_prompt(self):
        self.canvas["nodes"].append(
            {"id": 3, "type": "Fast Groups Bypasser (rgthree)", "mode": 0}
        )
        workflow, _ = convert_workflow_document(self.canvas, self.object_info)
        self.assertNotIn("3", workflow)

    def test_traces_required_input_through_rgthree_reroute(self):
        self.canvas["nodes"].insert(
            1,
            {
                "id": 3,
                "type": "Reroute (rgthree)",
                "mode": 0,
                "inputs": [{"name": "", "type": "*", "link": 1}],
                "outputs": [
                    {"name": "", "type": "*", "links": [2], "slot_index": 0}
                ],
                "properties": {"Node name for S&R": "Reroute"},
            },
        )
        self.canvas["nodes"][2]["inputs"][0]["link"] = 2
        self.canvas["links"] = [
            [1, 1, 0, 3, 0, "IMAGE"],
            [2, 3, 0, 2, 0, "IMAGE"],
        ]

        workflow, _ = convert_workflow_document(self.canvas, self.object_info)

        self.assertEqual(workflow["2"]["inputs"]["images"], ["1", 0])

    def test_preserves_optional_input_through_rgthree_reroute(self):
        self.canvas["nodes"][0]["outputs"][0]["links"] = [1, 2]
        self.canvas["nodes"][1]["inputs"].append(
            {"name": "preview", "type": "IMAGE", "link": 3}
        )
        self.canvas["nodes"].insert(
            1,
            {
                "id": 3,
                "type": "Reroute (rgthree)",
                "mode": 0,
                "inputs": [{"name": "", "type": "*", "link": 2}],
                "outputs": [
                    {"name": "", "type": "*", "links": [3], "slot_index": 0}
                ],
                "properties": {"Node name for S&R": "Reroute (rgthree)"},
            },
        )
        self.canvas["links"] = [
            [1, 1, 0, 2, 0, "IMAGE"],
            [2, 1, 0, 3, 0, "IMAGE"],
            [3, 3, 0, 2, 1, "IMAGE"],
        ]
        self.object_info["SaveImage"]["input"]["optional"] = {
            "preview": ["IMAGE"]
        }
        self.object_info["SaveImage"]["input_order"]["optional"] = ["preview"]

        workflow, _ = convert_workflow_document(self.canvas, self.object_info)

        self.assertEqual(workflow["2"]["inputs"]["preview"], ["1", 0])

    def test_checks_nodes_inside_subgraphs_without_reporting_instance_id(self):
        subgraph_id = "12345678-1234-1234-1234-123456789abc"
        canvas = {
            "nodes": [{"id": 1, "type": subgraph_id, "mode": 0}],
            "links": [],
            "definitions": {
                "subgraphs": [
                    {
                        "id": subgraph_id,
                        "nodes": [{"id": 10, "type": "SubgraphCustomNode", "mode": 0}],
                        "links": [],
                    }
                ]
            },
        }
        self.assertEqual(canvas_node_types(canvas), ["SubgraphCustomNode"])
        self.assertEqual(missing_canvas_nodes(canvas, set()), ["SubgraphCustomNode"])

    def test_extracts_registry_package_hint_and_version_from_canvas_node(self):
        self.canvas["nodes"].append(
            {
                "id": 3,
                "type": "LayerUtility: ImageScaleByAspectRatio V2",
                "mode": 0,
                "properties": {
                    "Node name for S&R": "LayerUtility: ImageScaleByAspectRatio V2",
                    "cnr_id": "comfyui_layerstyle",
                    "ver": "1.0.90",
                },
            }
        )
        self.assertEqual(
            canvas_node_package_hints(
                self.canvas, ["LayerUtility: ImageScaleByAspectRatio V2"]
            ),
            {
                "LayerUtility: ImageScaleByAspectRatio V2": [
                    "comfyui_layerstyle@1.0.90"
                ]
            },
        )

    def test_applies_hugging_face_model_source_from_canvas_metadata(self):
        self.canvas["nodes"][0]["properties"]["models"] = [
            {
                "name": "flux2-vae.safetensors",
                "directory": "vae",
                "url": "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors",
            }
        ]
        models = [
            {
                "category": "vae",
                "filename": "flux2-vae.safetensors",
                "status": "missing",
                "nodes": [{"nodeId": "1", "input": "vae_name"}],
            }
        ]

        apply_canvas_model_sources(models, self.canvas)

        self.assertEqual(
            models[0]["source"],
            {
                "kind": "huggingface",
                "repoId": "Comfy-Org/flux2-dev",
                "repoFile": "split_files/vae/flux2-vae.safetensors",
                "revision": "main",
                "origin": "workflow-metadata",
            },
        )

    def test_does_not_apply_ambiguous_or_non_hugging_face_model_sources(self):
        self.canvas["nodes"][0]["properties"]["models"] = [
            {
                "name": "model.safetensors",
                "url": "https://huggingface.co/owner/first/resolve/main/model.safetensors",
            },
            {
                "name": "model.safetensors",
                "url": "https://huggingface.co/owner/second/resolve/main/model.safetensors",
            },
            {
                "name": "other.safetensors",
                "url": "https://example.com/other.safetensors",
            },
            {
                "name": "mismatch.safetensors",
                "url": "https://huggingface.co/owner/repo/resolve/main/different.safetensors",
            },
        ]
        models = [
            {"category": "vae", "filename": "model.safetensors", "nodes": []},
            {"category": "vae", "filename": "other.safetensors", "nodes": []},
            {"category": "vae", "filename": "mismatch.safetensors", "nodes": []},
        ]

        apply_canvas_model_sources(models, self.canvas)

        self.assertNotIn("source", models[0])
        self.assertNotIn("source", models[1])
        self.assertNotIn("source", models[2])

    def test_builds_optional_image_variant_from_bypassed_path_to_active_graph(self):
        self.canvas["nodes"].extend(
            [
                {
                    "id": 3,
                    "type": "LoadImage",
                    "mode": 4,
                    "pos": [20, 220],
                    "size": [120, 80],
                    "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [2]}],
                },
                {
                    "id": 4,
                    "type": "OptionalPreprocessor",
                    "mode": 4,
                    "pos": [180, 220],
                    "size": [120, 80],
                    "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [3, 4]}],
                },
                {
                    "id": 5,
                    "type": "DeadOptionalNode",
                    "mode": 4,
                    "pos": [340, 320],
                    "size": [120, 80],
                    "outputs": [],
                },
            ]
        )
        self.canvas["links"].extend(
            [
                [2, 3, 0, 4, 0, "IMAGE"],
                [3, 4, 0, 2, 0, "IMAGE"],
                [4, 4, 0, 5, 0, "IMAGE"],
            ]
        )
        self.canvas["groups"] = [
            {
                "id": 10,
                "title": "双图可选▼",
                "bounding": [10, 100, 140, 80],
            },
            {
                "id": 11,
                "title": "②上传图像-B",
                "bounding": [10, 200, 470, 110],
            },
        ]

        variants = canvas_optional_image_variants(self.canvas)

        self.assertEqual(len(variants), 1)
        self.assertEqual(variants[0]["id"], "optional-image-3")
        self.assertEqual(variants[0]["name"], "双图")
        modes = {node["id"]: node.get("mode", 0) for node in variants[0]["canvas"]["nodes"]}
        self.assertEqual(modes[3], 0)
        self.assertEqual(modes[4], 0)
        self.assertEqual(modes[5], 4)

    def test_limits_automatically_generated_optional_image_variants(self):
        canvas = {
            "nodes": [
                {"id": 100, "type": "SaveImage", "mode": 0},
                *[
                    {"id": node_id, "type": "LoadImage", "mode": 4}
                    for node_id in range(1, 11)
                ],
            ],
            "links": [
                [node_id, node_id, 0, 100, node_id, "IMAGE"]
                for node_id in range(1, 11)
            ],
            "groups": [],
        }

        variants = canvas_optional_image_variants(canvas)

        self.assertEqual(len(variants), 8)

    def test_generates_storage_safe_variant_id_for_arbitrary_canvas_node_id(self):
        unsafe_id = "Input B / " + "X" * 100
        canvas = {
            "nodes": [
                {"id": 100, "type": "SaveImage", "mode": 0},
                {"id": unsafe_id, "type": "LoadImage", "mode": 4},
            ],
            "links": [[1, unsafe_id, 0, 100, 0, "IMAGE"]],
            "groups": [],
        }

        variants = canvas_optional_image_variants(canvas)

        self.assertEqual(len(variants), 1)
        self.assertRegex(variants[0]["id"], r"^[a-z0-9][a-z0-9_-]{0,63}$")


if __name__ == "__main__":
    unittest.main()

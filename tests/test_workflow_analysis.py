import unittest

from modal_app.workflow_analysis import (
    WorkflowFormatError,
    analyze_workflow,
    coerce_runtime_parameter_value,
    merge_workflow_resource_findings,
    validate_api_workflow,
)


class WorkflowAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.workflow = {
            "1": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "sdxl/base.safetensors"},
            },
            "2": {
                "class_type": "AcmeCustomNode",
                "inputs": {"model": ["1", 0]},
            },
            "3": {
                "class_type": "LoadImage",
                "inputs": {"image": "source.png"},
            },
            "4": {
                "class_type": "SaveImage",
                "inputs": {"images": ["2", 0], "filename_prefix": "output"},
            },
        }

    def test_rejects_canvas_workflow(self):
        with self.assertRaisesRegex(WorkflowFormatError, "云端转换"):
            validate_api_workflow({"nodes": []})

    def test_reports_missing_nodes_models_and_runtime_inputs(self):
        result = analyze_workflow(
            self.workflow,
            installed_nodes={"CheckpointLoaderSimple", "LoadImage", "SaveImage"},
            model_exists=lambda _category, _filename: False,
        )
        self.assertEqual(result["missingNodes"], ["AcmeCustomNode"])
        self.assertEqual(result["models"][0]["status"], "missing")
        self.assertEqual(result["imageInputs"][0]["fieldName"], "asset_3_image")
        self.assertFalse(result["runnable"])

    def test_becomes_runnable_when_resources_exist(self):
        result = analyze_workflow(
            self.workflow,
            installed_nodes={
                "CheckpointLoaderSimple",
                "AcmeCustomNode",
                "LoadImage",
                "SaveImage",
            },
            model_exists=lambda _category, _filename: True,
        )
        self.assertTrue(result["runnable"])

    def test_exposes_supported_camera_controls_without_exposing_internal_parameters(self):
        workflow = {
            "217": {
                "class_type": "QwenMultiangleCameraNode",
                "inputs": {
                    "horizontal_angle": 270,
                    "vertical_angle": 0,
                    "zoom": 8,
                    "default_prompts": True,
                    "camera_view": False,
                    "internal_seed": 123,
                },
            },
            "218": {"class_type": "SaveImage", "inputs": {"images": ["217", 0]}},
        }
        node_info = {
            "QwenMultiangleCameraNode": {
                "input": {
                    "required": {
                        "horizontal_angle": ["INT", {"min": 0, "max": 360, "step": 15}],
                        "vertical_angle": ["INT", {"min": -90, "max": 90, "step": 15}],
                        "zoom": ["INT", {"min": 0, "max": 10}],
                        "default_prompts": ["BOOLEAN"],
                        "camera_view": ["BOOLEAN"],
                        "internal_seed": ["INT"],
                    }
                },
                "output": ["IMAGE"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
        )

        self.assertEqual(
            [item["inputName"] for item in result["parameterInputs"]],
            ["horizontal_angle", "vertical_angle", "zoom"],
        )
        horizontal = next(item for item in result["parameterInputs"] if item["inputName"] == "horizontal_angle")
        self.assertEqual(horizontal["label"], "水平角度")
        self.assertEqual((horizontal["minimum"], horizontal["maximum"], horizontal["step"]), (0, 360, 15))
        self.assertEqual(coerce_runtime_parameter_value(horizontal, "315"), 315)
        with self.assertRaisesRegex(ValueError, "不能大于"):
            coerce_runtime_parameter_value(horizontal, "361")

    def test_labels_prompt_by_its_downstream_sampler_role(self):
        workflow = {
            "1": {"class_type": "TextEncode", "inputs": {"prompt": ""}},
            "2": {"class_type": "ConditioningTransform", "inputs": {"conditioning": ["1", 0]}},
            "3": {"class_type": "KSampler", "inputs": {"negative": ["2", 0]}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
        }
        node_info = {
            "TextEncode": {
                "input": {"required": {"prompt": ["STRING", {"multiline": True}]}},
                "output": ["CONDITIONING"],
                "output_node": False,
            },
            "ConditioningTransform": {
                "input": {"required": {"conditioning": ["CONDITIONING"]}},
                "output": ["CONDITIONING"],
                "output_node": False,
            },
            "KSampler": {
                "input": {"required": {"negative": ["CONDITIONING"]}},
                "output": ["IMAGE"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
        )

        self.assertEqual(result["textInputs"][0]["label"], "负面提示词")

    def test_rejects_model_path_traversal(self):
        self.workflow["1"]["inputs"]["ckpt_name"] = "../../secret"
        with self.assertRaisesRegex(WorkflowFormatError, "不安全"):
            analyze_workflow(self.workflow)

    def test_uses_object_info_for_custom_uploads_and_outputs(self):
        workflow = {
            "1": {"class_type": "CustomUpload", "inputs": {"source": "old.png"}},
            "2": {"class_type": "PreviewImage", "inputs": {"images": ["1", 0]}},
        }
        node_info = {
            "CustomUpload": {
                "input": {
                    "required": {
                        "source": [["old.png"], {"image_upload": True, "image_folder": "temp"}]
                    }
                },
                "output_node": False,
            },
            "PreviewImage": {"input": {"required": {}}, "output_node": True},
        }
        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
        )
        self.assertEqual(result["imageInputs"][0]["inputName"], "source")
        self.assertEqual(result["imageInputs"][0]["folder"], "temp")
        self.assertEqual(result["outputNodes"], ["2"])
        self.assertTrue(result["runnable"])

    def test_rejects_missing_required_inputs_and_broken_links(self):
        workflow = {
            "1": {"class_type": "Producer", "inputs": {}},
            "2": {"class_type": "SaveImage", "inputs": {"images": ["404", 0]}},
        }
        node_info = {
            "Producer": {
                "input": {"required": {"value": ["STRING"]}},
                "output": ["IMAGE"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
        )

        self.assertFalse(result["runnable"])
        self.assertTrue(any("必填输入" in issue for issue in result["issues"]))
        self.assertTrue(any("不存在的节点" in issue for issue in result["issues"]))

    def test_rejects_unsupported_combo_before_gpu_submission(self):
        workflow = {
            "99": {
                "class_type": "KSamplerSelect",
                "inputs": {"sampler_name": "res_2m"},
            },
            "223": {
                "class_type": "SaveImage",
                "inputs": {"images": ["99", 0]},
            },
        }
        node_info = {
            "KSamplerSelect": {
                "input": {
                    "required": {
                        "sampler_name": [
                            "COMBO",
                            {"options": ["euler", "res_multistep"]},
                        ]
                    }
                },
                "output": ["SAMPLER"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
        )

        self.assertFalse(result["runnable"])
        self.assertEqual(result["unsupportedInputs"][0]["value"], "res_2m")
        self.assertEqual(
            result["missingRuntimePackages"][0]["registryId"], "RES4LYF"
        )

    def test_reports_missing_sageattention_runtime_extension(self):
        workflow = {
            "1": {
                "class_type": "PathchSageAttentionKJ",
                "inputs": {
                    "model": ["3", 0],
                    "sage_attention": "auto",
                    "allow_compile": True,
                },
            },
            "2": {"class_type": "SaveImage", "inputs": {"images": ["3", 1]}},
            "3": {"class_type": "Producer", "inputs": {}},
        }
        node_info = {
            "PathchSageAttentionKJ": {
                "input": {
                    "required": {
                        "model": ["MODEL"],
                        "sage_attention": [["disabled", "auto"], {}],
                    },
                    "optional": {"allow_compile": ["BOOLEAN"]},
                },
                "output": ["MODEL"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
            "Producer": {
                "input": {"required": {}},
                "output": ["MODEL", "IMAGE"],
                "output_node": False,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
            runtime_dependency_exists=lambda _module: False,
        )

        self.assertFalse(result["runnable"])
        self.assertEqual(
            result["missingRuntimePackages"],
            [
                {
                    "kind": "python",
                    "packageId": "sageattention",
                    "name": "SageAttention",
                    "version": "1.0.6",
                    "nodeTypes": ["PathchSageAttentionKJ"],
                }
            ],
        )

    def test_dynamic_sageattention_input_is_checked_without_crashing(self):
        workflow = {
            "1": {"class_type": "PrimitiveString", "inputs": {}},
            "2": {
                "class_type": "PathchSageAttentionKJ",
                "inputs": {"model": ["3", 0], "sage_attention": ["1", 0]},
            },
            "3": {"class_type": "Producer", "inputs": {}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 1]}},
        }
        node_info = {
            "PrimitiveString": {
                "input": {"required": {}},
                "output": ["STRING"],
                "output_node": False,
            },
            "PathchSageAttentionKJ": {
                "input": {
                    "required": {
                        "model": ["MODEL"],
                        "sage_attention": [["disabled", "auto"], {}],
                    }
                },
                "output": ["MODEL"],
                "output_node": False,
            },
            "Producer": {
                "input": {"required": {}},
                "output": ["MODEL", "IMAGE"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            node_info=node_info,
            runtime_dependency_exists=lambda _module: False,
        )

        self.assertFalse(result["runnable"])
        self.assertEqual(
            result["missingRuntimePackages"][0]["packageId"], "sageattention"
        )

    def test_accepts_disabled_or_installed_sageattention_runtime_extension(self):
        workflow = {
            "1": {
                "class_type": "PathchSageAttentionKJ",
                "inputs": {"model": ["3", 0], "sage_attention": "disabled"},
            },
            "2": {"class_type": "SaveImage", "inputs": {"images": ["3", 1]}},
            "3": {"class_type": "Producer", "inputs": {}},
        }
        node_info = {
            "PathchSageAttentionKJ": {
                "input": {
                    "required": {
                        "model": ["MODEL"],
                        "sage_attention": [["disabled", "auto"], {}],
                    }
                },
                "output": ["MODEL"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
            "Producer": {
                "input": {"required": {}},
                "output": ["MODEL", "IMAGE"],
                "output_node": False,
            },
        }

        disabled = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            node_info=node_info,
            runtime_dependency_exists=lambda _module: False,
        )
        enabled_workflow = {
            **workflow,
            "1": {
                **workflow["1"],
                "inputs": {**workflow["1"]["inputs"], "sage_attention": "auto"},
            },
        }
        installed = analyze_workflow(
            enabled_workflow,
            installed_nodes=set(node_info),
            node_info=node_info,
            runtime_dependency_exists=lambda module: module == "sageattention",
        )

        self.assertTrue(disabled["runnable"])
        self.assertTrue(installed["runnable"])
        self.assertEqual(disabled["missingRuntimePackages"], [])
        self.assertEqual(installed["missingRuntimePackages"], [])

    def test_accepts_combo_value_from_legacy_object_info_shape(self):
        workflow = {
            "1": {"class_type": "Choice", "inputs": {"value": "two"}},
            "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        node_info = {
            "Choice": {
                "input": {"required": {"value": [["one", "two"], {}]}},
                "output": ["IMAGE"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
        )

        self.assertTrue(result["runnable"])
        self.assertEqual(result["unsupportedInputs"], [])

    def test_does_not_treat_dynamic_model_and_upload_lists_as_enums(self):
        workflow = {
            "1": {
                "class_type": "UnetLoaderGGUF",
                "inputs": {"unet_name": "downloaded.gguf"},
            },
            "2": {
                "class_type": "LoadImage",
                "inputs": {"image": "uploaded.png"},
            },
            "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
        }
        node_info = {
            "UnetLoaderGGUF": {
                "input": {
                    "required": {
                        "unet_name": ["COMBO", {"options": ["cached.gguf"]}]
                    }
                },
                "output": ["MODEL"],
                "output_node": False,
            },
            "LoadImage": {
                "input": {
                    "required": {
                        "image": [
                            "COMBO",
                            {"options": ["example.png"], "image_upload": True},
                        ]
                    }
                },
                "output": ["IMAGE"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {"required": {"images": ["IMAGE"]}},
                "output_node": True,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
        )

        self.assertTrue(result["runnable"])
        self.assertEqual(result["unsupportedInputs"], [])

    def test_exposes_prompt_text_without_exposing_output_filenames(self):
        workflow = {
            "1": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "原始提示词", "clip": ["3", 0]},
            },
            "2": {
                "class_type": "SaveImage",
                "inputs": {"images": ["3", 0], "filename_prefix": "output"},
            },
            "3": {"class_type": "Producer", "inputs": {}},
        }
        node_info = {
            "CLIPTextEncode": {
                "input": {
                    "required": {
                        "text": ["STRING", {"multiline": True}],
                        "clip": ["CLIP"],
                    }
                },
                "output": ["CONDITIONING"],
                "output_node": False,
            },
            "SaveImage": {
                "input": {
                    "required": {
                        "images": ["IMAGE"],
                        "filename_prefix": ["STRING"],
                    }
                },
                "output_node": True,
            },
            "Producer": {
                "input": {"required": {}},
                "output": ["CLIP", "IMAGE"],
                "output_node": False,
            },
        }

        result = analyze_workflow(
            workflow,
            installed_nodes=set(node_info),
            model_exists=lambda _category, _filename: True,
            node_info=node_info,
        )

        self.assertEqual(
            result["textInputs"],
            [
                {
                    "nodeId": "1",
                    "classType": "CLIPTextEncode",
                    "inputName": "text",
                    "fieldName": "param_1_text",
                    "label": "提示词",
                    "currentValue": "原始提示词",
                    "multiline": True,
                }
            ],
        )

    def test_merges_optional_variant_resource_findings(self):
        target = {
            "missingNodes": [],
            "models": [
                {
                    "category": "vae",
                    "filename": "shared.safetensors",
                    "status": "present",
                    "nodes": [{"nodeId": "1", "input": "vae_name"}],
                }
            ],
        }
        source = {
            "missingNodes": ["OptionalNode"],
            "models": [
                {
                    "category": "vae",
                    "filename": "shared.safetensors",
                    "status": "missing",
                    "nodes": [{"nodeId": "8", "input": "vae_name"}],
                    "source": {"kind": "huggingface"},
                },
                {
                    "category": "controlnet",
                    "filename": "optional.safetensors",
                    "status": "missing",
                    "nodes": [],
                },
            ],
            "missingNodePackages": [
                {
                    "kind": "registry",
                    "registryId": "optional-pack",
                    "repository": "https://example.com/optional-pack",
                    "nodeTypes": ["OptionalNode"],
                }
            ],
            "unresolvedNodes": ["ManualNode"],
        }

        merge_workflow_resource_findings(target, source)

        self.assertEqual(target["missingNodes"], ["OptionalNode"])
        self.assertEqual(target["unresolvedNodes"], ["ManualNode"])
        self.assertEqual(len(target["models"]), 2)
        self.assertEqual(target["models"][1]["status"], "missing")
        self.assertEqual(len(target["models"][1]["nodes"]), 2)
        self.assertEqual(target["missingNodePackages"][0]["nodeTypes"], ["OptionalNode"])


if __name__ == "__main__":
    unittest.main()

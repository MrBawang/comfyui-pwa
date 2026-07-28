import unittest

from modal_app.registry_lookup import (
    _repository_indexes,
    resolve_node_packages_from_catalog,
    with_node_package_lookup_failure,
)


class RegistryLookupTests(unittest.TestCase):
    def setUp(self):
        self.node_map = {
            "https://github.com/comfyanonymous/ComfyUI": [
                ["EmptyFlux2LatentImage", "Flux2Scheduler"]
            ],
            "https://github.com/cubiq/ComfyUI_essentials": [["ImageSmartSharpen+"]],
            "https://github.com/rgthree/rgthree-comfy": [["RgthreeImageComparer"]],
        }
        self.registry_nodes = {
            "ComfyUI_essentials": [
                {
                    "id": "comfyui_essentials",
                    "name": "ComfyUI_essentials",
                    "repository": "https://github.com/cubiq/ComfyUI_essentials",
                    "latest_version": {"version": "1.1.0"},
                }
            ],
            "rgthree-comfy": [
                {
                    "id": "rgthree-comfy",
                    "name": "rgthree-comfy",
                    "repository": "https://github.com/rgthree/rgthree-comfy",
                    "latest_version": {"version": "1.0.0"},
                }
            ],
            "rgthree": [
                {
                    "id": "rgthree-comfy",
                    "name": "rgthree-comfy",
                    "repository": "https://github.com/rgthree/rgthree-comfy",
                    "latest_version": {"version": "1.0.0"},
                }
            ],
        }

    def test_groups_node_types_by_installable_package_and_core(self):
        result = resolve_node_packages_from_catalog(
            [
                "EmptyFlux2LatentImage",
                "Flux2Scheduler",
                "Image Comparer (rgthree)",
                "ImageSmartSharpen+",
            ],
            _repository_indexes(self.node_map),
            lambda query: self.registry_nodes.get(query, []),
        )
        packages = result["missingNodePackages"]
        self.assertEqual([item["kind"] for item in packages], ["registry", "core"])
        self.assertEqual(packages[1]["nodeTypes"], ["EmptyFlux2LatentImage", "Flux2Scheduler"])
        self.assertEqual(
            result["suggestedNodePackages"][0]["registryId"], "rgthree-comfy"
        )
        self.assertEqual(result["unresolvedNodes"], [])
        self.assertEqual(result["nodePackageLookupStatus"], "ready")

    def test_marks_parenthetical_publisher_match_as_low_confidence(self):
        result = resolve_node_packages_from_catalog(
            ["Fast Groups Bypasser (rgthree)"],
            _repository_indexes(self.node_map),
            lambda query: self.registry_nodes.get(query, []),
        )
        self.assertEqual(result["missingNodePackages"], [])
        suggestion = result["suggestedNodePackages"][0]
        self.assertEqual(suggestion["registryId"], "rgthree-comfy")
        self.assertEqual(suggestion["confidence"], "low")
        self.assertEqual(suggestion["source"], "node-name-heuristic")

    def test_marks_reordered_name_tokens_as_low_confidence(self):
        indexes = _repository_indexes(
            {"https://github.com/example/image-tools": [["Image Smart Sharpen"]]}
        )
        registry = [
            {
                "id": "image-tools",
                "name": "image-tools",
                "repository": "https://github.com/example/image-tools",
                "latest_version": {"version": "1.0.0"},
            }
        ]

        result = resolve_node_packages_from_catalog(
            ["Sharpen Smart Image"], indexes, lambda _query: registry
        )

        self.assertEqual(result["missingNodePackages"], [])
        self.assertEqual(
            result["suggestedNodePackages"][0]["registryId"], "image-tools"
        )

    def test_does_not_present_marker_prefix_match_as_verified(self):
        result = resolve_node_packages_from_catalog(
            ["Arbitrary Node (foo)"],
            _repository_indexes(self.node_map),
            lambda _query: [
                {
                    "id": "foo-tools-pro",
                    "name": "foo tools pro",
                    "repository": "https://github.com/unrelated/foo-tools-pro",
                    "latest_version": {"version": "9.9.9"},
                }
            ],
        )

        self.assertEqual(result["missingNodePackages"], [])
        self.assertEqual(
            result["suggestedNodePackages"][0]["registryId"], "foo-tools-pro"
        )

    def test_leaves_ambiguous_or_unknown_nodes_unresolved(self):
        result = resolve_node_packages_from_catalog(
            ["UnknownNode"],
            _repository_indexes(self.node_map),
            lambda _query: [],
        )
        self.assertEqual(result["missingNodePackages"], [])
        self.assertEqual(result["suggestedNodePackages"], [])
        self.assertEqual(result["unresolvedNodes"], ["UnknownNode"])

    def test_uses_canvas_registry_metadata_for_ambiguous_node(self):
        node_type = "LayerUtility: ImageScaleByAspectRatio V2"
        indexes = _repository_indexes(
            {
                "https://github.com/aining2022/ComfyUI_Swwan": [[node_type]],
                "https://github.com/chflame163/ComfyUI_LayerStyle": [[node_type]],
            }
        )
        registry = {
            "comfyui_layerstyle": [
                {
                    "id": "comfyui_layerstyle",
                    "name": "ComfyUI_LayerStyle",
                    "repository": "https://github.com/chflame163/ComfyUI_LayerStyle",
                    "latest_version": {"version": "1.0.91"},
                }
            ]
        }

        result = resolve_node_packages_from_catalog(
            [node_type],
            indexes,
            lambda query: registry.get(query, []),
            {node_type: ["comfyui_layerstyle@1.0.90"]},
            lambda _node_id: frozenset({"1.0.90", "1.0.91"}),
        )

        package = result["missingNodePackages"][0]
        self.assertEqual(package["registryId"], "comfyui_layerstyle")
        self.assertEqual(package["version"], "1.0.90")
        self.assertEqual(result["suggestedNodePackages"], [])
        self.assertEqual(result["unresolvedNodes"], [])

    def test_preserves_git_commit_hint_as_fixed_source_revision(self):
        node_type = "easy imageColorMatch"
        package = {
            "id": "comfyui-easy-use",
            "name": "ComfyUI-Easy-Use",
            "repository": "https://github.com/yolain/ComfyUI-Easy-Use",
            "latest_version": {"version": "1.3.6"},
        }

        result = resolve_node_packages_from_catalog(
            [node_type],
            _repository_indexes({package["repository"]: [[node_type]]}),
            lambda _query: [package],
            {node_type: ["comfyui-easy-use@ec4ca6717f539a8b8c48fa88645045846ca47669"]},
            lambda _node_id: frozenset({"1.3.5", "1.3.6"}),
        )

        self.assertEqual(
            result["missingNodePackages"][0]["version"], "1.3.6"
        )
        self.assertEqual(
            result["missingNodePackages"][0]["sourceRevision"],
            "ec4ca6717f539a8b8c48fa88645045846ca47669",
        )

    def test_registry_version_lookup_failure_falls_back_to_latest(self):
        node_type = "ImageSmartSharpen+"
        package = self.registry_nodes["ComfyUI_essentials"][0]

        def unavailable(_node_id: str) -> frozenset[str]:
            raise ValueError("temporary failure")

        result = resolve_node_packages_from_catalog(
            [node_type],
            _repository_indexes(self.node_map),
            lambda query: self.registry_nodes.get(query, []),
            {node_type: ["comfyui_essentials@9d9f4bedfc9f0321c19faf71855e228c93bd0dc9"]},
            unavailable,
        )

        self.assertEqual(
            result["missingNodePackages"][0]["version"],
            package["latest_version"]["version"],
        )

    def test_offers_registry_candidates_for_ambiguous_manager_mapping(self):
        node_type = "LayerUtility: ImageScaleByAspectRatio V2"
        indexes = _repository_indexes(
            {
                "https://github.com/aining2022/ComfyUI_Swwan": [[node_type]],
                "https://github.com/chflame163/ComfyUI_LayerStyle": [[node_type]],
            }
        )
        package = {
            "id": "comfyui_layerstyle",
            "name": "ComfyUI_LayerStyle",
            "repository": "https://github.com/chflame163/ComfyUI_LayerStyle",
            "latest_version": {"version": "1.0.90"},
        }

        result = resolve_node_packages_from_catalog(
            [node_type],
            indexes,
            lambda query: [package] if query == "ComfyUI_LayerStyle" else [],
        )

        suggestion = result["suggestedNodePackages"][0]
        self.assertEqual(suggestion["registryId"], "comfyui_layerstyle")
        self.assertEqual(suggestion["source"], "ambiguous-manager-map")
        self.assertEqual(result["unresolvedNodes"], [])

    def test_builds_failed_lookup_result_without_mutating_analysis(self):
        analysis = {
            "missingNodes": ["UnknownNode"],
            "assetVersion": "revision-1",
        }

        result = with_node_package_lookup_failure(analysis, ["UnknownNode"])

        self.assertNotIn("nodePackageLookupStatus", analysis)
        self.assertEqual(result["assetVersion"], "revision-1")
        self.assertEqual(result["missingNodePackages"], [])
        self.assertEqual(result["suggestedNodePackages"], [])
        self.assertEqual(result["unresolvedNodes"], ["UnknownNode"])
        self.assertEqual(result["nodePackageLookupStatus"], "failed")
        self.assertIn("重新检查", result["nodePackageLookupMessage"])


if __name__ == "__main__":
    unittest.main()

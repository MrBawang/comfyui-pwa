import unittest

from modal_app.workflow_outputs import (
    final_history_file_entries,
    history_file_entries,
    preferred_upscale_output_nodes,
)


class ComfyOutputTests(unittest.TestCase):
    def test_collects_nested_history_files_once(self):
        history = {
            "outputs": {
                "9": {
                    "images": [
                        {"filename": "one.png", "subfolder": "batch", "type": "output"},
                        {"filename": "two.png", "subfolder": "batch", "type": "output"},
                    ],
                    "duplicate": {"filename": "one.png", "subfolder": "batch", "type": "output"},
                },
                "10": {
                    "video": {"filename": "clip.mp4", "subfolder": "", "type": "output"}
                },
            }
        }
        result = history_file_entries(history)
        self.assertEqual([item["filename"] for item in result], ["one.png", "two.png", "clip.mp4"])
        self.assertEqual(result[0]["nodeId"], "9")

    def test_ignores_non_file_history_values(self):
        self.assertEqual(history_file_entries({"outputs": {"1": {"value": 42}}}), [])

    def test_returns_only_formal_outputs_when_previews_are_present(self):
        history = {
            "outputs": {
                "17": {
                    "images": [
                        {"filename": "final.png", "subfolder": "job", "type": "output"}
                    ]
                },
                "19": {
                    "images": [
                        {"filename": "compare-a.png", "subfolder": "", "type": "temp"},
                        {"filename": "compare-b.png", "subfolder": "", "type": "temp"},
                    ]
                },
                "33": {
                    "images": [
                        {"filename": "preview.png", "subfolder": "", "type": "temp"}
                    ]
                },
            }
        }

        self.assertEqual(
            [item["filename"] for item in final_history_file_entries(history)],
            ["final.png"],
        )

    def test_falls_back_to_temp_files_without_formal_output(self):
        history = {
            "outputs": {
                "1": {
                    "images": [
                        {"filename": "preview.png", "subfolder": "", "type": "temp"}
                    ]
                }
            }
        }

        self.assertEqual(
            [item["filename"] for item in final_history_file_entries(history)],
            ["preview.png"],
        )

    def test_prefers_the_save_node_after_an_upscale_branch(self):
        workflow = {
            "10": {"class_type": "KSampler", "inputs": {}},
            "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0]}},
            "12": {
                "class_type": "UltimateSDUpscale",
                "inputs": {"image": ["10", 0]},
            },
            "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0]}},
        }
        history = {
            "outputs": {
                "11": {"images": [{"filename": "base.png", "type": "output"}]},
                "13": {"images": [{"filename": "upscale.png", "type": "output"}]},
            }
        }

        preferred = preferred_upscale_output_nodes(workflow, ["11", "13"])
        self.assertEqual(preferred, {"13"})
        self.assertEqual(
            [item["filename"] for item in final_history_file_entries(history, preferred)],
            ["upscale.png"],
        )

    def test_krea2_keeps_only_the_final_ultimate_upscale_output(self):
        workflow = {
            "156": {"class_type": "KSampler", "inputs": {}},
            "203": {
                "class_type": "LatentUpscaleBy",
                "inputs": {"samples": ["156", 0]},
            },
            "270": {"class_type": "VAEDecode", "inputs": {"samples": ["203", 0]}},
            "271": {"class_type": "SaveImage", "inputs": {"images": ["270", 0]}},
            "284": {
                "class_type": "UltimateSDUpscale",
                "inputs": {"image": ["270", 0]},
            },
            "285": {"class_type": "SaveImage", "inputs": {"images": ["284", 0]}},
        }
        history = {
            "outputs": {
                "271": {"images": [{"filename": "Krea2-2ST.png", "type": "output"}]},
                "285": {"images": [{"filename": "Krea2-USD.png", "type": "output"}]},
            }
        }

        preferred = preferred_upscale_output_nodes(workflow, ["271", "285"])
        self.assertEqual(preferred, {"285"})
        self.assertEqual(
            [item["filename"] for item in final_history_file_entries(history, preferred)],
            ["Krea2-USD.png"],
        )


if __name__ == "__main__":
    unittest.main()

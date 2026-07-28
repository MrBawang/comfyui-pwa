import unittest

from modal_app.workflow_outputs import final_history_file_entries, history_file_entries


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


if __name__ == "__main__":
    unittest.main()

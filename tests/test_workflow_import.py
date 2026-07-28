import json
import unittest
from io import BytesIO

from PIL import Image, PngImagePlugin

from modal_app.workflow_analysis import WorkflowFormatError
from modal_app.workflow_import import load_workflow_document


class WorkflowImportTests(unittest.TestCase):
    def setUp(self):
        self.workflow = {
            "1": {"class_type": "LoadImage", "inputs": {"image": "input.png"}},
            "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }

    def png_with_metadata(self, **metadata):
        info = PngImagePlugin.PngInfo()
        for key, value in metadata.items():
            info.add_text(key, value)
        output = BytesIO()
        Image.new("RGB", (2, 2)).save(output, format="PNG", pnginfo=info)
        return output.getvalue()

    def webp_with_user_comment(self, value):
        exif = Image.Exif()
        exif[0x9286] = value
        output = BytesIO()
        Image.new("RGB", (2, 2)).save(output, format="WEBP", exif=exif)
        return output.getvalue()

    def test_loads_api_json(self):
        result = load_workflow_document(json.dumps(self.workflow).encode(), "workflow.json")
        self.assertEqual(set(result), {"1", "2"})

    def test_loads_canvas_json_for_cloud_conversion(self):
        canvas = {
            "nodes": [{"id": 1, "type": "LoadImage", "widgets_values": ["input.png"]}],
            "links": [],
        }
        result = load_workflow_document(json.dumps(canvas).encode(), "workflow.json")
        self.assertEqual(result["nodes"][0]["type"], "LoadImage")

    def test_loads_prompt_from_png(self):
        image = self.png_with_metadata(prompt=json.dumps(self.workflow))
        result = load_workflow_document(image, "generated.png")
        self.assertEqual(result["2"]["class_type"], "SaveImage")

    def test_loads_ascii_prompt_from_webp(self):
        prompt = b"ASCII\x00\x00\x00" + json.dumps(self.workflow).encode("utf-8")
        result = load_workflow_document(self.webp_with_user_comment(prompt), "generated.webp")
        self.assertEqual(result["2"]["class_type"], "SaveImage")

    def test_loads_unicode_prompt_from_webp(self):
        prompt = b"UNICODE\x00" + json.dumps(self.workflow).encode("utf-16")
        result = load_workflow_document(self.webp_with_user_comment(prompt), "generated.webp")
        self.assertEqual(result["2"]["class_type"], "SaveImage")

    def test_rejects_canvas_only_png(self):
        image = self.png_with_metadata(workflow=json.dumps({"nodes": []}))
        with self.assertRaisesRegex(WorkflowFormatError, "没有可执行的 prompt"):
            load_workflow_document(image, "generated.png")

    def test_rejects_image_without_metadata(self):
        output = BytesIO()
        Image.new("RGB", (2, 2)).save(output, format="WEBP")
        with self.assertRaisesRegex(WorkflowFormatError, "没有找到"):
            load_workflow_document(output.getvalue(), "generated.webp")

    def test_rejects_canvas_without_links(self):
        canvas = {"nodes": [{"id": 1, "type": "LoadImage"}]}
        with self.assertRaisesRegex(WorkflowFormatError, "links"):
            load_workflow_document(json.dumps(canvas).encode(), "workflow.json")


if __name__ == "__main__":
    unittest.main()

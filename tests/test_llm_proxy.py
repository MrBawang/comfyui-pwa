import unittest

from fastapi import HTTPException

from modal_app.llm_proxy import _validated_payload


class LlmProxyTests(unittest.TestCase):
    def test_requires_the_system_message_first(self):
        with self.assertRaises(HTTPException):
            _validated_payload({"messages": [{"role": "user", "content": "hello"}]})

    def test_drops_tools_and_clamps_generation_settings(self):
        payload = _validated_payload({
            "messages": [
                {"role": "system", "content": "system", "tool_calls": [{"name": "run"}]},
                {"role": "user", "content": "hello"},
            ],
            "tools": [{"name": "shell"}],
            "max_tokens": 99_999,
            "temperature": 9,
            "top_p": -1,
            "chat_template_kwargs": {"enable_thinking": False, "execute": True},
        })

        self.assertEqual(payload["max_tokens"], 2_048)
        self.assertEqual(payload["temperature"], 2.0)
        self.assertEqual(payload["top_p"], 0.0)
        self.assertEqual(payload["chat_template_kwargs"], {"enable_thinking": False})
        self.assertNotIn("tools", payload)
        self.assertNotIn("tool_calls", payload["messages"][0])

    def test_rejects_a_second_system_message(self):
        with self.assertRaises(HTTPException):
            _validated_payload({"messages": [
                {"role": "system", "content": "first"},
                {"role": "system", "content": "second"},
            ]})

    def test_rejects_non_object_chat_template_options(self):
        with self.assertRaises(HTTPException):
            _validated_payload({
                "messages": [{"role": "system", "content": "first"}],
                "chat_template_kwargs": ["enable_thinking"],
            })


if __name__ == "__main__":
    unittest.main()

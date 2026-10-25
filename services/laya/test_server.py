import hashlib
import http.client
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("aw_laya_server", Path(__file__).with_name("server.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Backend:
    manifest = {"model_revision": "a" * 40}

    def preflight(self, body):
        return {"exact": True, "input_tokens": len(body["state"]), "model_revision": "a" * 40}

    def predict(self, body):
        raise RuntimeError("deliberate provider failure")


class SidecarTests(unittest.TestCase):
    def setUp(self):
        self.server = module.create_server(Backend(), 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request(method, path, body=body, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_preflight_and_health_use_real_http_boundary(self):
        self.assertEqual(self.request("GET", "/health")[0], 200)
        status, response = self.request("POST", "/v1/preflight", json.dumps({"model": "test", "state": "hello", "questions": {}}))
        self.assertEqual(status, 200)
        self.assertEqual(response["input_tokens"], 5)

    def test_inference_outage_is_not_a_pass(self):
        status, response = self.request("POST", "/v1/systemone", json.dumps({"model": "test", "state": "hello", "questions": {}}))
        self.assertEqual(status, 503)
        self.assertNotIn("deliberate", json.dumps(response))

    def test_origin_depth_nonfinite_and_prototype_inputs_are_rejected(self):
        self.assertEqual(self.request("GET", "/health", headers={"Origin": "https://attacker.test"})[0], 403)
        for body in ['{"__proto__":1}', '{"x":1e400}', '{"x":' * 40 + '0' + '}' * 40]:
            self.assertEqual(self.request("POST", "/v1/preflight", body)[0], 422)

    def test_manifest_checks_hashes_and_traversal_without_loading_a_model(self):
        with tempfile.TemporaryDirectory(prefix="aw-laya-manifest-") as directory:
            root = Path(directory)
            files = {}
            for name in ("model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"):
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b"synthetic-test-only")
                files[name] = hashlib.sha256(file.read_bytes()).hexdigest()
            manifest = {"runtime": "laya==0.4.15", "model_revision": "a" * 40, "tokenizer_revision": "a" * 40, "files": files}
            (root / "manifest.json").write_text(json.dumps(manifest))
            module.verify_manifest(root)
            (root / "model.safetensors").write_bytes(b"changed")
            with self.assertRaises(ValueError):
                module.verify_manifest(root)
            files["../outside.py"] = "0" * 64
            (root / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                module.verify_manifest(root)


if __name__ == "__main__":
    unittest.main()

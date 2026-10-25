"""Loopback-only Laya System One bridge. Runtime never downloads model code or weights."""
import hashlib
import json
import os
import re
import math
import socket
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
    os.environ[key] = "1"
os.environ["USE_TF"] = "0"


def verify_manifest(root):
    root = Path(root).resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    for key in ("model_revision", "tokenizer_revision"):
        if not re.fullmatch(r"[0-9a-f]{40}", manifest.get(key, "")):
            raise ValueError("Immutable revision missing")
    if manifest.get("runtime") != "laya==0.4.15":
        raise ValueError("Unreviewed runtime")
    required = {"model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"}
    if not required.issubset(manifest.get("files", {})):
        raise ValueError("Incomplete checkpoint manifest")
    for name, expected in manifest["files"].items():
        file = (root / name).resolve()
        if not file.is_relative_to(root) or file.suffix not in (".json", ".safetensors"):
            raise ValueError("Unsafe model asset")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError("Checkpoint hash mismatch")
    return root, manifest


class LayaBackend:
    def __init__(self, root):
        root, self.manifest = verify_manifest(root)
        import laya
        if laya.__version__ != "0.4.15":
            raise ValueError("Unreviewed Laya runtime version")
        self.agent = laya.load(str(root), device=os.environ.get("AW_LAYA_DEVICE", "cpu"), backend="eager")
        self.limit = min(1024, int(self.agent.cfg.get("max_len", 1024)))

    def preflight(self, body):
        from laya.common import build_sequence, encode_text, render_options, serialize_state
        if body.get("model") != "laya-typed-decisions":
            raise ValueError("Unsupported model")
        questions = body.get("questions")
        if not isinstance(questions, dict) or not 1 <= len(questions) <= 8:
            raise ValueError("Invalid questions")
        tok = self.agent.tok
        head_max = int(self.agent.cfg.get("head_max_len", 192))
        counts = {}
        for qid, question in questions.items():
            self.agent._check_question(qid, question)
            internal = self.agent._to_internal(question)
            options = render_options(internal)
            lengths = [len(encode_text(tok, " " + option.replace(tok.mask_token, " "), add_special_tokens=False)["input_ids"]) for option in options]
            instructions = f"{internal['t']} question: {internal['ins'].replace(tok.mask_token, ' ')}"
            instruction_count = len(encode_text(tok, instructions, add_special_tokens=False)["input_ids"])
            budget = head_max - sum(1 + count for count in lengths)
            if any(count > 48 for count in lengths) or budget < 16 or instruction_count > max(8, budget):
                raise ValueError("Question head would be truncated")
            sequence, markers, options_stats, state_stats = build_sequence(tok, body["state"], internal,
                self.limit, head_max, return_stats=True, return_truncation_stats=True)
            if state_stats["truncated"] or len(markers) != options_stats["options"]:
                raise ValueError("Context overflow")
            counts[qid] = len(sequence)
        return {"exact": True, "input_tokens": max(counts.values()), "question_tokens": counts,
                "model_revision": self.manifest["model_revision"], "tokenizer_revision": self.manifest["tokenizer_revision"]}

    def predict(self, body):
        self.preflight(body)
        result = self.agent.predict(body["state"], body["questions"], max_len=self.limit)
        result["model"] = self.manifest["model_revision"]
        result["usage"]["output_tokens"] = 0
        return result


def validate_json(value, depth=0):
    if depth > 32:
        raise ValueError("JSON depth limit")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Non-finite number")
    if isinstance(value, str) and len(value) > 262144:
        raise ValueError("String limit")
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("__proto__", "constructor", "prototype"):
                raise ValueError("Forbidden key")
            validate_json(child, depth + 1)
    elif isinstance(value, list):
        if len(value) > 10000:
            raise ValueError("Array limit")
        for child in value:
            validate_json(child, depth + 1)


def create_server(backend, port=8000):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass

        def respond(self, status, value):
            data = json.dumps(value, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def allowed(self):
            expected = f"127.0.0.1:{self.server.server_port}"
            return self.headers.get("Host") == expected and self.headers.get("Origin") in (None, os.environ.get("AW_APP_ORIGIN", "http://127.0.0.1:3000"))

        def do_GET(self):
            if not self.allowed():
                return self.respond(403, {"error": "Invalid host/origin"})
            if self.path == "/health":
                return self.respond(200, {"ready": True, "runtime": "laya==0.4.15", "offline": True, "model_revision": backend.manifest["model_revision"], "tokenizer_revision": backend.manifest.get("tokenizer_revision", backend.manifest["model_revision"])})
            self.respond(404, {"error": "Not found"})

        def do_POST(self):
            if not self.allowed():
                return self.respond(403, {"error": "Invalid host/origin"})
            if self.path not in ("/v1/preflight", "/v1/systemone"):
                return self.respond(404, {"error": "Not found"})
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json" or self.headers.get("Transfer-Encoding") or self.headers.get("Content-Encoding"):
                return self.respond(415, {"error": "Plain bounded JSON required"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 1024 * 1024:
                    return self.respond(413, {"error": "Body limit"})
                body = json.loads(self.rfile.read(size), parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("Non-finite number")))
                validate_json(body)
                if not isinstance(body, dict) or set(body) != {"model", "state", "questions"}:
                    raise ValueError("Invalid body")
                result = backend.preflight(body) if self.path == "/v1/preflight" else backend.predict(body)
                self.respond(200, result)
            except (ValueError, KeyError, TypeError):
                self.respond(422, {"error": "Invalid or oversized model input"})
            except (socket.timeout, TimeoutError):
                self.respond(408, {"error": "Request timeout"})
            except Exception:
                self.respond(503, {"error": "Inference unavailable"})
    return HTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    backend = LayaBackend(os.environ.get("AW_LAYA_MODEL_DIR", "data/models/laya-typed-decisions"))
    server = create_server(backend, int(os.environ.get("AW_LAYA_PORT", "8000")))
    print(f"Laya ready on http://127.0.0.1:{server.server_port}; revision {backend.manifest['model_revision']}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

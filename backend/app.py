import json
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

from agent_tools import ARTIFACT_DIR, build_flowchart_artifact, build_word_artifact
from back_end import KNOWLEDGE_FILE, get_ai_response, load_knowledge_slices


app = Flask(__name__)
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.route("/api/health", methods=["GET"])
def health():
    slices = load_knowledge_slices(KNOWLEDGE_FILE)
    return jsonify(
        {
            "ok": True,
            "knowledge_file": KNOWLEDGE_FILE,
            "slice_count": len(slices),
        }
    )


@app.route("/api/chat", methods=["OPTIONS"])
def chat_options():
    return ("", 204)


@app.route("/api/chat", methods=["POST"])
def chat():
    payload = request.get_json(silent=True) or {}
    message = (payload.get("message") or "").strip()
    if not message:
        return jsonify({"error": "请输入问题。"}), 400

    def event_stream():
        try:
            token_stream, relevant_slices = get_ai_response(message)
            meta = {
                "knowledge_file": KNOWLEDGE_FILE,
                "slices": [
                    {"num": item["num"], "name": item["name"], "tags": item["tags"]}
                    for item in relevant_slices
                ],
            }
            yield f"event: meta\ndata: {json.dumps(meta, ensure_ascii=False)}\n\n"
            for token in token_stream:
                yield f"data: {json.dumps({'delta': token}, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"
        except Exception as exc:
            error = f"系统响应异常：请确认 vLLM/OpenAI兼容服务（默认 48010 端口）是否正常。{exc}"
            yield f"event: error\ndata: {json.dumps({'error': error}, ensure_ascii=False)}\n\n"

    return Response(stream_with_context(event_stream()), mimetype="text/event-stream")


@app.route("/api/artifacts/word", methods=["OPTIONS"])
def word_artifact_options():
    return ("", 204)


@app.route("/api/artifacts/word", methods=["POST"])
def word_artifact():
    payload = request.get_json(silent=True) or {}
    question = (payload.get("question") or "").strip()
    answer = (payload.get("answer") or "").strip()
    references = payload.get("references") or []

    if not question or not answer:
        return jsonify({"error": "生成Word需要问题和回答内容。"}), 400

    def event_stream():
        try:
            for event in build_word_artifact(question, answer, references):
                yield f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"
        except Exception as exc:
            error = f"Word生成失败：{exc}"
            yield f"event: error\ndata: {json.dumps({'error': error}, ensure_ascii=False)}\n\n"

    return Response(stream_with_context(event_stream()), mimetype="text/event-stream")


@app.route("/api/artifacts/flowchart", methods=["OPTIONS"])
def flowchart_artifact_options():
    return ("", 204)


@app.route("/api/artifacts/flowchart", methods=["POST"])
def flowchart_artifact():
    payload = request.get_json(silent=True) or {}
    question = (payload.get("question") or "").strip()
    answer = (payload.get("answer") or "").strip()
    references = payload.get("references") or []

    if not question or not answer:
        return jsonify({"error": "生成流程图需要问题和回答内容。"}), 400

    def event_stream():
        try:
            for event in build_flowchart_artifact(question, answer, references):
                yield f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"
        except Exception as exc:
            error = f"流程图生成失败：{exc}"
            yield f"event: error\ndata: {json.dumps({'error': error}, ensure_ascii=False)}\n\n"

    return Response(stream_with_context(event_stream()), mimetype="text/event-stream")


@app.route("/api/files/<path:filename>", methods=["GET"])
def download_file(filename):
    preview = request.args.get("preview") == "1"
    return send_from_directory(ARTIFACT_DIR, filename, as_attachment=not preview)


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    if not FRONTEND_DIST.exists():
        return jsonify({"error": "前端静态文件不存在，请先在 frontend 目录执行 npm run build。"}), 404

    target = FRONTEND_DIST / path
    if path and target.exists() and target.is_file():
        return send_from_directory(FRONTEND_DIST, path)

    return send_from_directory(FRONTEND_DIST, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, threaded=True)

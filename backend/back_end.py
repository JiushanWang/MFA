import json
import os
import re
from functools import lru_cache
from pathlib import Path

import requests


MODEL_URL = os.getenv("METRO_MODEL_URL", "http://127.0.0.1:48010/v1").rstrip("/")
MODEL_NAME = os.getenv("METRO_MODEL_NAME", "gemma-4-31b-it")
MODEL_SOURCE = os.getenv("METRO_MODEL_SOURCE", "RedHatAI/gemma-4-31B-it-FP8-block")
KNOWLEDGE_FILENAME = "12号线地铁车辆故障处置方案-切片.txt"
ASCII_KNOWLEDGE_FILENAME = "knowledge_slices.txt"


def resolve_knowledge_file():
    code_dir = Path(__file__).resolve().parent
    project_dir = code_dir.parents[1] if len(code_dir.parents) > 1 else code_dir
    candidates = [
        os.getenv("METRO_KNOWLEDGE_FILE"),
        code_dir / "knowledge" / ASCII_KNOWLEDGE_FILENAME,
        code_dir / "knowledge" / KNOWLEDGE_FILENAME,
        code_dir.parent / "knowledge" / ASCII_KNOWLEDGE_FILENAME,
        code_dir.parent / "knowledge" / KNOWLEDGE_FILENAME,
        project_dir / "代码-streamlit" / KNOWLEDGE_FILENAME,
        project_dir / "知识文件" / KNOWLEDGE_FILENAME,
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)

    knowledge_dir = code_dir / "knowledge"
    if knowledge_dir.exists():
        for candidate in knowledge_dir.glob("*.txt"):
            return str(candidate)

    return str(code_dir / "knowledge" / KNOWLEDGE_FILENAME)


KNOWLEDGE_FILE = resolve_knowledge_file()


def parse_knowledge_slices(file_path):
    if not os.path.exists(file_path):
        return []

    content = Path(file_path).read_text(encoding="utf-8")
    header_pattern = re.compile(
        r"【切片序号:\s*(\d+)】\s*[\r\n]+"
        r"【切片名称:\s*(.*?)】\s*[\r\n]+"
        r"【切片标签:\s*(.*?)】",
        re.S,
    )
    matches = list(header_pattern.finditer(content))
    slices = []

    for index, match in enumerate(matches):
        start_pos = match.end()
        end_pos = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        slices.append(
            {
                "num": match.group(1).strip(),
                "name": match.group(2).strip(),
                "tags": match.group(3).strip(),
                "content": content[start_pos:end_pos].strip(),
            }
        )

    return slices


@lru_cache(maxsize=4)
def load_knowledge_slices(file_path=KNOWLEDGE_FILE):
    return parse_knowledge_slices(file_path)


def retrieve_relevant_slices(user_input, slices, top_k=3):
    keyword_weights = {
        "出乘前": ["出乘前", "出乘前检查", "出发前", "开车前", "蓄电池", "司控器", "HMI屏", "升弓", "高断", "激活"],
        "车门": ["车门", "门关好", "门故障", "红点", "白点", "切除", "远程隔离", "紧急解锁"],
        "牵引": ["牵引", "VVVF", "逆变器", "高断", "高速断路器", "红点"],
        "制动": ["制动", "保压", "快速制动", "紧急制动", "气制动", "停放制动", "缓解"],
        "网络": ["网络", "HMI", "车辆屏", "黑屏", "通信故障"],
        "LCU": ["LCU", "逻辑控制"],
        "辅助": ["辅助", "SIV", "逆变器", "空调", "蓄电池"],
        "受电弓": ["受电弓", "升弓", "降弓", "网压"],
        "空压机": ["空压机", "气压", "总风", "主风"],
        "司控器": ["司控器", "卡滞", "方向"],
        "火灾": ["火灾", "烟雾", "火警"],
        "头灯": ["头灯", "照明"],
        "玻璃": ["玻璃", "破裂"],
        "广播": ["广播", "PIDS", "LCD"],
        "保底": ["保底", "流程", "旁路"],
        "设备位置": ["设备位置", "电气柜", "控制柜", "综合柜"],
        "颜色": ["颜色", "图标", "标识"],
        "开关": ["开关", "旋钮", "按钮", "旁路"],
    }

    fault_numbers = re.findall(r"故障[序号:：]?\s*(\d+)", user_input)
    scored_slices = []

    for slice_item in slices:
        score = 0
        searchable = f"{slice_item['name']}\n{slice_item['tags']}\n{slice_item['content']}"

        for number in fault_numbers:
            if f"故障序号: {number}" in searchable or f"故障序号:{number}" in searchable:
                score += 100

        for trigger, keywords in keyword_weights.items():
            if trigger in user_input:
                for keyword in keywords:
                    if keyword in searchable:
                        score += 10

        for keywords in keyword_weights.values():
            for keyword in keywords:
                if keyword in user_input and keyword in searchable:
                    score += 15

        for keyword in re.findall(r"[\u4e00-\u9fa5A-Za-z0-9=+-]{2,}", user_input):
            if keyword in slice_item["name"]:
                score += 10
            if keyword in slice_item["tags"]:
                score += 8
            if keyword in slice_item["content"]:
                score += 5

        for code in re.findall(r"=\d+-[A-Z]\d+", user_input):
            if code in searchable:
                score += 15

        scored_slices.append((score, slice_item))

    scored_slices.sort(key=lambda item: item[0], reverse=True)
    relevant = [slice_item for score, slice_item in scored_slices[:top_k] if score > 0]
    return relevant or slices[:top_k]


def build_messages(user_input, relevant_slices):
    context = "\n\n".join(
        f"【资料名称】{slice_item['name']}\n{slice_item['content']}" for slice_item in relevant_slices
    )
    system_instruction = (
        f"你现在是轨交车辆故障处置助手Agent，底层模型为 {MODEL_SOURCE} 本地FP8量化部署，"
        f"OpenAI兼容接口调用模型名为 {MODEL_NAME}。\n"
        "你是轨道交通车辆故障处置专家助理，请基于提供的【相关故障处置资料】回答司机和维修人员的问题。\n\n"
        "执行准则：\n"
        "1. 准确识别故障类型，并匹配对应处置流程。\n"
        "2. 按文档规定步骤逐步指导操作，明确操作要点和注意事项。\n"
        "3. 始终强调安全操作规范，动车前确认车门关好、制动缓解等关键事项。\n"
        "4. 资料未提及的故障或处置方法，要明确提示资料不足，严禁编造。\n"
        "5. 涉及设备操作时，尽量指出设备位置。\n"
        "6. 不要输出依据、参考切片、切片编号等内部检索说明。\n"
        "7. 不要使用 LaTeX 或数学公式格式；设备编号、距离、比较符号请直接写成普通文本，例如 =81-S24、≥70m、≤10mm、→。"
    )
    return [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": f"【相关故障处置资料】\n{context}\n\n【提问】\n{user_input}"},
    ]


def stream_model_response(messages):
    url = f"{MODEL_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {os.getenv('OPENAI_API_KEY', 'EMPTY')}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "temperature": 0.1,
        "stream": True,
    }

    with requests.post(url, headers=headers, json=payload, stream=True, timeout=(10, None)) as response:
        response.raise_for_status()
        for raw_line in response.iter_lines(decode_unicode=True):
            if not raw_line or not raw_line.startswith("data:"):
                continue
            data = raw_line.removeprefix("data:").strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            delta = chunk.get("choices", [{}])[0].get("delta", {})
            content = delta.get("content")
            if content:
                yield content


def get_ai_response(user_input):
    slices = load_knowledge_slices(KNOWLEDGE_FILE)
    if not slices:
        raise FileNotFoundError(f"未找到知识库文件或解析失败：{KNOWLEDGE_FILE}")

    relevant_slices = retrieve_relevant_slices(user_input, slices, top_k=3)
    messages = build_messages(user_input, relevant_slices)
    return stream_model_response(messages), relevant_slices

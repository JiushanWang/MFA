import { useEffect, useMemo, useRef, useState } from "react";

const PRESET_QUESTIONS = [
  "出乘前我发现蓄电池无法激活，该怎么办？",
  "列车在运行途中，HMI屏显示某节车有一个车门出现红点故障，司机应该如何处理？",
  "列车施加紧急制动后无法缓解，HMI屏显示紧急制动状态，司机应该按照什么步骤排查和处理？",
];

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSymbols(text) {
  const normalizeMathContent = (content) =>
    content
      .replace(/\\text\{([^}]*)\}/g, "$1")
      .replace(/\\rightarrow/g, "→")
      .replace(/\\leftarrow/g, "←")
      .replace(/\\Rightarrow/g, "⇒")
      .replace(/\\geq?/g, "≥")
      .replace(/\\leq?/g, "≤")
      .replace(/\\times/g, "×")
      .replace(/\\pm/g, "±")
      .replace(/\\cdot/g, "·")
      .replace(/\\%/g, "%")
      .replace(/\\([=<>+\-:])/g, "$1")
      .replace(/\\/g, "")
      .replace(/\s+/g, " ")
      .trim();

  return text.replace(/\$([^$]+)\$/g, (_, content) => normalizeMathContent(content));
}

function normalizeAnswer(text) {
  const blockedPrefixes = ["依据：", "依据:", "根据：", "根据:", "参考：", "参考:"];
  const blockedPhrases = [
    "根据故障处置方案",
    "故障处置方案中的",
    "见切片",
    "参考切片",
    "切片011",
  ];

  return normalizeSymbols(text)
    .split("\n")
    .filter((line) => {
      const stripped = line.trim();
      return (
        !blockedPrefixes.some((prefix) => stripped.startsWith(prefix)) &&
        !blockedPhrases.some((phrase) => stripped.includes(phrase))
      );
    })
    .join("\n")
    .trim();
}

function parseSseEvent(block) {
  const event = { type: "message", data: "" };
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event.type = line.slice(6).trim();
    }
    if (line.startsWith("data:")) {
      event.data += line.slice(5).trim();
    }
  }
  return event;
}

function summarize(messages) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  return firstUserMessage?.content || "未命名对话";
}

function renderInlineMarkdown(text) {
  const parts = normalizeSymbols(text).split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function MarkdownContent({ text }) {
  const lines = normalizeAnswer(text).split("\n");
  const nodes = [];
  let listItems = [];

  function flushList() {
    if (!listItems.length) return;
    nodes.push(
      <ul key={`list-${nodes.length}`} className="answer-list">
        {listItems.map((item, index) => (
          <li key={index}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      return;
    }

    const heading = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flushList();
      nodes.push(<h3 key={`heading-${index}`}>{renderInlineMarkdown(heading[1])}</h3>);
      return;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[1]);
      return;
    }

    flushList();
    nodes.push(<p key={`paragraph-${index}`}>{renderInlineMarkdown(trimmed)}</p>);
  });

  flushList();
  return <div className="markdown-content">{nodes}</div>;
}

export default function App() {
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [references, setReferences] = useState([]);
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [artifactRuns, setArtifactRuns] = useState({});
  const abortRef = useRef(null);
  const messagesRef = useRef(null);
  const artifactQueuesRef = useRef({});

  const hasMessages = messages.length > 0;
  const conversationTitle = useMemo(() => summarize(messages), [messages]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;

    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [messages, artifactRuns, loading]);

  function archiveCurrentChat() {
    if (!messages.length) return;
    setHistory((items) => [{ title: conversationTitle, messages }, ...items].slice(0, 10));
  }

  function startNewChat() {
    if (loading) return;
    archiveCurrentChat();
    setMessages([]);
    setReferences([]);
  }

  function loadHistoryChat(index) {
    if (loading) return;
    const selected = history[index];
    archiveCurrentChat();
    setMessages(selected.messages);
    setReferences([]);
    setHistory((items) => items.filter((_, itemIndex) => itemIndex !== index).slice(0, 10));
  }

  async function sendMessage(prompt) {
    const question = (prompt || input).trim();
    if (!question || loading) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInput("");
    setLoading(true);
    setReferences([]);

    const assistantId = createId();
    setMessages((items) => [
      ...items,
      { id: createId(), role: "user", content: question },
      { id: assistantId, role: "assistant", content: "" },
    ]);

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`后端请求失败：${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
          const event = parseSseEvent(block);
          if (!event.data) continue;

          if (event.type === "meta") {
            const meta = JSON.parse(event.data);
            setReferences(meta.slices || []);
            continue;
          }

          if (event.type === "error") {
            const payload = JSON.parse(event.data);
            throw new Error(payload.error);
          }

          if (event.type === "message") {
            const payload = JSON.parse(event.data);
            if (payload.delta) {
              setMessages((items) =>
                items.map((message) =>
                  message.id === assistantId
                    ? { ...message, content: message.content + payload.delta }
                    : message,
                ),
              );
            }
          }
        }
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        setMessages((items) =>
          items.map((message) =>
            message.id === assistantId
              ? { ...message, content: error.message || "系统响应异常，请稍后重试。" }
              : message,
          ),
        );
      }
    } finally {
      setLoading(false);
    }
  }

  function stopGeneration() {
    abortRef.current?.abort();
    setLoading(false);
  }

  async function copyAnswer(message) {
    const text = normalizeAnswer(message.content);
    if (!text) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId(""), 1600);
    } catch {
      setCopiedMessageId("");
    }
  }

  function updateArtifactRun(messageId, updater) {
    setArtifactRuns((items) => {
      const current = items[messageId] || {
        status: "idle",
        kind: "word",
        records: [],
        checks: [],
        plan: null,
        artifact: null,
        error: "",
      };
      return { ...items, [messageId]: updater(current) };
    });
  }

  function playArtifactEvent(messageId, event, delay) {
    const queues = artifactQueuesRef.current;
    const previous = queues[messageId] || Promise.resolve();
    queues[messageId] = previous
      .then(
        () =>
          new Promise((resolve) => {
            window.setTimeout(resolve, delay);
          }),
      )
      .then(() => {
        if (event.eventType === "plan") {
          updateArtifactRun(messageId, (run) => ({ ...run, plan: event.payload.plan }));
        }

        if (event.eventType === "record") {
          updateArtifactRun(messageId, (run) => ({
            ...run,
            records: [...run.records, event.payload],
          }));
        }

        if (event.eventType === "check") {
          updateArtifactRun(messageId, (run) => ({
            ...run,
            checks: [...run.checks, event.payload],
          }));
        }

        if (event.eventType === "artifact") {
          updateArtifactRun(messageId, (run) => ({
            ...run,
            status: "done",
            artifact: event.payload,
          }));
          triggerDownload(event.payload.download_url, event.payload.filename);
        }
      });

    return queues[messageId];
  }

  function findQuestionForAnswer(answerIndex) {
    for (let index = answerIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        return messages[index].content;
      }
    }
    return conversationTitle;
  }

  function triggerDownload(url, filename) {
    const link = document.createElement("a");
    link.href = `${API_BASE}${url}`;
    link.download = filename || "故障处置建议.docx";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function generateArtifact(message, answerIndex, kind) {
    const question = findQuestionForAnswer(answerIndex);
    updateArtifactRun(message.id, () => ({
      status: "running",
      kind,
      records: [],
      checks: [],
      plan: null,
      artifact: null,
      error: "",
    }));
    artifactQueuesRef.current[message.id] = Promise.resolve();

    try {
      const response = await fetch(`${API_BASE}/api/artifacts/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          answer: normalizeAnswer(message.content),
          references,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`${kind === "word" ? "Word" : "流程图"}生成请求失败：${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
          const event = parseSseEvent(block);
          if (!event.data) continue;
          const payload = JSON.parse(event.data);

          if (event.type === "plan") {
            playArtifactEvent(message.id, { eventType: "plan", payload }, 450);
            continue;
          }

          if (event.type === "record") {
            playArtifactEvent(message.id, { eventType: "record", payload }, 650);
            continue;
          }

          if (event.type === "check") {
            playArtifactEvent(message.id, { eventType: "check", payload }, 650);
            continue;
          }

          if (event.type === "artifact") {
            await playArtifactEvent(message.id, { eventType: "artifact", payload }, 800);
            continue;
          }

          if (event.type === "error") {
            throw new Error(payload.error);
          }
        }
      }
    } catch (error) {
      updateArtifactRun(message.id, (run) => ({
        ...run,
        status: "error",
        error: error.message || `${kind === "word" ? "Word" : "流程图"}生成失败`,
      }));
    }
  }

  function ArtifactRunPanel({ run }) {
    if (!run || run.status === "idle") return null;
    const isFlowchart = run.kind === "flowchart";

    return (
      <div className="agent-panel">
        <div className="agent-panel-header">
          <strong>{isFlowchart ? "流程图生成Agent工作台" : "Word生成Agent工作台"}</strong>
          <span>{run.status === "running" ? "执行中" : run.status === "done" ? "已完成" : "异常"}</span>
        </div>

        {run.plan && (
          <div className="agent-plan">
            <span>任务规划</span>
            {isFlowchart ? (
              <p>
                识别故障场景：{run.plan.scenario}；规划流程节点 {run.plan.node_count} 个，
                操作节点 {run.plan.step_count} 个，判断节点 {run.plan.branch_count} 个。
              </p>
            ) : (
              <p>
                识别故障场景：{run.plan.scenario}；规划处置步骤 {run.plan.step_count} 项，
                设备/开关 {run.plan.device_count} 项，安全提醒 {run.plan.safety_count} 项。
              </p>
            )}
          </div>
        )}

        {!!run.records.length && (
          <div className="agent-section">
            <h3>任务执行过程</h3>
            <ol>
              {run.records.map((item, index) => (
                <li key={`${item.stage}-${item.title}-${index}`}>
                  <strong>{item.stage}</strong>
                  <span>{item.title}</span>
                  <p>{item.detail}</p>
                </li>
              ))}
            </ol>
          </div>
        )}

        {!!run.checks.length && (
          <div className="agent-section">
            <h3>自动测试</h3>
            <ul>
              {run.checks.map((item, index) => (
                <li className={item.ok ? "pass" : "fail"} key={`${item.title}-${index}`}>
                  <strong>{item.ok ? "通过" : "未通过"}</strong>
                  <span>{item.title}</span>
                  <p>{item.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {run.artifact && (
          <div className="agent-result">
            <div>
              <strong>最终提交成果</strong>
              <p>{run.artifact.filename} 已生成并触发下载。</p>
            </div>
            <button
              type="button"
              onClick={() => triggerDownload(run.artifact.download_url, run.artifact.filename)}
            >
              再次下载
            </button>
          </div>
        )}

        {isFlowchart && run.artifact?.preview_url && (
          <div className="flowchart-preview">
            <img src={`${API_BASE}${run.artifact.preview_url}`} alt="故障处置流程图预览" />
          </div>
        )}

        {run.error && <div className="agent-error">{run.error}</div>}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div>
            <strong>轨交车辆故障处置助手Agent</strong>
            <span>12号线知识库</span>
          </div>
        </div>

        <button className="primary-action" onClick={startNewChat} disabled={loading}>
          新对话
        </button>

        <section className="sidebar-section">
          <h2>已有知识库</h2>
          <p>12号线地铁车辆故障处置方案</p>
        </section>

        <section className="sidebar-section history-section">
          <h2>历史对话</h2>
          {history.length ? (
            <div className="history-list">
              {history.map((item, index) => (
                <button key={`${item.title}-${index}`} onClick={() => loadHistoryChat(index)}>
                  {item.title}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">暂无历史对话</p>
          )}
        </section>
      </aside>

      <main className="chat-area">
        <header className="chat-header">
          <div>
            <h1>欢迎使用轨交车辆故障处置助手Agent</h1>
            <p>面向司机与检修人员的故障处置问答助手</p>
          </div>
        </header>

        <section className="messages" aria-live="polite" ref={messagesRef}>
          {!hasMessages && (
            <div className="preset-zone">
              {PRESET_QUESTIONS.map((question) => (
                <button key={question} onClick={() => sendMessage(question)}>
                  {question}
                </button>
              ))}
            </div>
          )}

          {messages.map((message, index) => {
            const showActions =
              message.role === "assistant" &&
              message.content &&
              (!loading || index < messages.length - 1);
            const artifactRun = artifactRuns[message.id];
            const wordGenerating = artifactRun?.status === "running" && artifactRun?.kind === "word";
            const flowchartGenerating =
              artifactRun?.status === "running" && artifactRun?.kind === "flowchart";

            return (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="avatar">{message.role === "user" ? "问" : "答"}</div>
              <div className="bubble">
                {message.content ? (
                  <MarkdownContent text={message.content} />
                ) : (
                  <div className="markdown-content">
                    <p>{loading ? "正在分析..." : ""}</p>
                  </div>
                )}
              </div>
              {showActions && (
                <div className="message-actions" aria-label="回答操作">
                  <button type="button" onClick={() => copyAnswer(message)}>
                    {copiedMessageId === message.id ? "已复制" : "复制内容"}
                  </button>
                  <button
                    type="button"
                    onClick={() => generateArtifact(message, index, "word")}
                    disabled={wordGenerating}
                  >
                    {wordGenerating ? "正在生成word" : "生成并下载word"}
                  </button>
                  <button
                    type="button"
                    onClick={() => generateArtifact(message, index, "flowchart")}
                    disabled={flowchartGenerating}
                  >
                    {flowchartGenerating ? "正在生成流程图" : "生成并下载流程图"}
                  </button>
                </div>
              )}
              <ArtifactRunPanel run={artifactRun} />
            </article>
            );
          })}
        </section>

        {!!references.length && (
          <div className="reference-bar">
            <span>本轮检索：</span>
            {references.map((item) => (
              <span key={item.num}>
                {item.num} {item.name}
              </span>
            ))}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder="请输入故障现象"
            rows={2}
          />
          {loading ? (
            <button type="button" onClick={stopGeneration}>
              停止
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()}>
              发送
            </button>
          )}
        </form>
      </main>
    </div>
  );
}

import { ArrowUp, Copy, MessageSquarePlus, Play, Square, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { ChatMessage, ChatMode, ChatThread, ProviderId, SystemPromptPreset } from "@shared/contracts";
import { costTargets } from "@shared/costs";
import { AppHeader } from "@/components/app-header";
import { readJson } from "@/lib/api";
import { costHeaders, useCostApproval, type CostApproval } from "@/lib/cost-approval";
import type { StoredWorkflow } from "@/lib/workflow-contract";

interface Provider {
  id: ProviderId;
  label: string;
  model: string;
  available: boolean;
}

function parseSseChunk(buffer: string, onEvent: (event: string, data: unknown) => void) {
  const records = buffer.split("\n\n");
  const rest = records.pop() ?? "";
  for (const record of records) {
    let event = "message";
    let data = "";
    for (const line of record.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    try { onEvent(event, JSON.parse(data)); } catch { onEvent(event, data); }
  }
  return rest;
}

export function ChatPage() {
  const navigate = useNavigate();
  const confirmCost = useCostApproval();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [prompts, setPrompts] = useState<SystemPromptPreset[]>([]);
  const [workflows, setWorkflows] = useState<StoredWorkflow[]>([]);
  const [mode, setMode] = useState<ChatMode>("chat");
  const [providerId, setProviderId] = useState<ProviderId>("workers-ai");
  const [workflowId, setWorkflowId] = useState("");
  const [targetFieldName, setTargetFieldName] = useState("");
  const [promptPresetId, setPromptPresetId] = useState("");
  const [systemOverride, setSystemOverride] = useState("");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string>();
  const [quota, setQuota] = useState<{
    estimatedNeurons: number; reservedNeurons: number; freeNeurons: number; stopNeurons: number; warning: boolean; blocked: boolean;
  }>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);

  const active = threads.find((item) => item.id === activeId);
  const selectedWorkflow = workflows.find((item) => item.id === workflowId);
  const availableProviders = providers.filter((item) => item.available);
  const modalQwenAvailable = providers.some((item) => item.id === "modal-qwen36" && item.available);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/chat/threads", { signal: controller.signal }).then((response) => readJson<{ threads?: ChatThread[] }>(response, "对话读取失败")),
      fetch("/api/chat/providers", { signal: controller.signal }).then((response) => readJson<{ providers?: Provider[]; workersAi?: typeof quota }>(response, "模型状态读取失败")),
      fetch("/api/system-prompts", { signal: controller.signal }).then((response) => readJson<{ prompts?: SystemPromptPreset[] }>(response, "系统提示词读取失败")),
      fetch("/api/workflows", { signal: controller.signal }).then((response) => readJson<{ workflows?: StoredWorkflow[] }>(response, "工作流读取失败")),
    ]).then(([threadData, providerData, promptData, workflowData]) => {
      setThreads(threadData.threads ?? []);
      setActiveId(threadData.threads?.[0]?.id);
      setProviders(providerData.providers ?? []);
      setQuota(providerData.workersAi);
      setPrompts(promptData.prompts ?? []);
      setWorkflows((workflowData.workflows ?? []).filter((item: StoredWorkflow) => item.status === "ready"));
    }).catch((loadError) => {
      if (!(loadError instanceof DOMException && loadError.name === "AbortError")) setError(loadError instanceof Error ? loadError.message : "对话数据读取失败");
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/chat/threads/${activeId}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? "对话读取失败");
        setMessages(body.messages ?? []);
      })
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) setError(loadError.message);
      });
    return () => controller.abort();
  }, [activeId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages]);

  useEffect(() => {
    if (!selectedWorkflow) {
      setTargetFieldName("");
      return;
    }
    setTargetFieldName((current) => selectedWorkflow.textInputs.some((item) => item.fieldName === current)
      ? current
      : selectedWorkflow.textInputs[0]?.fieldName ?? "");
  }, [selectedWorkflow]);

  const matchingPrompts = useMemo(() => prompts.filter((prompt) => (
    prompt.scope === mode || (mode === "prompt" && prompt.scope === "workflow" && prompt.workflowId === workflowId)
  )), [mode, prompts, workflowId]);

  async function createThread() {
    setError(undefined);
    const selectedProvider = providers.find((provider) => provider.id === providerId);
    if (!selectedProvider?.available) {
      setError(`${selectedProvider?.label ?? "模型"}尚未配置`);
      return;
    }
    const response = await fetch("/api/chat/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: mode === "prompt" ? selectedWorkflow?.name || "新提示词" : "新对话",
        mode,
        providerId,
        workflowId: mode === "prompt" ? workflowId || undefined : undefined,
        workflowRevisionId: mode === "prompt" ? selectedWorkflow?.revisionId : undefined,
        targetFieldName: mode === "prompt" ? targetFieldName || undefined : undefined,
        systemPromptPresetId: promptPresetId || undefined,
        systemPromptOverride: systemOverride.trim() || undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.message ?? "对话创建失败");
      return;
    }
    setThreads((current) => [body, ...current]);
    setActiveId(body.id);
    setMessages([]);
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!active || !input.trim() || streaming) return;
    const content = input.trim();
    let approval: CostApproval | undefined;
    if (active.providerId === "modal-qwen36") {
      approval = await confirmCost({
        action: "modal-chat",
        target: costTargets.modalChat(active.id),
        fileBytes: new TextEncoder().encode(content).byteLength,
        batchCount: 1,
      });
      if (!approval) return;
    }
    const temporaryUser: ChatMessage = { id: crypto.randomUUID(), threadId: active.id, role: "user", content, createdAt: Date.now() };
    const temporaryAssistant: ChatMessage = { id: "streaming", threadId: active.id, role: "assistant", content: "", providerId: active.providerId, createdAt: Date.now() };
    setInput("");
    setMessages((current) => [...current, temporaryUser, temporaryAssistant]);
    setStreaming(true);
    setError(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    let accepted = false;
    try {
      const response = await fetch(`/api/chat/threads/${active.id}/messages`, {
        method: "POST",
        headers: approval
          ? costHeaders(approval, { "content-type": "application/json" })
          : { "content-type": "application/json" },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message ?? "模型请求失败");
      }
      accepted = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: Error | undefined;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = parseSseChunk(buffer, (eventName, data) => {
          const payload = data as { content?: string; message?: ChatMessage | string };
          if (eventName === "delta" && payload.content) {
            setMessages((current) => current.map((item) => item.id === "streaming" ? { ...item, content: item.content + payload.content } : item));
          } else if (eventName === "complete" && payload.message && typeof payload.message !== "string") {
            setMessages((current) => current.map((item) => item.id === "streaming" ? payload.message as ChatMessage : item));
          } else if (eventName === "error") {
            streamError = new Error(typeof payload.message === "string" ? payload.message : "模型请求失败");
          }
        });
        if (streamError) throw streamError;
      }
      if (active.providerId === "workers-ai") {
        const usageResponse = await fetch("/api/chat/providers");
        const usageBody = await readJson<{ workersAi?: typeof quota }>(usageResponse, "用量读取失败");
        setQuota(usageBody.workersAi);
      }
    } catch (sendError) {
      if (!(sendError instanceof DOMException && sendError.name === "AbortError")) setError(sendError instanceof Error ? sendError.message : "模型请求失败");
      if (!accepted) {
        setInput((current) => current || content);
        setMessages((current) => current.filter((item) => item.id !== temporaryUser.id && item.id !== "streaming"));
      } else {
        setMessages((current) => current.filter((item) => item.id !== "streaming" || item.content));
      }
    } finally {
      setStreaming(false);
      abortRef.current = undefined;
    }
  }

  async function deleteThread(threadId: string) {
    if (!window.confirm("删除这个对话及其消息？")) return;
    await fetch(`/api/chat/threads/${threadId}`, { method: "DELETE" });
    setThreads((current) => current.filter((item) => item.id !== threadId));
    if (activeId === threadId) setActiveId(threads.find((item) => item.id !== threadId)?.id);
  }

  function useForRun(message: ChatMessage) {
    if (!active?.workflowId || !active.targetFieldName) return;
    sessionStorage.setItem("lorachef.run-draft", JSON.stringify({
      workflowId: active.workflowId,
      fieldName: active.targetFieldName,
      content: message.content,
    }));
    navigate(`/?workflow=${encodeURIComponent(active.workflowId)}`);
  }

  return (
    <div className="app-shell">
      <AppHeader isMock={false} />
      <main className="chat-shell">
        <aside className="chat-sidebar">
          <div className="chat-sidebar__heading">
            <div><h1>对话</h1><p>提示词与日常交流</p></div>
            <button type="button" title="创建对话" onClick={() => void createThread()}><MessageSquarePlus size={18} /></button>
          </div>
          <div className="chat-create-controls">
            <div className="segmented" role="group" aria-label="对话模式">
              <button type="button" aria-pressed={mode === "chat"} onClick={() => { setMode("chat"); setProviderId("workers-ai"); }}>日常聊天</button>
              <button type="button" aria-pressed={mode === "prompt"} onClick={() => { setMode("prompt"); setProviderId(modalQwenAvailable ? "modal-qwen36" : "workers-ai"); }}>提示词</button>
            </div>
            <label><span>模型</span><select value={providerId} onChange={(event) => setProviderId(event.target.value as ProviderId)}>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.label}{provider.available ? "" : " · 未配置"}</option>)}</select></label>
            {mode === "prompt" && <>
              <label><span>工作流</span><select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}><option value="">不绑定</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>
              {selectedWorkflow?.textInputs.length ? <label><span>写入字段</span><select value={targetFieldName} onChange={(event) => setTargetFieldName(event.target.value)}>{selectedWorkflow.textInputs.map((item) => <option key={item.fieldName} value={item.fieldName}>{item.label}</option>)}</select></label> : null}
            </>}
            <label><span>系统提示词</span><select value={promptPresetId} onChange={(event) => setPromptPresetId(event.target.value)}><option value="">使用默认</option>{matchingPrompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name} · v{prompt.version}</option>)}</select></label>
            <details><summary>本会话覆盖</summary><textarea value={systemOverride} maxLength={12_000} rows={5} placeholder="仅覆盖当前新会话" onChange={(event) => setSystemOverride(event.target.value)} /></details>
            <button type="button" className="chat-create-button" onClick={() => void createThread()}><MessageSquarePlus size={16} />创建会话</button>
            {error && !active && <p className="form-error" role="alert">{error}</p>}
            {quota && <small className={quota.warning ? "quota quota--warning" : "quota"}>Workers AI 估算 {Math.round(quota.estimatedNeurons).toLocaleString()} / {quota.freeNeurons.toLocaleString()} Neurons{quota.warning ? " · 已达 90%，请手动切换 Modal" : ""}</small>}
          </div>
          <div className="chat-thread-list">
            {threads.map((item) => <button key={item.id} type="button" className={item.id === activeId ? "is-active" : ""} onClick={() => setActiveId(item.id)}><span><strong>{item.title}</strong><small>{item.mode === "prompt" ? "提示词" : "聊天"} · {item.providerId === "workers-ai" ? "Workers AI" : "Modal Qwen"}</small></span><Trash2 size={15} onClick={(event) => { event.stopPropagation(); void deleteThread(item.id); }} /></button>)}
          </div>
        </aside>
        <section className="conversation" aria-live="polite">
          {!active && <div className="conversation-empty"><MessageSquarePlus size={28} /><strong>创建一个会话</strong><p>聊天使用 Workers AI；提示词会优先选择已配置的 Modal Qwen3.6。</p></div>}
          {active && <>
            <header className="conversation-heading"><div><h2>{active.title}</h2><p>{active.providerId === "workers-ai" ? "Workers AI" : "Qwen3.6 · Modal"}{active.workflowId ? " · 已绑定工作流" : ""}</p></div></header>
            <div className="message-list">
              {messages.length === 0 && <div className="conversation-empty"><strong>{active.mode === "prompt" ? "描述你想得到的画面" : "开始对话"}</strong><p>{active.mode === "prompt" ? "结果可以直接写入已绑定的工作流字段。" : "对话会安全保存在当前 Cloudflare 账户。"}</p></div>}
              {messages.map((item) => <article key={item.id} className={`message message--${item.role}`}><header><span>{item.role === "user" ? "你" : item.providerId === "modal-qwen36" ? "Qwen3.6" : "AI"}</span>{item.role === "assistant" && item.content && <div><button type="button" title="复制" onClick={() => void navigator.clipboard.writeText(item.content)}><Copy size={15} /></button>{active.mode === "prompt" && active.workflowId && active.targetFieldName && <button type="button" title="用于运行" onClick={() => useForRun(item)}><Play size={15} /></button>}</div>}</header><p>{item.content || <span className="typing-indicator"><i /><i /><i /></span>}</p></article>)}
              <div ref={endRef} />
            </div>
            <form className="composer" onSubmit={(event) => void sendMessage(event)}>
              {error && <p role="alert">{error}</p>}
              <div><textarea value={input} rows={2} maxLength={20_000} placeholder={active.mode === "prompt" ? "描述画面、动作和希望保留的内容" : "输入消息"} disabled={streaming} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />{streaming ? <button type="button" title="停止生成" onClick={() => abortRef.current?.abort()}><Square size={17} fill="currentColor" /></button> : <button type="submit" title="发送" disabled={!input.trim()}><ArrowUp size={18} /></button>}</div>
            </form>
          </>}
        </section>
      </main>
    </div>
  );
}

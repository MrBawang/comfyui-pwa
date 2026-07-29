import { Bot, ChevronRight, Database, ExternalLink, HardDrive, LockKeyhole, Plus, Workflow } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { SystemPromptPreset } from "@shared/contracts";
import { AppHeader } from "@/components/app-header";
import { readJson } from "@/lib/api";
import type { StoredWorkflow } from "@/lib/workflow-contract";

const MAX_SYSTEM_PROMPT_CHARS = 32_000;

interface StorageStatus {
  usedBytes: number;
  warningBytes: number;
  stopBytes: number;
  blocked: boolean;
  operations: { classA: number; classB: number; classAStop: number; classBStop: number };
}

interface CloudConfig {
  modalConfigured: boolean;
  modalLlmConfigured: boolean;
  modalBudgetConfirmed: boolean;
  modalWorkspace: string;
  modalEndpointValid: boolean;
  workersAiModel: string;
  wisartConfigured: boolean;
  wisartDefaultModel?: string;
}

interface AgentStatus {
  status: "online" | "offline";
  agentId?: string;
  lastSeenAt?: number;
}

export function MorePage() {
  const navigate = useNavigate();
  const [prompts, setPrompts] = useState<SystemPromptPreset[]>([]);
  const [workflows, setWorkflows] = useState<StoredWorkflow[]>([]);
  const [storage, setStorage] = useState<StorageStatus>();
  const [config, setConfig] = useState<CloudConfig>();
  const [agent, setAgent] = useState<AgentStatus>();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"chat" | "prompt" | "workflow">("prompt");
  const [workflowId, setWorkflowId] = useState("");
  const [content, setContent] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string>();
  const [storageUnlockOpen, setStorageUnlockOpen] = useState(false);
  const [storagePassword, setStoragePassword] = useState("");
  const [storageUnlocking, setStorageUnlocking] = useState(false);
  const [storageUnlockError, setStorageUnlockError] = useState<string>();
  const modalReady = Boolean(config?.modalConfigured && config.modalEndpointValid && config.modalBudgetConfirmed);

  async function load() {
    const [promptResponse, workflowResponse, storageResponse, configResponse, agentResponse] = await Promise.all([
      fetch("/api/system-prompts"), fetch("/api/workflows"), fetch("/api/storage"), fetch("/api/config"), fetch("/api/agent-status"),
    ]);
    const [promptBody, workflowBody, storageBody, configBody, agentBody] = await Promise.all([
      readJson<{ prompts?: SystemPromptPreset[] }>(promptResponse, "系统提示词读取失败"),
      readJson<{ workflows?: StoredWorkflow[] }>(workflowResponse, "工作流读取失败"),
      readJson<StorageStatus>(storageResponse, "存储状态读取失败"),
      readJson<CloudConfig>(configResponse, "模型配置读取失败"),
      readJson<AgentStatus>(agentResponse, "Agent 状态读取失败"),
    ]);
    setPrompts(promptBody.prompts ?? []);
    setWorkflows(workflowBody.workflows ?? []);
    setStorage(storageBody);
    setConfig(configBody);
    setAgent(agentBody);
  }

  useEffect(() => { void load().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "设置读取失败")); }, []);

  async function savePrompt(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const response = await fetch("/api/system-prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, scope, workflowId: scope === "workflow" ? workflowId : undefined, content, isDefault }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.message ?? "系统提示词保存失败");
      return;
    }
    setName("");
    setContent("");
    await load();
  }

  async function openStorageUnlock() {
    setStorageUnlockError(undefined);
    if (storageUnlockOpen) {
      setStorageUnlockOpen(false);
      setStoragePassword("");
      return;
    }
    try {
      const response = await fetch("/api/r2-browser/session", { cache: "no-store" });
      const body = await readJson<{ configured: boolean; unlocked: boolean }>(response, "R2 查看状态读取失败");
      if (body.unlocked) {
        navigate("/storage");
        return;
      }
      setStorageUnlockOpen(true);
      if (!body.configured) setStorageUnlockError("R2 查看密码尚未配置");
    } catch (storageError) {
      setStorageUnlockOpen(true);
      setStorageUnlockError(storageError instanceof Error ? storageError.message : "R2 查看状态读取失败");
    }
  }

  async function unlockStorage(event: FormEvent) {
    event.preventDefault();
    setStorageUnlocking(true);
    setStorageUnlockError(undefined);
    try {
      const response = await fetch("/api/r2-browser/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: storagePassword }),
      });
      await readJson(response, "R2 解锁失败");
      setStoragePassword("");
      navigate("/storage");
    } catch (unlockError) {
      setStorageUnlockError(unlockError instanceof Error ? unlockError.message : "R2 解锁失败");
    } finally {
      setStorageUnlocking(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader isMock={false} />
      <main className="settings-shell">
        <header className="page-heading"><div><h1>更多</h1><p>工作流、模型、存储与本地 Agent。</p></div></header>
        <div className="settings-layout">
          <section className="settings-navigation">
            <Link to="/workflows"><Workflow size={20} /><span><strong>工作流库</strong><small>上传、检查、安装资源与保存版本</small></span><ExternalLink size={16} /></Link>
            <div className={`settings-storage-entry${storageUnlockOpen ? " is-open" : ""}`}><button type="button" className="settings-navigation__row" aria-expanded={storageUnlockOpen} onClick={() => void openStorageUnlock()}><Database size={20} /><span><strong>私有 R2</strong><small>{storage ? <>{(storage.usedBytes / 1024 / 1024 / 1024).toFixed(2)} / {(storage.stopBytes / 1024 / 1024 / 1024).toFixed(1)} GiB<br />A {storage.operations.classA.toLocaleString()} / {storage.operations.classAStop.toLocaleString()} · B {storage.operations.classB.toLocaleString()} / {storage.operations.classBStop.toLocaleString()}</> : "正在读取"}</small></span><span className="settings-storage-state">{storage && <i className={storage.blocked ? "is-danger" : storage.usedBytes >= storage.warningBytes ? "is-warning" : "is-good"} />}<ChevronRight className="settings-storage-chevron" size={17} /></span></button>{storageUnlockOpen && <form className="settings-storage-unlock" onSubmit={(event) => void unlockStorage(event)}><label><span><LockKeyhole size={15} />查看密码</span><input type="password" value={storagePassword} maxLength={256} autoComplete="current-password" autoFocus required onChange={(event) => setStoragePassword(event.target.value)} /></label>{storageUnlockError && <p className="form-error" role="alert">{storageUnlockError}</p>}<button type="submit" disabled={storageUnlocking}>{storageUnlocking ? "正在验证" : "查看 comfyui"}</button><small>解锁 15 分钟，仅提供预览和下载。</small></form>}</div>
            <div><Bot size={20} /><span><strong>云端服务</strong><small>Workers AI · {config?.workersAiModel || "读取中"}<br />中转站生图 · {config ? config.wisartConfigured ? `已配置 · ${config.wisartDefaultModel || "默认模型"}` : "未配置" : "读取中"}<br />Modal Workspace · {config?.modalWorkspace || "未配置"}<br />ComfyUI · {config ? !config.modalConfigured ? "未配置" : !config.modalEndpointValid ? "地址校验失败，已锁定" : !config.modalBudgetConfirmed ? "预算未确认，已锁定" : "已就绪" : "读取中"}<br />Qwen3.6 · {config ? config.modalLlmConfigured ? "已配置" : "第二阶段，未部署" : "读取中"}</small></span>{config && <i className={modalReady && config.wisartConfigured ? "is-good" : "is-warning"} />}</div>
            <div><HardDrive size={20} /><span><strong>PC LoRAChef Agent</strong><small>{!agent ? "正在读取" : agent.status === "online" ? `${agent.agentId || "Agent"} 在线` : agent.lastSeenAt ? `离线 · 上次在线 ${new Date(agent.lastSeenAt).toLocaleString("zh-CN")}` : "离线 · 尚未连接"}</small></span>{agent && <i className={agent.status === "online" ? "is-good" : "is-warning"} />}</div>
          </section>
          <section className="prompt-settings">
            <header><div><h2>系统提示词</h2><p>会话覆盖优先，其次工作流默认，最后使用模式默认。</p></div></header>
            <form onSubmit={(event) => void savePrompt(event)}>
              <div className="prompt-form-row"><label><span>名称</span><input value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} /></label><label><span>范围</span><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="prompt">提示词模式</option><option value="chat">日常聊天</option><option value="workflow">指定工作流</option></select></label></div>
              {scope === "workflow" && <label><span>工作流</span><select value={workflowId} required onChange={(event) => setWorkflowId(event.target.value)}><option value="">选择工作流</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>}
              <label className="prompt-editor"><span>System message</span><textarea value={content} required maxLength={MAX_SYSTEM_PROMPT_CHARS} rows={16} aria-describedby="system-prompt-count" onChange={(event) => setContent(event.target.value)} /><small id="system-prompt-count">{content.length.toLocaleString()} / {MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} 字符</small></label>
              <label className="prompt-default"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />设为该范围默认</label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button type="submit"><Plus size={16} />保存新版本</button>
            </form>
            <div className="prompt-list">{prompts.map((prompt) => <article key={`${prompt.id}-${prompt.version}`}><div><strong>{prompt.name}</strong><small>{prompt.scope === "workflow" ? "工作流" : prompt.scope === "prompt" ? "提示词" : "聊天"} · v{prompt.version}{prompt.isDefault ? " · 默认" : ""}</small></div><p>{prompt.content}</p></article>)}</div>
          </section>
        </div>
      </main>
    </div>
  );
}

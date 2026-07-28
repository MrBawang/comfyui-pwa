import { AlertTriangle, Clock3, DollarSign, ShieldCheck, Target, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { CostDescriptor, CostQuote } from "@shared/costs";
import { readJson } from "@/lib/api";

export interface CostApproval {
  token: string;
  idempotencyKey: string;
}

interface PendingApproval {
  quote: CostQuote;
  resolve: (approval: CostApproval | undefined) => void;
}

type ConfirmCost = (descriptor: CostDescriptor) => Promise<CostApproval | undefined>;

const CostApprovalContext = createContext<ConfirmCost | undefined>(undefined);

function formatBytes(value: number) {
  if (!value) return "无文件传输";
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024).toLocaleString()} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)} 小时`;
}

export function CostApprovalProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingApproval>();
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const confirmCost = useCallback<ConfirmCost>(async (descriptor) => {
    const response = await fetch("/api/cost-quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(descriptor),
    });
    const quote = await readJson<CostQuote>(response, "费用报价生成失败");
    return new Promise<CostApproval | undefined>((resolve) => {
      setError(undefined);
      setPending({ quote, resolve });
    });
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (pending && dialog && !dialog.open) dialog.showModal();
    if (!pending && dialog?.open) dialog.close();
  }, [pending]);

  function dismiss() {
    if (approving) return;
    pending?.resolve(undefined);
    setPending(undefined);
    setError(undefined);
  }

  async function approve() {
    if (!pending || approving) return;
    setApproving(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/cost-quotes/${encodeURIComponent(pending.quote.id)}/approve`, { method: "POST" });
      const body = await readJson<{ approvalToken: string }>(response, "费用批准失败");
      pending.resolve({ token: body.approvalToken, idempotencyKey: crypto.randomUUID() });
      setPending(undefined);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "费用批准失败");
    } finally {
      setApproving(false);
    }
  }

  return (
    <CostApprovalContext.Provider value={confirmCost}>
      {children}
      <dialog
        ref={dialogRef}
        className="cost-dialog"
        aria-labelledby="cost-dialog-title"
        onCancel={(event) => { event.preventDefault(); dismiss(); }}
      >
        {pending && <div className="cost-dialog__body">
          <header>
            <span><AlertTriangle size={20} /></span>
            <div><strong id="cost-dialog-title">{pending.quote.label}</strong><small>Modal 按量计费确认</small></div>
            <button type="button" title="取消" aria-label="取消费用确认" onClick={dismiss} disabled={approving}><X size={18} /></button>
          </header>
          <p>{pending.quote.description}</p>
          <dl>
            <div className="cost-dialog__target"><dt><Target size={16} />本次目标</dt><dd title={pending.quote.target}>{pending.quote.target}</dd></div>
            <div><dt><Clock3 size={16} />最长估算</dt><dd>{formatDuration(pending.quote.maxDurationSeconds)}</dd></div>
            <div><dt><DollarSign size={16} />最坏估算</dt><dd>US${pending.quote.estimatedMaxUsd.toFixed(4)}</dd></div>
            <div><dt><ShieldCheck size={16} />批准范围</dt><dd>{pending.quote.batchCount} 项 · {formatBytes(pending.quote.fileBytes)}</dd></div>
          </dl>
          <small className="cost-dialog__note">金额按 L40S 全时运行保守估算，实际以 Modal 账单为准。批准令牌 5 分钟内仅可使用一次，失败项不会自动重跑。</small>
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer>
            <button type="button" className="button-secondary" onClick={dismiss} disabled={approving}>取消</button>
            <button type="button" className="button-primary" onClick={() => void approve()} disabled={approving}>
              <ShieldCheck size={16} />{approving ? "正在批准" : "只批准本次操作"}
            </button>
          </footer>
        </div>}
      </dialog>
    </CostApprovalContext.Provider>
  );
}

export function useCostApproval() {
  const value = useContext(CostApprovalContext);
  if (!value) throw new Error("useCostApproval must be used inside CostApprovalProvider");
  return value;
}

export function costHeaders(approval: CostApproval, headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set("x-cost-approval", approval.token);
  result.set("idempotency-key", approval.idempotencyKey);
  return result;
}

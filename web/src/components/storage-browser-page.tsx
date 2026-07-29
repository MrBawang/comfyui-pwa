import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  Eye,
  File,
  FileArchive,
  FileImage,
  FileText,
  Folder,
  LockKeyhole,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AppHeader } from "@/components/app-header";
import { readJson } from "@/lib/api";

interface StorageSession {
  configured: boolean;
  unlocked: boolean;
}

interface StorageDirectory {
  prefix: string;
  name: string;
}

interface StorageObject {
  key: string;
  name: string;
  size: number;
  uploadedAt: number;
  contentType: string;
  storageClass: string;
  previewable: boolean;
}

interface StorageListing {
  prefix: string;
  prefixes: StorageDirectory[];
  objects: StorageObject[];
  truncated: boolean;
  nextCursor?: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1_024 ** 3).toFixed(2)} GiB`;
}

function objectUrl(item: StorageObject, mode: "inline" | "attachment") {
  return `/api/r2-browser/object?${new URLSearchParams({ key: item.key, mode })}`;
}

function fileIcon(contentType: string) {
  if (contentType.startsWith("image/") || contentType.startsWith("video/")) return FileImage;
  if (contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/pdf") return FileText;
  if (contentType.includes("zip") || contentType.includes("tar") || contentType.includes("compressed")) return FileArchive;
  return File;
}

function breadcrumbItems(prefix: string) {
  let current = "";
  return prefix.replace(/\/$/, "").split("/").filter(Boolean).map((name) => {
    current += `${name}/`;
    return { name, prefix: current };
  });
}

export function StorageBrowserPage() {
  const navigate = useNavigate();
  const previewDialog = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState<StorageSession>();
  const [listing, setListing] = useState<StorageListing>();
  const [prefix, setPrefix] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const [preview, setPreview] = useState<StorageObject>();
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch("/api/r2-browser/session", { cache: "no-store", signal: controller.signal })
      .then((response) => readJson<StorageSession>(response, "R2 查看状态读取失败"))
      .then(setSession)
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "R2 查看状态读取失败");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!session?.unlocked) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ prefix });
    if (cursor) query.set("cursor", cursor);
    setLoading(true);
    setError(undefined);
    void fetch(`/api/r2-browser/objects?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          setSession((current) => ({ configured: current?.configured ?? true, unlocked: false }));
        }
        return readJson<StorageListing>(response, "R2 目录读取失败");
      })
      .then(setListing)
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "R2 目录读取失败");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [cursor, prefix, reload, session?.unlocked]);

  useEffect(() => {
    if (!preview) return;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    if (!previewDialog.current?.open) previewDialog.current?.showModal();
    return () => {
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [preview]);

  function openDirectory(nextPrefix: string) {
    setPrefix(nextPrefix);
    setCursor(undefined);
    setCursorHistory([]);
  }

  function previousPage() {
    const history = [...cursorHistory];
    setCursor(history.pop());
    setCursorHistory(history);
  }

  function nextPage() {
    if (!listing?.nextCursor) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(listing.nextCursor);
  }

  async function lockBrowser() {
    setError(undefined);
    try {
      const response = await fetch("/api/r2-browser/lock", { method: "POST" });
      await readJson(response, "R2 锁定失败");
      navigate("/more", { replace: true });
    } catch (lockError) {
      setError(lockError instanceof Error ? lockError.message : "R2 锁定失败");
    }
  }

  function closePreview() {
    previewDialog.current?.close();
  }

  const itemCount = (listing?.prefixes.length ?? 0) + (listing?.objects.length ?? 0);

  return (
    <div className="app-shell">
      <AppHeader isMock={false} />
      <main className="storage-browser-shell">
        <header className="page-heading">
          <div><h1>comfyui 存储</h1><p>私有 R2 的只读目录与原文件。</p></div>
          {session?.unlocked && <button type="button" onClick={() => void lockBrowser()}><LockKeyhole size={17} />立即锁定</button>}
        </header>

        {error && <p className="form-error storage-browser-error" role="alert">{error}</p>}

        {loading && !session && <div className="storage-list-skeleton" aria-label="正在检查 R2 查看权限"><span /><span /><span /></div>}

        {!loading && session && !session.unlocked && (
          <section className="storage-locked-state">
            <LockKeyhole size={28} aria-hidden="true" />
            <strong>{session.configured ? "R2 查看已锁定" : "R2 查看密码尚未配置"}</strong>
            <p>{session.configured ? "返回“更多”，输入独立查看密码后才能读取 comfyui 桶。" : "需要先配置 Worker Secret，当前不会读取任何桶内容。"}</p>
            <Link to="/more"><ArrowLeft size={16} />返回更多</Link>
          </section>
        )}

        {session?.unlocked && (
          <>
            <section className="storage-toolbar" aria-label="R2 目录工具">
              <nav className="storage-breadcrumbs" aria-label="当前目录">
                <button type="button" onClick={() => openDirectory("")} aria-current={!prefix ? "page" : undefined}><Database size={16} />comfyui</button>
                {breadcrumbItems(prefix).map((item) => <span key={item.prefix}><ChevronRight size={14} /><button type="button" onClick={() => openDirectory(item.prefix)} aria-current={item.prefix === prefix ? "page" : undefined}>{item.name}</button></span>)}
              </nav>
              <button className="storage-refresh" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading} title="刷新当前目录"><RefreshCw size={17} /></button>
            </section>

            <div className="storage-list-meta"><span>{loading ? "正在读取目录" : `${itemCount} 项`}</span><span>目录读取计 Class A，预览或下载计 Class B</span></div>

            {loading && <div className="storage-list-skeleton" aria-label="正在读取 R2 目录"><span /><span /><span /></div>}

            {!loading && listing && itemCount === 0 && (
              <section className="storage-empty-state"><Folder size={28} /><strong>此目录为空</strong><p>该前缀下没有对象或子目录。</p></section>
            )}

            {!loading && listing && itemCount > 0 && (
              <div className="storage-table-wrap">
                <table className="storage-table">
                  <thead><tr><th>名称</th><th>类型</th><th>大小</th><th>修改时间</th><th><span className="sr-only">操作</span></th></tr></thead>
                  <tbody>
                    {listing.prefixes.map((directory) => (
                      <tr key={directory.prefix} className="storage-directory-row">
                        <td><button type="button" className="storage-name-button" onClick={() => openDirectory(directory.prefix)}><Folder size={18} /><span>{directory.name}</span></button></td>
                        <td>目录</td><td>—</td><td>—</td>
                        <td><button type="button" className="storage-row-action" onClick={() => openDirectory(directory.prefix)} title={`打开 ${directory.name}`}><ChevronRight size={17} /></button></td>
                      </tr>
                    ))}
                    {listing.objects.map((item) => {
                      const Icon = fileIcon(item.contentType);
                      return (
                        <tr key={item.key}>
                          <td><div className="storage-file-name"><Icon size={18} /><span title={item.key}>{item.name}</span></div></td>
                          <td><span className="storage-content-type" title={item.contentType}>{item.contentType}</span></td>
                          <td>{formatBytes(item.size)}</td>
                          <td>{new Date(item.uploadedAt).toLocaleString("zh-CN")}</td>
                          <td><div className="storage-row-actions">{item.previewable && <button type="button" className="storage-row-action" onClick={() => setPreview(item)} title={`预览 ${item.name}`}><Eye size={17} /></button>}<a className="storage-row-action" href={objectUrl(item, "attachment")} download={item.name} title={`下载 ${item.name}`}><Download size={17} /></a></div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && listing && (cursorHistory.length > 0 || listing.truncated) && (
              <nav className="storage-pagination" aria-label="R2 目录分页">
                <button type="button" onClick={previousPage} disabled={cursorHistory.length === 0}><ChevronLeft size={16} />上一页</button>
                <span>第 {cursorHistory.length + 1} 页</span>
                <button type="button" onClick={nextPage} disabled={!listing.nextCursor}>下一页<ChevronRight size={16} /></button>
              </nav>
            )}
          </>
        )}
      </main>

      <dialog ref={previewDialog} className="storage-preview-dialog" onClose={() => setPreview(undefined)}>
        {preview && <div className="storage-preview-dialog__body"><header><div><strong>{preview.name}</strong><small>{preview.contentType} · {formatBytes(preview.size)}</small></div><button type="button" onClick={closePreview} title="关闭预览"><X size={19} /></button></header><div className="storage-preview-media">{preview.contentType.startsWith("image/") ? <img src={objectUrl(preview, "inline")} alt={preview.name} /> : preview.contentType.startsWith("video/") ? <video src={objectUrl(preview, "inline")} controls autoPlay /> : preview.contentType.startsWith("audio/") ? <audio src={objectUrl(preview, "inline")} controls autoPlay /> : <iframe src={objectUrl(preview, "inline")} title={preview.name} />}</div><footer><a href={objectUrl(preview, "attachment")} download={preview.name}><Download size={16} />下载原文件</a></footer></div>}
      </dialog>
    </div>
  );
}

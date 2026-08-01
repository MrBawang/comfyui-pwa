import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileOutput,
  Images,
  Maximize2,
  Play,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppHeader } from "@/components/app-header";

interface GalleryItem {
  id: string;
  runId: string;
  filename: string;
  mediaType: string;
  bytes: number;
  workflowName?: string;
  createdAt: number;
  url: string;
}

export function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string>();
  const [selectedIndex, setSelectedIndex] = useState<number>();
  const previewDialog = useRef<HTMLDialogElement>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const selected = selectedIndex === undefined ? undefined : items[selectedIndex];

  function openPreview(index: number, trigger: HTMLButtonElement) {
    previewTrigger.current = trigger;
    setSelectedIndex(index);
    requestAnimationFrame(() => {
      if (!previewDialog.current?.open) previewDialog.current?.showModal();
    });
  }

  function closePreview() {
    previewDialog.current?.close();
  }

  function restorePreviewFocus() {
    setSelectedIndex(undefined);
    previewTrigger.current?.focus();
  }

  function selectItem(index: number) {
    setSelectedIndex((index + items.length) % items.length);
  }

  function handlePreviewKey(event: React.KeyboardEvent<HTMLDialogElement>) {
    if (selectedIndex === undefined || items.length < 2) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectItem(selectedIndex - 1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectItem(selectedIndex + 1);
    }
  }

  async function deleteItem(item: GalleryItem) {
    if (!window.confirm(`删除“${item.filename}”？此操作会同时删除私有 R2 原文件。`)) return;
    const response = await fetch(`/api/gallery/${item.id}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.message ?? "作品删除失败");
      return;
    }
    if (selected?.id === item.id) closePreview();
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch("/api/gallery", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? "作品读取失败");
        setItems(body.items ?? []);
      })
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) setError(loadError.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [reload]);

  return (
    <div className="app-shell">
      <AppHeader isMock={false} />
      <main className="gallery-shell">
        <header className="page-heading"><div><h1>作品</h1><p>所有成功输出已转存到私有 R2。</p></div><button type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw size={17} />刷新</button></header>
        {error && <p className="form-error" role="alert">{error}</p>}
        {loading && <div className="gallery-loading" aria-label="正在读取作品"><span /><span /><span /></div>}
        {!loading && items.length === 0 && <div className="gallery-empty"><Images size={30} /><strong>还没有作品</strong><p>运行工作流后，最终输出会出现在这里。</p></div>}
        <div className="cloud-gallery">
          {items.map((item, index) => {
            const isImage = item.mediaType.startsWith("image/");
            const isVideo = item.mediaType.startsWith("video/");
            return (
              <figure key={item.id}>
                <button
                  type="button"
                  className="gallery-media-button"
                  onClick={(event) => openPreview(index, event.currentTarget)}
                  aria-label={`查看${item.workflowName || item.filename}`}
                >
                  {isImage
                    ? <img src={item.url} alt={item.filename} loading="lazy" />
                    : isVideo
                      ? <video src={item.url} muted playsInline preload="metadata" aria-label={item.filename} />
                      : <span className="gallery-file-output"><FileOutput size={28} /><small>{item.mediaType}</small></span>}
                  {isVideo && <span className="gallery-video-badge" aria-hidden="true"><Play size={22} fill="currentColor" /></span>}
                  {(isImage || isVideo) && <span className="gallery-media-button__expand" aria-hidden="true"><Maximize2 size={17} /></span>}
                </button>
                <figcaption><span><strong title={item.workflowName || item.filename}>{item.workflowName || "工作流输出"}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {(item.bytes / 1024 / 1024).toFixed(1)} MB</small></span><a href={item.url} download={item.filename} aria-label="下载原文件" title="下载原文件"><Download size={17} /></a><button type="button" aria-label="删除作品" title="删除作品" onClick={() => void deleteItem(item)}><Trash2 size={17} /></button></figcaption>
              </figure>
            );
          })}
        </div>
        <dialog ref={previewDialog} className="output-preview-dialog gallery-viewer" onClose={restorePreviewFocus} onKeyDown={handlePreviewKey}>
          {selected && (
            <div className="output-preview-dialog__body">
              <header><div><strong>{selected.workflowName || "工作流输出"}</strong><small>{selected.filename} · {selectedIndex! + 1} / {items.length} · {(selected.bytes / 1024 / 1024).toFixed(1)} MB</small></div><button type="button" onClick={closePreview} aria-label="关闭查看器" title="关闭"><X size={19} /></button></header>
              <div className="output-preview-dialog__media">
                {selected.mediaType.startsWith("image/")
                  ? <img src={selected.url} alt={selected.filename} />
                  : selected.mediaType.startsWith("video/")
                    ? <video key={selected.id} src={selected.url} aria-label={selected.filename} controls autoPlay playsInline />
                    : <span className="gallery-file-output"><FileOutput size={34} /><strong>{selected.filename}</strong><small>{selected.mediaType}</small></span>}
              </div>
              <footer>
                <div>{items.length > 1 && <><button type="button" onClick={() => selectItem(selectedIndex! - 1)} aria-label="查看上一个作品" title="上一个作品"><ChevronLeft size={18} /></button><button type="button" onClick={() => selectItem(selectedIndex! + 1)} aria-label="查看下一个作品" title="下一个作品"><ChevronRight size={18} /></button></>}</div>
                <div className="gallery-viewer__actions"><button type="button" onClick={() => void deleteItem(selected)} aria-label="删除当前作品" title="删除当前作品"><Trash2 size={17} /></button><a href={selected.url} download={selected.filename}><Download size={16} />下载原文件</a></div>
              </footer>
            </div>
          )}
        </dialog>
      </main>
    </div>
  );
}

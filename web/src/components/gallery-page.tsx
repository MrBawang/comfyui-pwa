import { Download, Images, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

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

  async function deleteItem(item: GalleryItem) {
    if (!window.confirm(`删除“${item.filename}”？此操作会同时删除私有 R2 原文件。`)) return;
    const response = await fetch(`/api/gallery/${item.id}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.message ?? "作品删除失败");
      return;
    }
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
          {items.map((item) => <figure key={item.id}><div>{item.mediaType.startsWith("video/") ? <video src={item.url} controls preload="metadata" /> : <img src={item.url} alt={item.filename} loading="lazy" />}</div><figcaption><span><strong>{item.workflowName || "工作流输出"}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {(item.bytes / 1024 / 1024).toFixed(1)} MB</small></span><a href={item.url} download={item.filename} title="下载原文件"><Download size={17} /></a><button type="button" title="删除作品" onClick={() => void deleteItem(item)}><Trash2 size={17} /></button></figcaption></figure>)}
        </div>
      </main>
    </div>
  );
}

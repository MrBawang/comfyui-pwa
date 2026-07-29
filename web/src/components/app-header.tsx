import {
  FolderKanban,
  Images,
  MessageSquare,
  MoreHorizontal,
  Play,
  WandSparkles,
  Workflow,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

const navigation = [
  { to: "/projects", label: "项目", desktopLabel: "人物项目", icon: FolderKanban },
  { to: "/", label: "运行", desktopLabel: "运行", icon: Play },
  { to: "/image", label: "生图", desktopLabel: "中转站生图", icon: WandSparkles },
  { to: "/chat", label: "对话", desktopLabel: "对话", icon: MessageSquare },
  { to: "/gallery", label: "作品", desktopLabel: "作品", icon: Images },
  { to: "/workflows", label: "工作流", desktopLabel: "工作流库", icon: Workflow, secondary: true },
  { to: "/more", label: "更多", desktopLabel: "更多", icon: MoreHorizontal },
];

export function AppHeader({ isMock }: { isMock: boolean }) {
  const pathname = useLocation().pathname;
  const [check, setCheck] = useState(0);
  const [connection, setConnection] = useState<"checking" | "connected" | "unavailable" | "demo">(
    isMock ? "demo" : "checking",
  );

  useEffect(() => {
    if (isMock) {
      setConnection("demo");
      return;
    }
    const controller = new AbortController();
    setConnection("checking");
    void fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Cloudflare API 检查失败");
        setConnection("connected");
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setConnection("unavailable");
      });
    return () => controller.abort();
  }, [check, isMock]);

  return (
    <header className="topbar">
      <div className="topbar__main">
        <Link className="brand-lockup" to="/projects">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>LoRAChef Studio</strong><small>Cloud workbench</small></span>
        </Link>
        <nav className="primary-nav" aria-label="主要导航">
          {navigation.map(({ to, label, desktopLabel, icon: Icon, secondary }) => {
            const active = to === "/"
              ? pathname === "/"
              : pathname.startsWith(to) || (to === "/more" && pathname.startsWith("/storage"));
            return (
              <Link
                key={to}
                to={to}
                className={secondary ? "nav-secondary" : undefined}
                aria-current={active ? "page" : undefined}
                title={desktopLabel}
              >
                <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                <span className="nav-label-mobile">{label}</span>
                <span className="nav-label-desktop">{desktopLabel}</span>
              </Link>
            );
          })}
        </nav>
      </div>
      <button
        type="button"
        className={`connection-state connection-state--${connection}`}
        onClick={() => setCheck((current) => current + 1)}
        disabled={connection === "checking" || connection === "demo"}
        aria-live="polite"
        title={connection === "unavailable" ? "工作台 API 当前不可用，点击重试" : undefined}
      >
        <span aria-hidden="true" />
        {connection === "demo" ? "本地界面" : connection === "checking" ? "检查工作台" : connection === "connected" ? "工作台在线" : "工作台离线 · 重试"}
      </button>
    </header>
  );
}

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { CharacterProjects } from "@/components/character-projects";
import { ChatPage } from "@/components/chat-page";
import { GalleryPage } from "@/components/gallery-page";
import { ImageGeneratorPage } from "@/components/image-generator";
import { MorePage } from "@/components/more-page";
import { StorageBrowserPage } from "@/components/storage-browser-page";
import { WorkflowRunner } from "@/components/workflow-runner";
import { Workbench } from "@/components/workbench";
import { CostApprovalProvider } from "@/lib/cost-approval";
import "@/styles.css";

function NotFound() {
  return (
    <main className="page-state">
      <strong>页面不存在</strong>
      <a href="/projects">返回人物项目</a>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CostApprovalProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<WorkflowRunner isMock={false} />} />
          <Route path="/projects" element={<CharacterProjects isMock={false} />} />
          <Route path="/workflows" element={<Workbench isMock={false} />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/image" element={<ImageGeneratorPage />} />
          <Route path="/gallery" element={<GalleryPage />} />
          <Route path="/more" element={<MorePage />} />
          <Route path="/storage" element={<StorageBrowserPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </CostApprovalProvider>
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}

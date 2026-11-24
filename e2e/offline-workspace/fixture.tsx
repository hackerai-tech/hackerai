import { createRoot } from "react-dom/client";
import { LiveWorkspaceFilesPanel } from "@/app/components/WorkspaceFilesPanel";

const root = document.getElementById("root");
if (!root) throw new Error("Workspace QA root is missing");

createRoot(root).render(
  <main>
    <h1>Offline workspace QA</h1>
    <LiveWorkspaceFilesPanel
      chatId="offline-qa"
      environment="cloud"
      messages={[]}
    />
  </main>,
);

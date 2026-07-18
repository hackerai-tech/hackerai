"use client";

import { useEffect, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Id } from "@/convex/_generated/dataModel";
import { useIsMobile } from "@/hooks/use-mobile";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useCreateProject } from "@/app/hooks/useProjects";
import { isTauriEnvironment, pickLocalFolder } from "@/app/hooks/useTauri";

interface ProjectCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: Id<"projects">) => void;
}

const getFolderName = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || "New project";
};

export function ProjectCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: ProjectCreateDialogProps) {
  const createProject = useCreateProject();
  const isMobile = useIsMobile();
  const { desktopBridgeActive } = useGlobalState();
  const [name, setName] = useState("");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isDesktopApp = isTauriEnvironment();
  const folderHelpText = folderPath
    ? desktopBridgeActive
      ? "New Agent tasks will start in this folder."
      : "This folder will be ready for Agent tasks when Desktop finishes connecting."
    : "Use an existing folder to make new Agent tasks start there, or skip this for a lightweight project.";

  useEffect(() => {
    if (!open) {
      setName("");
      setFolderPath(null);
      setIsPickingFolder(false);
      setIsSaving(false);
    }
  }, [open]);

  const setOpen = (nextOpen: boolean) => {
    if (isSaving || isPickingFolder) return;
    onOpenChange(nextOpen);
  };

  const handleChooseFolder = async () => {
    setIsPickingFolder(true);
    try {
      const selectedPath = await pickLocalFolder();
      if (!selectedPath) return;
      setFolderPath(selectedPath);
      setName((currentName) => currentName || getFolderName(selectedPath));
    } finally {
      setIsPickingFolder(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || isSaving) return;

    setIsSaving(true);
    try {
      const projectId = await createProject({
        name: trimmedName,
        ...(folderPath ? { folderPath } : {}),
      });
      onCreated(projectId);
      onOpenChange(false);
      toast.success("Project created");
    } catch (error) {
      console.error("Failed to create project:", error);
      toast.error("Failed to create project", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!isSaving && !isPickingFolder}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>
              {isDesktopApp
                ? "Group related tasks and optionally link a local folder for Agent."
                : "Group related tasks in one place."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-5">
            <div className="space-y-2">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                name="projectName"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New project"
                maxLength={80}
                autoFocus={isMobile === false}
                disabled={isSaving}
              />
            </div>

            {isDesktopApp ? (
              <div className="space-y-2" aria-labelledby="project-folder-label">
                <p
                  id="project-folder-label"
                  className="text-sm font-medium leading-none"
                >
                  Local folder (optional)
                </p>
                {folderPath ? (
                  <div
                    className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3"
                    aria-describedby="project-folder-help"
                  >
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                      title={folderPath}
                    >
                      {folderPath}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      onClick={() => setFolderPath(null)}
                      disabled={isSaving}
                      aria-label="Remove selected folder"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start"
                    onClick={handleChooseFolder}
                    disabled={isPickingFolder || isSaving}
                    aria-describedby="project-folder-help"
                  >
                    <FolderOpen className="size-4" />
                    {isPickingFolder
                      ? "Opening folder picker…"
                      : "Use existing folder"}
                  </Button>
                )}
                <p
                  id="project-folder-help"
                  className="text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  {folderHelpText}
                </p>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isSaving || isPickingFolder}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || isSaving || isPickingFolder}
            >
              {isSaving ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

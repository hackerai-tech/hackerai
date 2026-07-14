"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Laptop, X } from "lucide-react";
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
  const { desktopBridgeActive } = useGlobalState();
  const [name, setName] = useState("");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isDesktopApp = isTauriEnvironment();

  useEffect(() => {
    if (!open) {
      setName("");
      setFolderPath(null);
      setIsPickingFolder(false);
      setIsSaving(false);
    }
  }, [open]);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>
              Group related threads. Desktop projects can also start Agent in a
              selected local folder.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-5">
            <div className="space-y-2">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New project"
                maxLength={80}
                autoFocus
              />
            </div>

            {isDesktopApp ? (
              <div className="space-y-2">
                <p className="text-sm font-medium leading-none">
                  Local folder (optional)
                </p>
                {folderPath ? (
                  <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3">
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
                    disabled={isPickingFolder}
                  >
                    <Laptop className="size-4" />
                    {isPickingFolder
                      ? "Opening folder picker…"
                      : "Choose folder"}
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  {desktopBridgeActive
                    ? "New Agent threads in this project will use this folder as their working directory."
                    : "You can choose a folder while Desktop connects. Agent threads will be available once it is connected."}
                </p>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isSaving}>
              {isSaving ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

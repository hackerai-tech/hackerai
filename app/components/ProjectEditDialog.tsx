"use client";

import { useEffect, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUpdateProject } from "@/app/hooks/useProjects";
import { isTauriEnvironment, pickLocalFolder } from "@/app/hooks/useTauri";
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

interface ProjectEditDialogProps {
  project: Doc<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectEditDialog({
  project,
  open,
  onOpenChange,
}: ProjectEditDialogProps) {
  const updateProject = useUpdateProject();
  const isMobile = useIsMobile();
  const [name, setName] = useState(project.name);
  const [folderPath, setFolderPath] = useState<string | null>(
    project.folder_path ?? null,
  );
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isDesktopApp = isTauriEnvironment();
  const initialFolderPath = project.folder_path ?? null;

  useEffect(() => {
    if (open) {
      setName(project.name);
      setFolderPath(project.folder_path ?? null);
      setIsPickingFolder(false);
    }
  }, [open, project.folder_path, project.name]);

  const setOpen = (nextOpen: boolean) => {
    if (isSaving || isPickingFolder) return;
    onOpenChange(nextOpen);
  };

  const handleChooseFolder = async () => {
    setIsPickingFolder(true);
    try {
      const selectedPath = await pickLocalFolder();
      if (selectedPath) setFolderPath(selectedPath);
    } finally {
      setIsPickingFolder(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || isSaving) return;

    const folderChanged = folderPath !== initialFolderPath;
    if (trimmedName === project.name && !folderChanged) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    try {
      await updateProject({
        projectId: project._id,
        name: trimmedName,
        ...(folderChanged ? { folderPath } : {}),
      });
      toast.success("Project updated");
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to update project:", error);
      toast.error("Failed to update project", {
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
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              Choose a short, recognizable project name.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-5">
            <div className="space-y-2">
              <Label htmlFor={`project-name-${project._id}`}>
                Project name
              </Label>
              <Input
                id={`project-name-${project._id}`}
                name="projectName"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                autoFocus={isMobile === false}
                disabled={isSaving}
              />
            </div>

            {isDesktopApp || folderPath ? (
              <div
                className="space-y-2"
                aria-labelledby={`project-folder-${project._id}`}
              >
                <p
                  id={`project-folder-${project._id}`}
                  className="text-sm font-medium leading-none"
                >
                  Desktop folder{isDesktopApp ? " (optional)" : ""}
                </p>

                {folderPath ? (
                  <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3">
                    <FolderOpen
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                      title={folderPath}
                    >
                      {folderPath}
                    </span>
                    {isDesktopApp ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2"
                          onClick={handleChooseFolder}
                          disabled={isSaving || isPickingFolder}
                        >
                          {isPickingFolder ? "Opening…" : "Change"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0"
                          onClick={() => setFolderPath(null)}
                          disabled={isSaving || isPickingFolder}
                          aria-label="Remove linked folder"
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start"
                    onClick={handleChooseFolder}
                    disabled={isSaving || isPickingFolder}
                  >
                    <FolderOpen className="size-4" aria-hidden="true" />
                    {isPickingFolder
                      ? "Opening folder picker…"
                      : "Use existing folder"}
                  </Button>
                )}

                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {isDesktopApp
                    ? folderPath
                      ? "New Agent tasks will start in this folder."
                      : "Without a linked folder, this remains a lightweight project."
                    : "Open HackerAI Desktop to change or remove this folder."}
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
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUpdateProject } from "@/app/hooks/useProjects";
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
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) setName(project.name);
  }, [open, project.name]);

  const setOpen = (nextOpen: boolean) => {
    if (isSaving) return;
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || isSaving) return;

    if (trimmedName === project.name) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    try {
      await updateProject({ projectId: project._id, name: trimmedName });
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
      <DialogContent className="sm:max-w-md" showCloseButton={!isSaving}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              Choose a short, recognizable project name.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-5">
            <Label htmlFor={`project-name-${project._id}`}>Project name</Label>
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

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

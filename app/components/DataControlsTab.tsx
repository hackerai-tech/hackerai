"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { ManageSharedChatsDialog } from "./ManageSharedChatsDialog";
import { formatTaskUiCopy } from "@/app/utils/task-ui-copy";
import {
  AnalyticsConsentPreferences,
  useAnalyticsConsentPreferencesAvailable,
} from "@/app/components/AnalyticsConsentManager";

import { useDeletionConfirmation } from "@/app/hooks/useDeletionConfirmation";

const DataControlsTab = () => {
  const confirmDeletion = useDeletionConfirmation();
  const { subscription } = useGlobalState();
  const analyticsPreferencesAvailable =
    useAnalyticsConsentPreferencesAvailable();
  const [showDeleteChats, setShowDeleteChats] = useState(false);
  const [isDeletingChats, setIsDeletingChats] = useState(false);
  const [showDeleteSandboxes, setShowDeleteSandboxes] = useState(false);
  const [isDeletingSandboxes, setIsDeletingSandboxes] = useState(false);
  const [showManageSharedChats, setShowManageSharedChats] = useState(false);

  const handleDeleteAllChats = async () => {
    if (isDeletingChats) return;
    setIsDeletingChats(true);
    try {
      await confirmDeletion(
        async () => {
          const response = await fetch("/api/chats", { method: "DELETE" });
          if (!response.ok) {
            throw new Error(
              (await response.text()) || "Failed to delete all tasks",
            );
          }
        },
        {},
        "Deleting all tasks…",
      );

      setShowDeleteChats(false);
      window.location.href = "/";
    } catch (error) {
      console.error("Failed to delete all chats:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to delete all tasks";
      toast.error(formatTaskUiCopy(errorMessage));
    } finally {
      setIsDeletingChats(false);
    }
  };

  const handleDeleteSandboxes = async () => {
    if (isDeletingSandboxes) return;
    setIsDeletingSandboxes(true);
    try {
      const response = await fetch("/api/delete-sandboxes", {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete sandbox");
      }

      toast.success("Terminal sandbox deleted");
      setShowDeleteSandboxes(false);
    } catch (error) {
      console.error("Failed to delete sandbox:", error);
      toast.error("Failed to delete terminal sandbox");
    } finally {
      setIsDeletingSandboxes(false);
    }
  };

  return (
    <div className="space-y-6 min-h-0">
      {/* Manage Shared Chats Section */}
      <div>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">Shared tasks</div>
            <div className="text-sm text-muted-foreground mt-1">
              Manage your publicly shared conversations
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowManageSharedChats(true)}
            aria-label="Manage shared tasks"
          >
            Manage
          </Button>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t" />

      {/* Delete All Chats Section */}
      <div>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">Delete all tasks</div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteChats(true)}
            aria-label="Delete all tasks"
          >
            Delete all
          </Button>
        </div>
      </div>

      {/* Delete Terminal Sandbox Section - Only for subscribed users */}
      {subscription !== "free" && (
        <div>
          <div className="flex items-center justify-between py-3">
            <div>
              <div className="font-medium">Delete terminal sandbox</div>
              <div className="text-sm text-muted-foreground mt-1">
                Remove all files and data from terminal
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowDeleteSandboxes(true)}
              aria-label="Delete terminal sandbox"
            >
              Delete
            </Button>
          </div>
        </div>
      )}

      {analyticsPreferencesAvailable ? (
        <>
          {/* Divider */}
          <div className="border-t" />

          {/* Analytics Cookie Section */}
          <div>
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="font-medium">Analytics cookies</div>
                <div className="text-muted-foreground mt-1 text-sm">
                  Control optional product analytics
                </div>
              </div>
              <AnalyticsConsentPreferences>
                <Button variant="outline" size="sm">
                  Manage
                </Button>
              </AnalyticsConsentPreferences>
            </div>
          </div>
        </>
      ) : null}

      {/* Divider */}
      <div className="border-t" />

      {/* Security & Trust Section */}
      <div className="py-3">
        <div className="text-sm text-muted-foreground">
          Learn how HackerAI handles your data on our{" "}
          <a
            href="/trust"
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            Security &amp; Trust
          </a>{" "}
          page.
        </div>
      </div>

      {/* Delete All Chats Confirmation Dialog */}
      <AlertDialog
        pending={isDeletingChats}
        open={showDeleteChats}
        onOpenChange={setShowDeleteChats}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clear your task history - are you sure?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete all
              your tasks, messages, and their attachments. Saved notes are
              managed separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingChats}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteAllChats();
              }}
              disabled={isDeletingChats}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingChats ? "Deleting..." : "Confirm deletion"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Terminal Sandbox Confirmation Dialog */}
      <AlertDialog
        pending={isDeletingSandboxes}
        open={showDeleteSandboxes}
        onOpenChange={setShowDeleteSandboxes}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete terminal sandbox - are you sure?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently remove all
              files and data from your terminal sandbox. Any running processes
              and active Agent or validation runs will be stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingSandboxes}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteSandboxes();
              }}
              disabled={isDeletingSandboxes}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingSandboxes ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Manage Shared Chats Dialog */}
      <ManageSharedChatsDialog
        open={showManageSharedChats}
        onOpenChange={setShowManageSharedChats}
      />
    </div>
  );
};

export { DataControlsTab };

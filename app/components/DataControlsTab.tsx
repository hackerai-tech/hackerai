"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
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

const DataControlsTab = () => {
  const { subscription } = useGlobalState();
  const [showDeleteChats, setShowDeleteChats] = useState(false);
  const [isDeletingChats, setIsDeletingChats] = useState(false);
  const [showDeleteSandboxes, setShowDeleteSandboxes] = useState(false);
  const [isDeletingSandboxes, setIsDeletingSandboxes] = useState(false);
  const [showManageSharedChats, setShowManageSharedChats] = useState(false);

  const deleteAllChats = useMutation(api.chats.deleteAllChats);

  const handleDeleteAllChats = async () => {
    if (isDeletingChats) return;
    setIsDeletingChats(true);
    try {
      await deleteAllChats();
      setShowDeleteChats(false);
      window.location.href = "/";
    } catch (error) {
      console.error("Failed to delete all chats:", error);
      const errorMessage =
        error instanceof ConvexError
          ? (error.data as { message?: string })?.message ||
            error.message ||
            "Failed to delete all chats"
          : error instanceof Error
            ? error.message
            : "Failed to delete all chats";
      toast.error(errorMessage);
      setShowDeleteChats(false);
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

      toast.success("Successfully deleted terminal sandbox");
    } catch (error) {
      console.error("Failed to delete sandbox:", error);
      toast.error("Failed to delete terminal sandbox");
    } finally {
      setShowDeleteSandboxes(false);
      setIsDeletingSandboxes(false);
    }
  };

  return (
    <div className="space-y-6 min-h-0">
      {/* Manage Shared Chats Section */}
      <div>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">Shared chats</div>
            <div className="text-sm text-muted-foreground mt-1">
              Manage your publicly shared conversations
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowManageSharedChats(true)}
            aria-label="Manage shared chats"
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
            <div className="font-medium">Delete all chats</div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteChats(true)}
            aria-label="Delete all chats"
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

      {/* Delete All Chats Confirmation Dialog */}
      <AlertDialog open={showDeleteChats} onOpenChange={setShowDeleteChats}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clear your chat history - are you sure?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete all
              your chats and remove all associated data from our servers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingChats}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAllChats}
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
              will be stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingSandboxes}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSandboxes}
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

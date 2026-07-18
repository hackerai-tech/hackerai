import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";

const MAX_PROJECT_NAME_LENGTH = 80;
const MAX_FOLDER_PATH_LENGTH = 4096;
const MAX_PROJECTS_PER_USER = 100;
const PROJECT_TASK_DETACH_BATCH_SIZE = 50;

const emptyPage = () => ({
  page: [],
  isDone: true,
  continueCursor: "",
});

const normalizeProjectName = (value: string): string => {
  const name = value.trim();
  if (!name) {
    throw new ConvexError({
      code: "VALIDATION_ERROR",
      message: "Project name cannot be empty",
    });
  }
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ConvexError({
      code: "VALIDATION_ERROR",
      message: `Project name cannot exceed ${MAX_PROJECT_NAME_LENGTH} characters`,
    });
  }
  return name;
};

const normalizeFolderPath = (value?: string): string | undefined => {
  if (value === undefined) return undefined;
  const folderPath = value.trim();
  if (!folderPath) return undefined;
  if (
    /[\u0000-\u001f\u007f]/.test(folderPath) ||
    folderPath.length > MAX_FOLDER_PATH_LENGTH
  ) {
    throw new ConvexError({
      code: "VALIDATION_ERROR",
      message: "Invalid project folder path",
    });
  }
  return folderPath;
};

const getOwnedProject = async (
  ctx: MutationCtx,
  projectId: Id<"projects">,
  userId: string,
) => {
  const project = await ctx.db.get(projectId);
  if (
    !project ||
    project.user_id !== userId ||
    project.deletion_started_at !== undefined
  ) {
    throw new ConvexError({
      code: "PROJECT_NOT_FOUND",
      message: "Project not found",
    });
  }
  return project;
};

const detachNextProjectTasksBatch = async (
  ctx: MutationCtx,
  projectId: Id<"projects">,
  userId: string,
) => {
  const project = await ctx.db.get(projectId);
  if (
    !project ||
    project.user_id !== userId ||
    project.deletion_started_at === undefined
  ) {
    return;
  }

  const tasks = await ctx.db
    .query("chats")
    .withIndex("by_user_project_and_updated", (q) =>
      q.eq("user_id", userId).eq("project_id", projectId),
    )
    .take(PROJECT_TASK_DETACH_BATCH_SIZE + 1);

  for (const task of tasks.slice(0, PROJECT_TASK_DETACH_BATCH_SIZE)) {
    await ctx.db.patch(task._id, { project_id: undefined });
  }

  if (tasks.length > PROJECT_TASK_DETACH_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.projects.detachProjectTasksBatch, {
      projectId,
      userId,
    });
    return;
  }

  await ctx.db.delete(projectId);
};

export const createProject = mutation({
  args: {
    name: v.string(),
    folderPath: v.optional(v.string()),
  },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    const existingProjects = await ctx.db
      .query("projects")
      .withIndex("by_user_and_created", (q) =>
        q.eq("user_id", identity.subject),
      )
      .take(MAX_PROJECTS_PER_USER);
    if (existingProjects.length >= MAX_PROJECTS_PER_USER) {
      throw new ConvexError({
        code: "PROJECT_LIMIT_REACHED",
        message: `You can have up to ${MAX_PROJECTS_PER_USER} projects. Delete one before creating another.`,
      });
    }

    const now = Date.now();
    return ctx.db.insert("projects", {
      user_id: identity.subject,
      name: normalizeProjectName(args.name),
      folder_path: normalizeFolderPath(args.folderPath),
      created_at: now,
      updated_at: now,
    });
  },
});

export const listProjects = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return emptyPage();
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    const isFirstPage =
      args.paginationOpts.cursor == null || args.paginationOpts.cursor === "";
    const pinnedProjects = isFirstPage
      ? await ctx.db
          .query("projects")
          .withIndex("by_user_and_pinned", (q) =>
            q.eq("user_id", identity.subject).gt("pinned_at", 0),
          )
          .filter((q) => q.eq(q.field("deletion_started_at"), undefined))
          .order("desc")
          .take(MAX_PROJECTS_PER_USER)
      : [];

    const result = await ctx.db
      .query("projects")
      .withIndex("by_user_and_created", (q) =>
        q.eq("user_id", identity.subject),
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("pinned_at"), undefined),
          q.eq(q.field("deletion_started_at"), undefined),
        ),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: isFirstPage ? [...pinnedProjects, ...result.page] : result.page,
    };
  },
});

export const updateProject = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    folderPath: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    const updates: {
      name: string;
      updated_at: number;
      folder_path?: string;
    } = {
      name: normalizeProjectName(args.name),
      updated_at: Date.now(),
    };
    if (args.folderPath !== undefined) {
      updates.folder_path =
        args.folderPath === null
          ? undefined
          : normalizeFolderPath(args.folderPath);
    }

    await ctx.db.patch(args.projectId, updates);
    return null;
  },
});

export const pinProject = mutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);
    const project = await getOwnedProject(
      ctx,
      args.projectId,
      identity.subject,
    );
    if (project.pinned_at === undefined) {
      await ctx.db.patch(args.projectId, { pinned_at: Date.now() });
    }
    return null;
  },
});

export const unpinProject = mutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    await ctx.db.patch(args.projectId, {
      pinned_at: undefined,
      updated_at: Date.now(),
    });
    return null;
  },
});

export const deleteProject = mutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
    await assertUserCanAccessChatHistory(ctx, identity.subject);
    await getOwnedProject(ctx, args.projectId, identity.subject);

    await ctx.db.patch(args.projectId, {
      deletion_started_at: Date.now(),
    });
    await detachNextProjectTasksBatch(ctx, args.projectId, identity.subject);
    return null;
  },
});

export const detachProjectTasksBatch = internalMutation({
  args: {
    projectId: v.id("projects"),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await detachNextProjectTasksBatch(ctx, args.projectId, args.userId);
    return null;
  },
});

export const getProjectThreads = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return emptyPage();
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    const project = await ctx.db.get(args.projectId);
    if (
      !project ||
      project.user_id !== identity.subject ||
      project.deletion_started_at !== undefined
    ) {
      return emptyPage();
    }

    const result = await ctx.db
      .query("chats")
      .withIndex("by_user_project_and_updated", (q) =>
        q.eq("user_id", identity.subject).eq("project_id", args.projectId),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    const branchedIds = [
      ...new Set(
        result.page
          .map((chat) => chat.branched_from_chat_id)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const branchedChats = await Promise.all(
      branchedIds.map((id) =>
        ctx.db
          .query("chats")
          .withIndex("by_chat_id", (q) => q.eq("id", id))
          .first(),
      ),
    );
    const branchedTitles = new Map(
      branchedChats
        .filter((chat): chat is NonNullable<typeof chat> => chat !== null)
        .map((chat) => [chat.id, chat.title]),
    );

    return {
      ...result,
      page: result.page.map((chat) => ({
        ...chat,
        ...(chat.branched_from_chat_id
          ? {
              branched_from_title: branchedTitles.get(
                chat.branched_from_chat_id,
              ),
            }
          : {}),
      })),
    };
  },
});

export const getProjectForBackend = query({
  args: {
    serviceKey: v.string(),
    id: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const projectId = ctx.db.normalizeId("projects", args.id);
    if (!projectId) return null;

    const project = await ctx.db.get(projectId);
    if (
      !project ||
      project.user_id !== args.userId ||
      project.deletion_started_at !== undefined
    ) {
      return null;
    }
    return project;
  },
});

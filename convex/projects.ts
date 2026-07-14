import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import { assertUserCanAccessChatHistory } from "./lib/suspensionGuards";

const MAX_PROJECT_NAME_LENGTH = 80;
const MAX_FOLDER_PATH_LENGTH = 4096;
const MAX_PROJECTS_PER_USER = 100;

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
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    await assertUserCanAccessChatHistory(ctx, identity.subject);

    return ctx.db
      .query("projects")
      .withIndex("by_user_and_updated", (q) =>
        q.eq("user_id", identity.subject),
      )
      .order("desc")
      .take(MAX_PROJECTS_PER_USER);
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
    if (!project || project.user_id !== identity.subject) {
      return emptyPage();
    }

    const result = await ctx.db
      .query("chats")
      .withIndex("by_project_and_updated", (q) =>
        q.eq("project_id", args.projectId),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    const ownedPage = result.page.filter(
      (chat) => chat.user_id === identity.subject,
    );
    const branchedIds = [
      ...new Set(
        ownedPage
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
      page: ownedPage.map((chat) => ({
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
    if (!project || project.user_id !== args.userId) return null;
    return project;
  },
});

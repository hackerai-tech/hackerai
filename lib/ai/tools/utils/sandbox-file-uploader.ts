import "server-only";

import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import type { Sandbox } from "@e2b/code-interpreter";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

export type UploadedFileInfo = {
  url: string;
  fileId: Id<"files">;
  tokens: number;
};

let convexClient: ConvexHttpClient | null = null;
function getConvexClient(): ConvexHttpClient {
  if (!convexClient) {
    convexClient = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  }
  return convexClient;
}

export async function uploadSandboxFileToConvex(args: {
  sandbox: Sandbox;
  userId: string;
  fullPath: string;
  skipTokenValidation?: boolean;
}): Promise<UploadedFileInfo> {
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is required for sandbox file uploads",
    );
  }

  if (!process.env.CONVEX_SERVICE_ROLE_KEY) {
    throw new Error(
      "CONVEX_SERVICE_ROLE_KEY is required for sandbox file uploads. " +
        "This is a server-only secret and must never be exposed to the client.",
    );
  }

  const { sandbox, userId, fullPath } = args;
  const convex = getConvexClient();

  const downloadUrl = await sandbox.downloadUrl(fullPath, {
    useSignatureExpiration: 30_000, // 30 seconds
  });

  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(
      `Failed to download ${fullPath}: ${fileRes.status} ${fileRes.statusText}`,
    );
  }

  const blob = await fileRes.blob();
  const mediaType = DEFAULT_MEDIA_TYPE;

  const postUrl = await convex.mutation(api.fileStorage.generateUploadUrl, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    userId,
  });

  const uploadRes = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": mediaType },
    body: blob,
  });
  if (!uploadRes.ok) {
    throw new Error(
      `Upload failed for ${fullPath}: ${uploadRes.status} ${uploadRes.statusText}`,
    );
  }
  const { storageId } = (await uploadRes.json()) as { storageId: string };

  const name = fullPath.split("/").pop() || "file";
  const saved = await convex.action(api.fileActions.saveFile, {
    storageId: storageId as Id<"_storage">,
    name,
    mediaType,
    size: blob.size,
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    userId,
    skipTokenValidation: args.skipTokenValidation,
  });

  return saved as UploadedFileInfo;
}

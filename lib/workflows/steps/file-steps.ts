/**
 * Workflow `"use step"` wrappers around the shared file impl in
 * `lib/ai/tools/utils/file-impl.ts`. Both the AI-SDK file factory and these
 * steps return identical response shapes.
 */
import {
  readFileImpl,
  writeFileImpl,
  appendFileImpl,
  editFileImpl,
  type EditOp,
} from "@/lib/ai/tools/utils/file-impl";
import { connectToSandbox } from "./sandbox-connect";

export async function fileReadStep(args: {
  sandboxId: string;
  path: string;
  range?: [number, number];
}) {
  "use step";
  const sbx = await connectToSandbox(args.sandboxId);
  return readFileImpl(sbx, { path: args.path, range: args.range });
}

export async function fileWriteStep(args: {
  sandboxId: string;
  path: string;
  text: string;
}) {
  "use step";
  const sbx = await connectToSandbox(args.sandboxId);
  return writeFileImpl(sbx, { path: args.path, text: args.text });
}

export async function fileAppendStep(args: {
  sandboxId: string;
  path: string;
  text: string;
}) {
  "use step";
  const sbx = await connectToSandbox(args.sandboxId);
  return appendFileImpl(sbx, { path: args.path, text: args.text });
}

export async function fileEditStep(args: {
  sandboxId: string;
  path: string;
  edits: EditOp[];
}) {
  "use step";
  const sbx = await connectToSandbox(args.sandboxId);
  return editFileImpl(sbx, { path: args.path, edits: args.edits });
}

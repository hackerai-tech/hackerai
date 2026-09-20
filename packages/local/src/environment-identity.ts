import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Publish a complete ID atomically. Concurrent runners reuse the winning file. */
export async function getEnvironmentId(
  directory = join(homedir(), ".hackerai", "local"),
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "environment-id");
  try {
    const id = (await readFile(path, "utf8")).trim();
    if (!UUID.test(id))
      throw new Error("Invalid local environment identity file");
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = randomUUID();
  const temporary = join(directory, `.environment-id-${id}`);
  await writeFile(temporary, `${id}\n`, { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary);
  }
  const winner = (await readFile(path, "utf8")).trim();
  if (!UUID.test(winner))
    throw new Error("Invalid local environment identity file");
  return winner;
}

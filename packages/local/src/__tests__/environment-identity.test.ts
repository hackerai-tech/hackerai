import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvironmentId } from "../environment-identity";

it("keeps identity across concurrent runners and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerai-identity-"));
  try {
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => getEnvironmentId(directory)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await getEnvironmentId(directory)).toBe(ids[0]);
    expect(
      (await readFile(join(directory, "environment-id"), "utf8")).trim(),
    ).toBe(ids[0]);
    await writeFile(join(directory, "environment-id"), "");
    await expect(getEnvironmentId(directory)).rejects.toThrow(
      "Invalid local environment identity",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

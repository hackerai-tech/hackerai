import { createMiosaFiles } from "../miosa-files";

function setup() {
  const sdk = {
    exec: {
      run: jest.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    },
    files: {
      write: jest.fn().mockResolvedValue(undefined),
      readText: jest.fn().mockResolvedValue("content\n\n"),
    },
  };
  return { sdk, files: createMiosaFiles(sdk as never) };
}

describe("MIOSA files share the command container namespace", () => {
  it("stages binary uploads and writes to the container path", async () => {
    const { sdk, files } = setup();
    const content = Uint8Array.from([0, 255, 1]).buffer;
    await files.write("/tmp/quote '雪.bin", content);
    expect(sdk.files.write).toHaveBeenCalledWith(
      expect.stringMatching(/^\/home\/user\/\.hackerai-transfer-/),
      new Uint8Array(content),
    );
    const command = sdk.exec.run.mock.calls[0][0];
    expect(command).toContain("docker exec --workdir /home/user");
    expect(command).toContain("hackerai-agent python3");
    expect(command).toContain("HACKERAI_FILE_OP=write");
    expect(command).toContain("HACKERAI_FILE_PATH=/tmp/quote '\"'\"'雪.bin");
    const stage = sdk.files.write.mock.calls[0][0];
    expect(sdk.exec.run).toHaveBeenLastCalledWith(`rm -f -- '${stage}'`, {
      timeoutSec: 10,
    });
  });
  it("reads container files via a unique shared staging path without trimming", async () => {
    const { sdk, files } = setup();
    await expect(files.read("relative.txt")).resolves.toBe("content\n\n");
    expect(sdk.exec.run.mock.calls[0][0]).toContain("HACKERAI_FILE_OP=read");
    expect(sdk.exec.run.mock.calls[0][0]).toContain(
      "HACKERAI_FILE_PATH=relative.txt",
    );
    expect(sdk.files.readText).toHaveBeenCalledWith(
      expect.stringMatching(/^\/home\/user\/\.hackerai-transfer-/),
    );
  });
  it("attempts cleanup after failure and preserves the original error", async () => {
    const { sdk, files } = setup();
    sdk.files.write.mockRejectedValue(new Error("upload failed"));
    sdk.exec.run.mockRejectedValue(new Error("cleanup failed"));
    await expect(files.write("/tmp/x", "x")).rejects.toThrow("upload failed");
    expect(sdk.exec.run).toHaveBeenCalledWith(
      expect.stringContaining("rm -f --"),
      { timeoutSec: 10 },
    );
  });
  it("does not confuse an unreachable sandbox with a missing file", async () => {
    const { sdk, files } = setup();
    sdk.exec.run.mockRejectedValue(new Error("HTTP 503"));
    await expect(files.exists("/tmp/x")).rejects.toThrow("HTTP 503");
    sdk.exec.run.mockResolvedValue({
      stdout: "false\n",
      stderr: "",
      exitCode: 0,
    });
    await expect(files.exists("/tmp/x")).resolves.toBe(false);
  });
  it("maps metadata and lists from the container", async () => {
    const { sdk, files } = setup();
    sdk.exec.run.mockResolvedValueOnce({
      stdout: JSON.stringify({
        size: 123,
        isDir: false,
        modifiedAt: 1000,
        symlinkTarget: "/tmp/a",
      }),
      stderr: "",
      exitCode: 0,
    });
    await expect(files.getInfo("/tmp/link")).resolves.toEqual({
      type: "file",
      size: 123,
      modifiedTime: new Date(1000),
      symlinkTarget: "/tmp/a",
    });
    sdk.exec.run.mockResolvedValueOnce({
      stdout: '[{"name":"a","path":"/tmp/a"}]',
      stderr: "",
      exitCode: 0,
    });
    await expect(files.list("/tmp")).resolves.toEqual([
      { name: "a", path: "/tmp/a" },
    ]);
  });
});

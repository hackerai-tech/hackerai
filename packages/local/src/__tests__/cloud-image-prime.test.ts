import {
  CloudImagePrimeError,
  primeCloudImageWorkingSet,
} from "../cloud-image-prime";

describe("Lambda MicroVM image priming", () => {
  it("primes the bounded relay, DNS, PTY, shell, sudo, nmap, and naabu paths", async () => {
    const calls: string[] = [];
    const result = await primeCloudImageWorkingSet({
      primeRelay: async () => calls.push("relay"),
      lookupDns: async () => calls.push("dns"),
      primePty: async () => calls.push("pty"),
      runCommand: async (executable, args) =>
        calls.push(`${executable} ${args.join(" ")}`),
    });

    expect(calls).toEqual([
      "relay",
      "dns",
      "pty",
      "/bin/bash --noprofile --norc -c :",
      "/usr/bin/sudo -n true",
      "/usr/bin/nmap --version",
      "/usr/local/bin/naabu -version",
    ]);
    expect(result.steps.map((step) => step.name)).toEqual([
      "relay_protocol",
      "dns_lookup",
      "pty",
      "bash",
      "sudo",
      "nmap",
      "naabu",
    ]);
  });

  it("fails validation at the first required priming failure", async () => {
    const runCommand = jest.fn(async (executable: string) => {
      if (executable === "/usr/bin/nmap") throw new Error("missing nmap");
    });

    await expect(
      primeCloudImageWorkingSet({
        primeRelay: async () => undefined,
        lookupDns: async () => undefined,
        primePty: async () => undefined,
        runCommand,
      }),
    ).rejects.toMatchObject<Partial<CloudImagePrimeError>>({
      name: "CloudImagePrimeError",
      step: "nmap",
    });
    expect(runCommand).not.toHaveBeenCalledWith(
      "/usr/local/bin/naabu",
      expect.anything(),
    );
  });
});

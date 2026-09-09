export type MiosaRuntime = "docker" | "native";

export type MiosaRuntimeCommandOptions = {
  cwd?: string;
  envVars?: Record<string, string>;
  envs?: Record<string, string>;
};

export const quoteMiosaShell = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

/** Use the acquired workspace's template, never the requested create template. */
export function miosaRuntimeForTemplate(templateId?: string): MiosaRuntime {
  return templateId === "hackerai-tools" ? "native" : "docker";
}

export function miosaRuntimeCommand(
  runtime: MiosaRuntime,
  command: string,
  options: MiosaRuntimeCommandOptions = {},
  interactive = false,
): string {
  const env = { ...options.envVars, ...options.envs };
  const cwd = quoteMiosaShell(options.cwd ?? "/home/user");
  if (runtime === "native") {
    const assignments = Object.entries({ HOME: "/home/user", ...env })
      .map(([key, value]) => quoteMiosaShell(`${key}=${value}`))
      .join(" ");
    // Login/logout profiles can emit terminal-control bytes into streamed tool
    // output. Native tools already live on PATH; do not run interactive setup.
    return `env -- ${assignments} bash --noprofile --norc -c ${quoteMiosaShell(`cd -- ${cwd} || exit; ${command}`)}`;
  }
  const envArgs = Object.entries(env).flatMap(([key, value]) => [
    "--env",
    quoteMiosaShell(`${key}=${value}`),
  ]);
  return [
    interactive ? "docker exec -it" : "docker exec",
    "--workdir",
    cwd,
    ...envArgs,
    quoteMiosaShell("hackerai-agent"),
    "bash -lc",
    quoteMiosaShell(command),
  ].join(" ");
}

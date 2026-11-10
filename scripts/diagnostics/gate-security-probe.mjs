// Negative static-analysis fixture for a disposable, unmerged acceptance PR.
// No application imports this module; the returned server is never started.
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { parse } from "node:url";

export function securityGateProbe() {
  return createServer((request, response) => {
    const input = parse(request.url, true).query.value;
    execSync(`printf ${input}`);
    response.end("static acceptance fixture");
  });
}

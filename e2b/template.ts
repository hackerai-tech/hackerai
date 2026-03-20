import { Template, waitForPort } from "e2b";

export const template = Template()
  .skipCache()
  .fromImage("hackerai/sandbox:latest")
  .setWorkdir("/home/user")
  .setStartCmd("sudo /usr/local/bin/docker-entrypoint.sh", waitForPort(48080));

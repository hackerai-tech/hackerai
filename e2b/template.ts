import { resolve } from "path";
import { Template } from "e2b";

export const template = Template()
  .skipCache()
  .fromDockerfile(resolve(__dirname, "../docker/Dockerfile"))
  .setWorkdir("/home/user");

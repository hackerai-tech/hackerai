import { resolve } from "path";
import { Template } from "e2b";

export const template = Template({
  fileContextPath: resolve(__dirname, "../docker"),
})
  .skipCache()
  .fromDockerfile(resolve(__dirname, "../docker/Dockerfile"))
  .setWorkdir("/home/user");

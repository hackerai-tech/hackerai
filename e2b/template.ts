import { Template } from "e2b";

export const template = Template()
  .skipCache()
  .fromImage("hackerai/sandbox:latest")
  .setWorkdir("/home/user");

import { Template } from "e2b";

export const template = Template()
  .fromImage("hackerai/sandbox:latest")
  .setWorkdir("/home/user");

import { Axiom } from "@axiomhq/js";

const axiomClient = new Axiom({
  token: process.env.AXIOM_TOKEN!,
});

export default axiomClient;

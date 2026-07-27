import { defineApp } from "convex/server";
import aggregate from "@convex-dev/aggregate/convex.config.js";
import migrations from "@convex-dev/migrations/convex.config.js";

const app = defineApp();
app.use(aggregate, { name: "fileCountByUser" });
app.use(migrations);

export default app;

import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "veto", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});

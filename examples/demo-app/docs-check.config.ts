import { defineConfig, envRegistry } from "@foreman-kit/docs-check";

export default defineConfig({
  registries: [envRegistry({ doc: "docs/configuration.md" })],
});

import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import { readFile } from "node:fs/promises";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

const markdownAsText = {
  name: "markdown-as-text",
  async load(id) {
    const path = id.endsWith(".md?raw") ? id.slice(0, -4) : id;
    if (!path.endsWith(".md")) return null;
    return `export default ${JSON.stringify(await readFile(path, "utf8"))};`;
  },
};

function withPlugins(config) {
  if (!config) return null;
  return {
    ...config,
    plugins: [
      markdownAsText,
      nodeResolve({
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
        declarationMap: false,
      }),
    ],
  };
}

export default [
  withPlugins(presets.rollup.manifest),
  withPlugins(presets.rollup.worker),
  withPlugins(presets.rollup.ui),
].filter(Boolean);

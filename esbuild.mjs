import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const context = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  sourcemap: true,
  target: "node20",
});

if (watch) {
  await context.watch();
  console.log("文字コード・改行チェックの変更を監視しています...");
} else {
  await context.rebuild();
  await context.dispose();
}

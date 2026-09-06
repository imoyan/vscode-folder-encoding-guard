import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import console from "node:console";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = process.env.VSCODE_EXECUTABLE ?? (process.platform === "darwin"
  ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : undefined);
if (!executable) throw new Error("VSCODE_EXECUTABLEにVS Code実行ファイルを指定してください。");
await fs.access(executable);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "folder-encoding-host-"));
try {
  const extension = path.join(temporary, "extension");
  const plain = path.join(temporary, "plain");
  const tracked = path.join(temporary, "tracked");
  await Promise.all([extension, plain, tracked].map((dir) => fs.mkdir(dir)));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  await fs.writeFile(path.join(extension, "package.json"), JSON.stringify({ ...manifest, main: "./extension.cjs", activationEvents: [] }));
  const workspace = path.join(temporary, "test.code-workspace");
  await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: plain }, { path: tracked }], settings: { "security.workspace.trust.enabled": false, "git.openRepositoryInParentFolders": "never" } }));
  await fs.writeFile(path.join(tracked, "history.txt"), "履歴\n");
  for (const args of [["init"], ["add", "history.txt"], ["-c", "user.name=Host Test", "-c", "user.email=host@example.invalid", "commit", "-m", "テスト用基準"]]) {
    const result = spawnSync("git", args, { cwd: tracked, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const shared = { bundle: true, platform: "node", format: "cjs", target: "node20", absWorkingDir: root };
  const driverPlugin = {
    name: "shared-test-driver",
    setup(build) {
      build.onResolve({ filter: /hostDriver\.js$/ }, () => ({ path: "./driver.cjs", external: true }));
    },
  };
  await esbuild.build({ ...shared, entryPoints: ["test/host/hostDriver.ts"], outfile: path.join(extension, "driver.cjs"), external: ["vscode"] });
  await esbuild.build({ ...shared, entryPoints: ["src/extension.ts"], outfile: path.join(extension, "extension.cjs"), plugins: [driverPlugin, {
    name: "automated-dialogs",
    setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(root, "test/host/vscodeProxy.ts") }));
    },
  }] });
  await esbuild.build({ ...shared, entryPoints: ["test/host/suite.ts"], outfile: path.join(extension, "suite.cjs"), external: ["vscode"], plugins: [driverPlugin] });
  const env = { ...process.env };
  env.FEG_HOST_RESULT = path.join(temporary, "passed.txt");
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [workspace, "--new-window", "--skip-welcome", "--skip-release-notes", "--disable-updates", "--disable-workspace-trust", "--disable-extensions", "--user-data-dir", path.join(temporary, "profile"), "--extensions-dir", path.join(temporary, "extensions"), "--extensionDevelopmentPath", extension, "--extensionTestsPath", path.join(extension, "suite.cjs")], { env, stdio: "inherit", timeout: 180000 });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) throw new Error(`Extension Host failed: ${JSON.stringify(result)}`);
  if (await fs.readFile(env.FEG_HOST_RESULT, "utf8") !== "passed") throw new Error("テスト完了を確認できません。");
  console.log("Extension Hostの操作フローテストが成功しました。");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

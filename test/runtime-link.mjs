// 复现并验证 2026-10-24「桌面 0.2.1-rc.3 升级后无法启动」的修复。
//
// 事故：解包官方 app.asar 后，官方 `dsh` CLI（dsh-desktop-host/lib/cli.js）只认密封包布局，
// 用 `join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), "runtime")` 推导 supportDir。
// 解包后 runtimeDir 是 `resources/app/dsh`，dirname 落在 `resources/app`，于是老版本插件在
// `resources/app/runtime` 建了一个指向 `resources/runtime` 的 junction。Windows 上 NSIS 的
// `RMDir /r` 会跟随 reparse point：清 `resources` 时把 `resources\runtime` 的内容删空、只留下
// junction 和空目录，官方包体里的 runtime 一旦没被重新解开，桌面端下次启动读
// `resources\runtime\office-skills\office\SKILL.md` 就 ENOENT，弹「could not start」。
//
// 本测试断言：
//   1. reparse point 助手只摘链接、绝不动链接目标；
//   2. 官方 CLI 原文能被补丁命中，补丁后的 supportRoot 在密封 / 解包两种布局下都落在
//      `resources/runtime`；
//   3. CLI 可补时 `repairOfficialCliAfterUnpack` **不**留 junction（盘上没有 reparse point）；
//   4. CLI 原文对不上时回退保留 junction，`dsh` CLI 不会 MODULE_NOT_FOUND。
//
// usage: node test/runtime-link.mjs [pluginDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = process.argv[2] || path.resolve(here, "..");
const load = (name) => import(pathToFileURL(path.join(pluginDir, "lib", name)).href);

const reparse = await load("reparse.js");
const desktop = await load("desktop.js");

let pass = 0;
let fail = 0;
function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? "  <- " + detail : ""}`);
  }
}

// 官方 0.2.1-rc.2 / rc.3 原文（只保留补丁锚点相关的部分）。
const CLI_SNIPPET = `import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
function runtimeArchivePath(runtimeDir) {
	const parent = dirname(runtimeDir);
	return basename(parent) === "app.asar" ? parent : void 0;
}
if (import.meta.main) {
	const runtimeDir = resolve(import.meta.dirname, "../../../..");
	await runDesktopCli(runtimeDir, join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), "runtime"));
}
`;

const INDEX_SNIPPET = `import { basename, delimiter, dirname, join, relative } from "node:path";
async function main() {
	const runtimeDir = process.argv[2];
	await ctx.plugin(office_exports, {
		runtimeDir,
		source: process.argv[4] ?? join(runtimeDir, "..", "runtime", "primary-runtime"),
		root: join(process.env.DSH_HOME, "dsh-runtimes", "dsh-primary-runtime")
	});
}
`;

function makeFakeInstall({ cliText = CLI_SNIPPET, indexText = INDEX_SNIPPET } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-runtime-"));
  const resources = path.join(root, "resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), "stub");
  const exe = path.join(root, "DeepSeek Harness.exe");
  fs.writeFileSync(exe, "stub");
  const libDir = path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib");
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, "cli.js"), cliText);
  fs.writeFileSync(path.join(libDir, "index.js"), indexText);
  fs.mkdirSync(path.join(resources, "runtime", "office-skills", "office"), { recursive: true });
  fs.writeFileSync(path.join(resources, "runtime", "office-skills", "office", "SKILL.md"), "# office\n");
  fs.mkdirSync(path.join(resources, "runtime", "primary-runtime"), { recursive: true });
  fs.writeFileSync(path.join(resources, "runtime", "primary-runtime", "runtime.json"), "{}\n");
  return { root, exe, resources, libDir };
}

function linkExists(link) {
  try {
    fs.lstatSync(link);
    return true;
  } catch {
    return false;
  }
}

/** 从补丁后的文本里取出 dshPurgeSupportRoot，用与官方相同的 runtimeArchivePath 语义求值。 */
function evalSupportRoot(patchedText) {
  const match = /function dshPurgeSupportRoot\(runtimeDir\) \{[\s\S]*?\n\}/u.exec(patchedText);
  if (!match) return null;
  const runtimeArchivePath = (runtimeDir) => {
    const parent = path.dirname(runtimeDir);
    return path.basename(parent) === "app.asar" ? parent : undefined;
  };
  const factory = new Function(
    "runtimeArchivePath",
    "dirname",
    "basename",
    `${match[0]}\nreturn dshPurgeSupportRoot;`,
  );
  return factory(runtimeArchivePath, path.dirname, path.basename);
}

console.log("\n== reparse helpers ==");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-reparse-"));
  const runtime = path.join(root, "resources", "runtime");
  const app = path.join(root, "resources", "app");
  fs.mkdirSync(path.join(runtime, "sub"), { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(runtime, "keep.txt"), "keep");
  fs.writeFileSync(path.join(runtime, "sub", "deep.txt"), "deep");

  fs.symlinkSync("..\\runtime", path.join(app, "runtime"), process.platform === "win32" ? "junction" : "dir");
  const link = path.join(app, "runtime");
  check("junction is detected as a reparse point", reparse.isReparsePoint(link));
  check("plain directory is not a reparse point", !reparse.isReparsePoint(app));
  check("hasNoReparsePoints false while the link exists", !reparse.hasNoReparsePoints(app));

  const removed = reparse.pruneReparsePoints(app);
  check("pruneReparsePoints reports the link", removed.length === 1, JSON.stringify(removed));
  check("link itself is gone", !linkExists(link));
  check("link target contents survive", fs.existsSync(path.join(runtime, "keep.txt")) && fs.existsSync(path.join(runtime, "sub", "deep.txt")));
  check("hasNoReparsePoints true after pruning", reparse.hasNoReparsePoints(app));

  // 真实路径不能当链接删掉。
  check("unlinkReparsePoint refuses a real directory", reparse.unlinkReparsePoint(app) === false && fs.existsSync(app));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n== official CLI patch ==");
{
  const fake = makeFakeInstall();
  const report = await desktop.patchHostCliSupportDir(fake.resources);
  check("both host CLI files patched", report.length === 2 && report.every((row) => row.status === "patched"), JSON.stringify(report));

  const cliText = fs.readFileSync(path.join(fake.libDir, "cli.js"), "utf8");
  const indexText = fs.readFileSync(path.join(fake.libDir, "index.js"), "utf8");
  check("cli.js keeps a .dsh-purge.bak of the official text", fs.readFileSync(`${path.join(fake.libDir, "cli.js")}.dsh-purge.bak`, "utf8") === CLI_SNIPPET);
  check("index.js keeps a .dsh-purge.bak of the official text", fs.readFileSync(`${path.join(fake.libDir, "index.js")}.dsh-purge.bak`, "utf8") === INDEX_SNIPPET);

  const supportRoot = evalSupportRoot(cliText);
  check("supportRoot helper was injected", typeof supportRoot === "function");
  if (typeof supportRoot === "function") {
    const sealed = supportRoot(path.join(fake.root, "resources", "app.asar", "dsh"));
    const unpacked = supportRoot(path.join(fake.root, "resources", "app", "dsh"));
    check("sealed layout supportDir stays resources/runtime", path.join(sealed, "runtime") === path.join(fake.resources, "runtime"), sealed);
    check("unpacked layout supportDir resolves to resources/runtime", path.join(unpacked, "runtime") === path.join(fake.resources, "runtime"), unpacked);
  }
  check("cli.js no longer derives the support dir from runtimeDir alone", !cliText.includes("join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), \"runtime\")"));
  check("index.js primaryRuntime fallback uses the helper", indexText.includes("join(dshPurgeSupportRoot(runtimeDir), \"runtime\", \"primary-runtime\")"));

  const again = await desktop.patchHostCliSupportDir(fake.resources);
  check("second run is idempotent", again.every((row) => row.status === "already"), JSON.stringify(again));
  fs.rmSync(fake.root, { recursive: true, force: true });
}

console.log("\n== repairOfficialCliAfterUnpack ==");
{
  // ① CLI 可补：不留 junction。
  const fake = makeFakeInstall();
  const report = await desktop.repairOfficialCliAfterUnpack(fake.exe);
  check("report.ok", report.ok === true, JSON.stringify(report));
  check("host CLI rows patched", report.hostCli.every((row) => row.status === "patched"), JSON.stringify(report.hostCli));
  check("no app/runtime reparse point left behind", !linkExists(path.join(fake.resources, "app", "runtime")), JSON.stringify(report.symlink));
  check("resources/runtime untouched", fs.existsSync(path.join(fake.resources, "runtime", "office-skills", "office", "SKILL.md")));
  fs.rmSync(fake.root, { recursive: true, force: true });

  // ② 老安装里已经存在的 junction：补丁打上后要摘掉，且不能动 runtime 内容。
  const fake3 = makeFakeInstall();
  const link3 = path.join(fake3.resources, "app", "runtime");
  fs.symlinkSync("..\\runtime", link3, process.platform === "win32" ? "junction" : "dir");
  check("migration fixture has a pre-existing app/runtime link", reparse.isReparsePoint(link3));
  const report3 = await desktop.repairOfficialCliAfterUnpack(fake3.exe);
  check("migration drops the pre-existing link", !linkExists(link3), JSON.stringify(report3.symlink));
  check(
    "migration keeps runtime contents",
    fs.existsSync(path.join(fake3.resources, "runtime", "office-skills", "office", "SKILL.md"))
      && fs.existsSync(path.join(fake3.resources, "runtime", "primary-runtime", "runtime.json")),
  );
  fs.rmSync(fake3.root, { recursive: true, force: true });

  // ③ CLI 原文对不上（官方改版）：回退保留 junction，`dsh` CLI 不能挂。
  const mutated = CLI_SNIPPET.replace("await runDesktopCli(runtimeDir,", "await runDesktopCli$1(runtimeDir,");
  const fake2 = makeFakeInstall({ cliText: mutated });
  const report2 = await desktop.repairOfficialCliAfterUnpack(fake2.exe);
  const link = path.join(fake2.resources, "app", "runtime");
  check("cli.js reports pattern_not_found", report2.hostCli.find((row) => row.file === "cli.js")?.status === "pattern_not_found", JSON.stringify(report2.hostCli));
  check("fallback keeps the app/runtime link", linkExists(link) && reparse.isReparsePoint(link));
  check("fallback link resolves to resources/runtime", fs.realpathSync(link) === fs.realpathSync(path.join(fake2.resources, "runtime")));
  fs.rmSync(fake2.root, { recursive: true, force: true });
}

console.log("\n== desktopRuntimeGuard ==");
{
  const coreModule = await load("core.js");
  const fake = makeFakeInstall();
  const input = { execPath: fake.exe, resourcesPath: "", argv: [], env: {} };
  const ok = coreModule.desktopRuntimeGuard(input);
  check("guard reports a complete runtime", Boolean(ok) && ok.complete === true, JSON.stringify(ok));
  check("guard sees no app/runtime link when none exists", Boolean(ok) && ok.app_link === false);

  // 复现事故现场：runtime 目录还在，内容被删空。
  fs.rmSync(path.join(fake.resources, "runtime", "office-skills"), { recursive: true, force: true });
  fs.rmSync(path.join(fake.resources, "runtime", "primary-runtime", "runtime.json"), { force: true });
  const broken = coreModule.desktopRuntimeGuard(input);
  check("guard flags the emptied runtime", Boolean(broken) && broken.complete === false && broken.missing.length === 2, JSON.stringify(broken));
  fs.rmSync(fake.root, { recursive: true, force: true });
}

console.log("\n== real install (optional) ==");
{
  const candidates = [
    process.env.DSH_PURGE_HOST_CLI,
    process.env.DSH_PURGE_DESKTOP_EXE
      ? path.join(path.dirname(process.env.DSH_PURGE_DESKTOP_EXE), "resources", "app", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js")
      : "",
    "D:\\software\\dsh\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js",
  ].filter(Boolean);
  const real = candidates.find((fp) => {
    try {
      return fs.statSync(fp).isFile();
    } catch {
      return false;
    }
  });
  if (!real) {
    console.log("  skip  no unpacked official host CLI on this machine (sealed install or other platform)");
  } else {
    const text = fs.readFileSync(real, "utf8");
    const pattern = /await runDesktopCli\(runtimeDir, join\(dirname\(runtimeArchivePath\(runtimeDir\) \?\? runtimeDir\), "runtime"\)\);/u;
    check(`patch pattern still matches ${real}`, pattern.test(text) || text.includes("function dshPurgeSupportRoot("));
  }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

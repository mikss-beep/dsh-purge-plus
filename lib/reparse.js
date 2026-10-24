/**
 * Windows reparse point（junction / 目录符号链接）安全助手。
 *
 * 背景（2026-10-24 桌面 0.2.1-rc.3 升级事故）：
 * 解包官方 app.asar 后，官方 `dsh` CLI 会用
 * `join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), "runtime")` 推导
 * supportDir。密封包布局下 runtimeDir 是 `resources/app.asar/dsh`，dirname 正好是
 * `resources`；解包布局下 runtimeDir 变成 `resources/app/dsh`，dirname 是
 * `resources/app` —— 于是老版本插件在 `resources/app/runtime` 建了一个 junction
 * 指向 `resources/runtime`，让 CLI 能找到 primary-runtime / bin。
 *
 * 问题：Windows 上任何**递归枚举**（NSIS 卸载器的 `RMDir /r`、WSH 的
 * `FileSystemObject.DeleteFolder`）都会跟随 reparse point。官方安装器清
 * `resources` 时顺着这个 junction 把 `resources\runtime` 的内容删空、只留下
 * junction 自己和空目录；官方包体里的 runtime 一旦没被重新解开，桌面端启动时读
 * `resources\runtime\office-skills\office\SKILL.md` 就 ENOENT 直接弹窗退出。
 *
 * Node 的 `fs.rmSync(..., { recursive: true })` 用 lstat 判断、只 unlink 链接本身，
 * 不会跟进去（Node 22 / 24 实测都安全），所以真正的危险来自 Node 之外的递归删除。
 * 对策有两层：
 *   1) 不再留 junction（见 desktop.js 的 patchHostCliSupportDir）；
 *   2) 交给任何递归删除之前，先把树里的 reparse point 摘掉（本模块）。
 */
import nodeFs from "node:fs";
import path from "node:path";

/**
 * 是否为 reparse point（junction / 目录符号链接 / 文件符号链接）。
 * Node 在 Windows 上把 junction 也报成 symlink，但为兼容外部 `mklink /J` 造的
 * 挂载点，目录再多做一次 readlink 兜底。
 */
export function isReparsePoint(target) {
  let stat;
  try {
    stat = nodeFs.lstatSync(target);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false;
  try {
    nodeFs.readlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/** 只摘链接本身，绝不动链接目标。非链接返回 false。 */
export function unlinkReparsePoint(target) {
  if (!isReparsePoint(target)) return false;
  // Windows 上目录 junction 走 rmdir，符号链接走 unlink；两个都试一遍最省心。
  try {
    nodeFs.rmdirSync(target);
    return true;
  } catch {
    /* 落到 unlink */
  }
  try {
    nodeFs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 深度优先摘掉 root 下所有 reparse point（不跟随它们）。
 * 交给 NSIS / WSH / robocopy 这类会跟随链接的递归删除之前调用。
 * @returns 已摘掉的链接路径（诊断用）。
 */
export function pruneReparsePoints(root, { maxDepth = 16 } = {}) {
  const removed = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isReparsePoint(full)) {
        if (unlinkReparsePoint(full)) removed.push(full);
        continue;
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return removed;
}

/** 目录不存在、或者存在但里面没有 reparse point 时返回 true。 */
export function hasNoReparsePoints(root) {
  if (!nodeFs.existsSync(root)) return true;
  let entries = [];
  try {
    entries = nodeFs.readdirSync(root, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (isReparsePoint(full)) return false;
    if (entry.isDirectory() && !hasNoReparsePoints(full)) return false;
  }
  return true;
}

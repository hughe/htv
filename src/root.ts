import * as fs from "fs";
import * as path from "path";

export interface ServerRoot {
  /** Directory whose contents the server is allowed to serve. */
  root: string;
  /** True when no .git was found and we fell back to the file's directory. */
  fallback: boolean;
}

/**
 * Find the server root for a file: the nearest ancestor directory that
 * contains a .git entry (a directory for normal repos, a file for
 * worktrees/submodules — both count). If none exists, fall back to the
 * file's own directory.
 */
export function findServerRoot(absFile: string): ServerRoot {
  let dir = path.dirname(path.resolve(absFile));
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return { root: dir, fallback: false };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: path.dirname(path.resolve(absFile)), fallback: true };
}

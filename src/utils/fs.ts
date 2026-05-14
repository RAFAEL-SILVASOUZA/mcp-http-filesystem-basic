import { readdir, readFile, access } from "fs/promises";
import { join, relative } from "path";

/**
 * Loads .gitignore patterns from the base directory.
 * Returns an array of patterns, removing comments and empty lines.
 */
export async function loadGitignore(baseDir: string): Promise<string[]> {
  const gitignorePath = join(baseDir, ".gitignore");
  try {
    await access(gitignorePath);
    const content = await readFile(gitignorePath, "utf-8");
    return content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Checks if a path matches any of the provided gitignore patterns.
 */
export function isIgnored(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith("/")) {
      const dirPattern = pattern.slice(0, -1);
      if (path.startsWith(dirPattern + "/") || path === dirPattern) {
        return true;
      }
    }
    else if (path === pattern || path.endsWith("/" + pattern)) {
      return true;
    }
    else if (pattern.includes("*")) {
      const regexPattern = pattern
        .replace(/\./g, "\\.")
        .replace(/\*/g, ".*");
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(path)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Recursively explores a directory and lists files and subdirectories.
 */
export async function exploreDirectory(
  dirPath: string,
  maxDepth: number,
  currentDepth: number = 0,
  baseDir: string = dirPath,
  gitignorePatterns: string[] = []
): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];

  if (currentDepth > maxDepth) {
    return { files, directories };
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      let relativePath = relative(baseDir, fullPath);
      relativePath = relativePath.split("\\").join("/");

      if (isIgnored(relativePath, gitignorePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        directories.push(relativePath);
        if (currentDepth < maxDepth) {
          const subResult = await exploreDirectory(fullPath, maxDepth, currentDepth + 1, baseDir, gitignorePatterns);
          files.push(...subResult.files);
          directories.push(...subResult.directories);
        }
      } else {
        files.push(relativePath);
      }
    }
  } catch (error) {
    throw new Error(`Error reading directory ${dirPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { files, directories };
}

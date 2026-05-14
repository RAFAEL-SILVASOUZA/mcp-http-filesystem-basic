import { isAbsolute, resolve, relative } from "path";

/**
 * Validates that the given path is within the allowed workspace root.
 * Throws an error if the path attempts to escape the workspace via path traversal.
 */
export function validatePathInWorkspace(
  filePath: string,
  workspaceRoot: string
): string {
  // Resolve the file path to an absolute path
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceRoot, filePath);

  // Normalize the workspace root
  const normalizedRoot = resolve(workspaceRoot);

  // Check if the path is within the workspace root
  const relativePath = relative(normalizedRoot, absolutePath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Access denied: path '${filePath}' is outside the workspace root.`);
  }

  return absolutePath;
}

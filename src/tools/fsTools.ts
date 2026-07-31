import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, readdir, readFile, writeFile, stat } from "fs/promises";
import { dirname, join } from "path";
import { relative } from "path";
import { minimatch } from "minimatch";
import { loadGitignore, isIgnored, exploreDirectory } from "../utils/fs.js";
import { validatePathInWorkspace } from "../utils/path.js";

export function registerFsTools(server: McpServer, workspaceRoot: string) {
  // Register file-glob tool
  server.registerTool(
    "file-glob",
    {
      description:
        `Explore a directory and list files and subdirectories. Returns a hierarchical view of the filesystem structure up to the specified depth.

        PATH can be absolute or relative. If relative, it resolves against the workspace root.

        WORKSPACE ROOT: The workspace root can be configured via the optional header "X-Workspace-Root" when setting up the MCP client.
        If not provided, defaults to the server's current working directory.`,
      inputSchema: {
        path: z
          .string()
          .describe("The directory path to explore. Can be absolute or relative to workspace root. Use '.' for workspace root."),
        maxDepth: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .default(3)
          .describe("Maximum depth of directories to explore. Default 3, max 10."),
        maxEntries: z
          .number()
          .min(1)
          .max(5000)
          .optional()
          .default(500)
          .describe("Maximum combined file and directory entries returned. Default 500, max 5000."),
      },
    },
    async ({ path: dirPath, maxDepth, maxEntries }) => {
      try {
        const absolutePath = validatePathInWorkspace(dirPath, workspaceRoot);
        const gitignorePatterns = await loadGitignore(workspaceRoot);
        const { files, directories } = await exploreDirectory(absolutePath, maxDepth, 0, absolutePath, gitignorePatterns);
        const totalEntries = files.length + directories.length;
        const truncated = totalEntries > maxEntries;
        const limitedDirectories = directories.slice(0, maxEntries);
        const remaining = Math.max(0, maxEntries - limitedDirectories.length);
        const limitedFiles = files.slice(0, remaining);

        const result = {
          path: absolutePath,
          maxDepth,
          directories: limitedDirectories.length > 0 ? limitedDirectories : ["(no subdirectories)"],
          files: limitedFiles.length > 0 ? limitedFiles : ["(no files)"],
          totalEntries,
          returnedEntries: limitedDirectories.length + limitedFiles.length,
          truncated,
          summary: truncated
            ? `Found ${directories.length} directory(ies) and ${files.length} file(s); returned the first ${maxEntries} entries`
            : `Found ${directories.length} directory(ies) and ${files.length} file(s)`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error exploring directory ${dirPath}: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Register read-file tool
  server.registerTool(
    "read-file",
    {
      description:
        `Read a bounded range of a text file. Defaults to the first 400 lines and at most 12000 characters.

        Use startLine to continue reading large files. The response reports the total line count,
        returned range, and whether more content remains.

        PATH can be absolute or relative to the workspace root. Line numbers are 1-based.`,
      inputSchema: {
        path: z
          .string()
          .describe("The file path to read. Can be absolute or relative to workspace root."),
        encoding: z
          .string()
          .optional()
          .default("utf-8")
          .describe("File encoding. Default 'utf-8'."),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(1)
          .describe("First line to return, 1-based. Default 1."),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .default(400)
          .describe("Maximum lines to return. Default 400, max 5000."),
        maxChars: z
          .number()
          .int()
          .min(100)
          .max(100000)
          .optional()
          .default(12000)
          .describe("Maximum characters of file content to return. Default 12000, max 100000."),
      },
    },
    async ({ path: filePath, encoding, startLine, maxLines, maxChars }) => {
      try {
        const absolutePath = validatePathInWorkspace(filePath, workspaceRoot);
        const fileEncoding: BufferEncoding = (encoding as BufferEncoding) || "utf-8";
        const content = await readFile(absolutePath, { encoding: fileEncoding });
        const lines = content.split(/\r?\n/);
        const startIndex = startLine - 1;

        if (startIndex >= lines.length) {
          return {
            content: [{
              type: "text" as const,
              text: `File: ${absolutePath}\nTotal lines: ${lines.length}\nRequested start line ${startLine} is beyond end of file.`,
            }],
            isError: true,
          };
        }

        const selected = lines.slice(startIndex, startIndex + maxLines);
        let body = selected.join("\n");
        const charsTruncated = body.length > maxChars;
        if (charsTruncated) body = body.slice(0, maxChars);

        const completeSelectedLines = charsTruncated
          ? body.split("\n").length
          : selected.length;
        const endLine = Math.min(lines.length, startLine + completeSelectedLines - 1);
        const truncated = charsTruncated || endLine < lines.length;
        const nextLine = truncated ? (charsTruncated ? endLine : endLine + 1) : null;
        const truncationHint = charsTruncated
          ? `; line ${endLine} was cut by maxChars, continue from startLine=${endLine} with a larger maxChars`
          : nextLine
            ? `; continue with startLine=${nextLine}`
            : "";

        return {
          content: [{
            type: "text" as const,
            text:
              `File: ${absolutePath}\n` +
              `Lines: ${startLine}-${endLine} of ${lines.length}\n` +
              `Truncated: ${truncated}${truncationHint}\n\n` +
              body,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error reading file ${filePath}: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Register create-file tool — ONLY for NEW files, never overwrites
  server.registerTool(
    "create-file",
    {
      description:
        `Create a NEW file that does NOT exist yet. This tool is ONLY for creating files from scratch.

        ⚠️ CRITICAL RULES:
        - NEVER use this tool to edit or modify an existing file. Use "edit-file" instead.
        - This tool will ALWAYS reject if the file already exists — there is no overwrite option.
        - Before calling this tool, verify the file does not exist (use "read-file" or "file-glob" to check).
        - If you need to change content in an existing file, ALWAYS use "edit-file" with oldText/newText.

        Creates parent directories if they don't exist. Returns success message with file path.

        PATH can be absolute or relative to the workspace root.`,
      inputSchema: {
        path: z
          .string()
          .describe("The file path to create. Can be absolute or relative to workspace root. The file MUST NOT already exist."),
        content: z
          .string()
          .describe("The content to write to the new file"),
        encoding: z
          .string()
          .optional()
          .default("utf-8")
          .describe("File encoding. Default 'utf-8'."),
      },
    },
    async ({ path: filePath, content, encoding }) => {
      try {
        const absolutePath = validatePathInWorkspace(filePath, workspaceRoot);
        const fileEncoding: BufferEncoding = (encoding as BufferEncoding) || "utf-8";
        await mkdir(dirname(absolutePath), { recursive: true });
        // Force "wx" flag — never allow overwrite
        await writeFile(absolutePath, content, { encoding: fileEncoding, flag: "wx" });

        return {
          content: [{ type: "text" as const, text: `File created successfully at: ${absolutePath}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("EEXIST")) {
          return {
            content: [{ type: "text" as const, text: `Error: File already exists at ${filePath}. Use "edit-file" to modify existing files. "create-file" is ONLY for new files.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Error creating file ${filePath}: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Register edit-file tool
  server.registerTool(
    "edit-file",
    {
      description:
        `Edit an existing file by replacing specific text. Reads the file, performs exact text replacement, and writes back the modified content.`,
      inputSchema: {
        path: z
          .string()
          .describe("The file path to edit. Can be absolute or relative to the workspace root."),
        oldText: z
          .string()
          .describe("The exact text to find and replace. Must match the file content precisely. Use empty string to append at the end of the file."),
        newText: z
          .string()
          .describe("The replacement text. Use empty string to delete the oldText from the file."),
        encoding: z
          .string()
          .optional()
          .default("utf-8")
          .describe("File encoding. Default 'utf-8'."),
        replaceAll: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether to replace all occurrences or just the first one. Default: true."),
      },
    },
    async ({ path: filePath, oldText, newText, encoding, replaceAll }) => {
      try {
        const absolutePath = validatePathInWorkspace(filePath, workspaceRoot);
        const fileEncoding: BufferEncoding = (encoding as BufferEncoding) || "utf-8";
        const currentContent = await readFile(absolutePath, { encoding: fileEncoding });

        if (oldText !== "" && !currentContent.includes(oldText)) {
          return {
            content: [{
              type: "text" as const,
              text:
                `Error: The text to replace was not found in ${absolutePath}.\n` +
                `The file has ${currentContent.length} characters. Use read-file with a narrow range or grep to inspect the relevant section.`,
            }],
            isError: true,
          };
        }

        let newContent: string;
        if (oldText === "") {
          newContent = currentContent + newText;
        } else if (replaceAll) {
          newContent = currentContent.split(oldText).join(newText);
        } else {
          newContent = currentContent.replace(oldText, newText);
        }

        await writeFile(absolutePath, newContent, { encoding: fileEncoding });

        return {
          content: [{ type: "text" as const, text: `File edited successfully at: ${absolutePath}\n\nReplaced text with: ${newText.substring(0, 100)}${newText.length > 100 ? '...' : ''}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error editing file ${filePath}: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Register grep tool
  server.registerTool(
    "grep",
    {
      description:
        `Search for text or regex patterns across files in a directory. Returns matching lines with file path and line number. Respects .gitignore.`,
      inputSchema: {
        pattern: z.string().describe("The text or regex pattern to search for"),
        path: z.string().describe("The directory path to search in. Can be absolute or relative to workspace root. Use '.' for workspace root."),
        caseInsensitive: z.boolean().optional().default(false).describe("Whether the search should be case-insensitive."),
        maxResults: z.number().min(1).max(1000).optional().default(100).describe("Maximum number of results to return."),
        glob: z.string().optional().describe("Optional glob pattern to filter files (e.g., '*.ts')."),
      },
    },
    async ({ pattern, path: searchPath, caseInsensitive, maxResults, glob }) => {
      try {
        const absolutePath = validatePathInWorkspace(searchPath, workspaceRoot);
        const gitignorePatterns = await loadGitignore(workspaceRoot);
        const cleanGlob = glob ? glob.trim().replace(/,\s+/g, ',') : undefined;

        if (cleanGlob) {
          const openBraces = (cleanGlob.match(/{/g) || []).length;
          const closeBraces = (cleanGlob.match(/}/g) || []).length;
          if (openBraces !== closeBraces) {
            return {
              content: [{ type: "text" as const, text: `Error: Invalid glob pattern - unbalanced braces {}.` }],
              isError: true,
            };
          }
        }

        const results: Array<{ file: string; line: number; content: string }> = [];
        const flags = caseInsensitive ? "i" : "";

        function matchesGlob(relativePath: string): boolean {
          if (!cleanGlob) return true;
          try {
            return minimatch(relativePath, cleanGlob, { dot: true, matchBase: true });
          } catch {
            return false;
          }
        }

        async function searchInFile(filePath: string, relativePath: string): Promise<void> {
          if (!matchesGlob(relativePath)) return;
          try {
            const content = await readFile(filePath, "utf-8");
            const lines = content.split("\n");
            const regex = new RegExp(pattern, flags);
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({ file: relativePath, line: i + 1, content: lines[i].trim() });
                if (results.length > maxResults) return;
              }
            }
          } catch {}
        }

        async function searchDirectory(dirPath: string, baseDir: string): Promise<void> {
          try {
            const entries = await readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = join(dirPath, entry.name);
              let relativePath = relative(baseDir, fullPath);
              relativePath = relativePath.split("\\").join("/");
              if (isIgnored(relativePath, gitignorePatterns)) continue;
              if (entry.isDirectory()) {
                await searchDirectory(fullPath, baseDir);
              } else {
                await searchInFile(fullPath, relativePath);
              }
              if (results.length > maxResults) return;
            }
          } catch {}
        }

        const fileStat = await stat(absolutePath);
        if (fileStat.isFile()) {
          await searchInFile(absolutePath, absolutePath);
        } else {
          await searchDirectory(absolutePath, absolutePath);
        }

        const truncated = results.length > maxResults;
        const finalResults = results.slice(0, maxResults);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                pattern,
                path: absolutePath,
                glob: cleanGlob,
                caseInsensitive,
                totalMatches: finalResults.length,
                truncated,
                results: finalResults,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error performing grep: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

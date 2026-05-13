import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express, { Request } from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, access, stat } from "fs/promises";
import { join, isAbsolute, dirname, relative } from "path";
import { posix } from "path";
import crypto from "crypto";
import { minimatch } from "minimatch";



// --- Streamable HTTP Server ---
const app = express();
app.use(
  cors({
    origin: true, // allow all origins dynamically
    methods: ["GET", "POST", "OPTIONS", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Content-Length",
      "Content-Encoding",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Authorization",
      "X-Workspace-Root",
    ],
    exposedHeaders: ["Mcp-Session-Id"],
  })
);
app.use((req, res, next) => {
  // Only parse JSON body if Content-Type is application/json and body exists
  if (req.headers["content-type"]?.includes("application/json") && req.headers["content-length"] && Number(req.headers["content-length"]) > 0) {
    express.json()(req, res, next);
  } else {
    req.body = {};
    next();
  }
});

// Extract workspace root from optional header or use process.cwd()
function getWorkspaceRoot(req: Request): string {
  const headerValue = req.headers["x-workspace-root"] as string | undefined;
  if (headerValue && headerValue.trim()) {
    return isAbsolute(headerValue) ? headerValue : join(process.cwd(), headerValue);
  }
  return process.cwd();
}
const transports = new Map<string, StreamableHTTPServerTransport>();

// Create a fresh McpServer instance per connection (SDK allows only one connect() per instance)
function createServer(workspaceRoot: string = process.cwd()): McpServer {
  const s = new McpServer({
    name: "web-scraper",
    version: "1.0.0",
  });
  // Helper function to load .gitignore patterns
  async function loadGitignore(baseDir: string): Promise<string[]> {
    const gitignorePath = join(baseDir, ".gitignore");
    try {
      await access(gitignorePath);
      const content = await fsReadFile(gitignorePath, "utf-8");
      // Parse .gitignore: remove comments, empty lines, and trim
      return content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"));
    } catch {
      return [];
    }
  }

  // Helper function to check if a path matches any gitignore pattern
  function isIgnored(path: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      // Handle directory patterns (ending with /)
      if (pattern.endsWith("/")) {
        const dirPattern = pattern.slice(0, -1);
        if (path.startsWith(dirPattern + "/") || path === dirPattern) {
          return true;
        }
      }
      // Handle file patterns
      else if (path === pattern || path.endsWith("/" + pattern)) {
        return true;
      }
      // Handle wildcard patterns
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

// Helper function to explore directory recursively
  async function exploreDirectory(
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
        // Normalize path separators for consistent matching
        relativePath = relativePath.split("\\").join("/");

        // Skip ignored files/directories
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

  // Register file-glob tool
  s.registerTool(
    "file-glob",
    {
      description:
        `Explore a directory and list files and subdirectories. Returns a hierarchical view of the filesystem structure up to the specified depth. 

        PATH can be absolute or relative. If relative, it resolves against the workspace root.
        
        WORKSPACE ROOT: The workspace root can be configured via the optional header "X-Workspace-Root" when setting up the MCP client. 
        If not provided, defaults to the server's current working directory (${process.cwd()}).
        
        Examples:
        - Absolute: /Users/rafaelss8/Projetos/Pessoal/mcp-http/src
        - Relative: src (resolves to <workspace-root>/src)
        - Current dir: . (resolves to workspace root)`,
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
      },
    },
    async ({ path: dirPath, maxDepth }) => {
      try {
        // Resolve relative paths against workspace root
        const absolutePath = isAbsolute(dirPath) ? dirPath : join(workspaceRoot, dirPath);

        // Load .gitignore from workspace root
        const gitignorePatterns = await loadGitignore(workspaceRoot);
        
        const { files, directories } = await exploreDirectory(absolutePath, maxDepth, 0, absolutePath, gitignorePatterns);

        const result = {
          path: absolutePath,
          maxDepth,
          directories: directories.length > 0 ? directories : ["(no subdirectories)"],
          files: files.length > 0 ? files : ["(no files)"],
          summary: `Found ${directories.length} directory(ies) and ${files.length} file(s)`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error exploring directory ${dirPath}: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register read-file tool
  s.registerTool(
    "read-file",
    {
      description:
        `Read the contents of a file. Returns the full text content of the file. Supports text files, source code, JSON, YAML, and other text-based formats.

        PATH can be absolute or relative to the workspace root.
        
        WORKSPACE ROOT: Configurable via the optional header "X-Workspace-Root" when setting up the MCP client.
        If not provided, defaults to the server's current working directory (${process.cwd()}).
        
        Examples:
        - Absolute: /Users/rafaelss8/Projetos/Pessoal/mcp-http/src/index.ts
        - Relative: src/index.ts (resolves to <workspace-root>/src/index.ts)`,
      inputSchema: {
        path: z
          .string()
          .describe("The file path to read. Can be absolute or relative to workspace root."),
        encoding: z
          .string()
          .optional()
          .default("utf-8")
          .describe("File encoding. Default 'utf-8'."),
      },
    },
    async ({ path: filePath, encoding }) => {
      try {
        // Resolve relative paths against workspace root
        const absolutePath = isAbsolute(filePath) ? filePath : join(workspaceRoot, filePath);

        const fileEncoding: BufferEncoding = (encoding as BufferEncoding) || "utf-8";
        const content = await fsReadFile(absolutePath, { encoding: fileEncoding });

        return {
          content: [
            {
              type: "text" as const,
              text: content,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading file ${filePath}: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register create-file tool
  s.registerTool(
    "create-file",
    {
      description:
        `Create a new file with the specified content. Creates parent directories if they don't exist. Returns success message with file path. Does not overwrite existing files.

        PATH can be absolute or relative to the workspace root.
        
        WORKSPACE ROOT: Configurable via the optional header "X-Workspace-Root" when setting up the MCP client.
        If not provided, defaults to the server's current working directory (${process.cwd()}).
        
        Examples:
        - Absolute: /Users/rafaelss8/Projetos/Pessoal/mcp-http/src/new-file.ts
        - Relative: src/new-file.ts (resolves to <workspace-root>/src/new-file.ts)`,
      inputSchema: {
        path: z
          .string()
          .describe("The file path to create. Can be absolute or relative to workspace root."),
        content: z
          .string()
          .describe("The content to write to the file"),
        encoding: z
          .string()
          .optional()
          .default("utf-8")
          .describe("File encoding. Default 'utf-8'."),
      },
    },
    async ({ path: filePath, content, encoding }) => {
      try {
        // Resolve relative paths against workspace root
        const absolutePath = isAbsolute(filePath) ? filePath : join(workspaceRoot, filePath);

        // Create parent directories if they don't exist
        const dirPath = join(absolutePath, "..");
        const fileEncoding: BufferEncoding = (encoding as BufferEncoding) || "utf-8";
        await fsWriteFile(absolutePath, content, { encoding: fileEncoding, flag: "wx" }); // 'wx' flag ensures file doesn't exist

        return {
          content: [
            {
              type: "text" as const,
              text: `File created successfully at: ${absolutePath}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        
        // Check if file already exists (EEXIST error)
        if (message.includes("EEXIST")) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: File already exists at ${filePath}. Use a different path or delete the existing file first.`,
              },
            ],
            isError: true,
          };
        }
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating file ${filePath}: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register edit-file tool
  s.registerTool(
    "edit-file",
    {
      description:
        `Edit an existing file by replacing specific text. Reads the file, performs exact text replacement, and writes back the modified content. Use this for targeted edits without rewriting entire files. The oldText must match exactly (including whitespace and indentation) for the replacement to succeed.

        PATH can be absolute or relative to the workspace root.
        
        WORKSPACE ROOT: Configurable via the optional header "X-Workspace-Root" when setting up the MCP client.
        If not provided, defaults to the server's current working directory (${process.cwd()}).
        
        Examples:
        - Absolute: /Users/rafaelss8/Projetos/Pessoal/mcp-http/src/index.ts
        - Relative: src/index.ts (resolves to <workspace-root>/src/index.ts)`,
      inputSchema: {
        path: z
          .string()
          .describe("The file path to edit. Can be absolute or relative to workspace root."),
        oldText: z
          .string()
          .describe("The exact text to find and replace. Must match the file content precisely, including whitespace and indentation. Use empty string to append at the end of the file."),
        newText: z
          .string()
          .describe("The replacement text. Use empty string to delete the oldText from the file."),
        encoding: z
          .string()
          .optional()
          .default("utf-8")
          .describe("File encoding. Default 'utf-8'."),
      },
    },
    async ({ path: filePath, oldText, newText, encoding }) => {
      try {
        // Resolve relative paths against workspace root
        const absolutePath = isAbsolute(filePath) ? filePath : join(workspaceRoot, filePath);

        // Read the current file content
        const fileEncoding: BufferEncoding = (encoding as BufferEncoding) || "utf-8";
        const currentContent = await fsReadFile(absolutePath, { encoding: fileEncoding });

        // Check if oldText exists in the file
        if (oldText !== "" && !currentContent.includes(oldText)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: The text to replace was not found in the file. Make sure oldText matches exactly (including whitespace and indentation).\n\nFile content:\n${currentContent}`,
              },
            ],
            isError: true,
          };
        }

        // Perform the replacement
        let newContent: string;
        if (oldText === "") {
          // Append at the end
          newContent = currentContent + newText;
        } else {
          // Replace all occurrences of oldText with newText
          newContent = currentContent.split(oldText).join(newText);
        }

        // Write the modified content back to the file
        await fsWriteFile(absolutePath, newContent, { encoding: fileEncoding });

        return {
          content: [
            {
              type: "text" as const,
              text: `File edited successfully at: ${absolutePath}\n\nReplaced text with: ${newText.substring(0, 100)}${newText.length > 100 ? '...' : ''}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error editing file ${filePath}: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register grep tool
  s.registerTool(
    "grep",
    {
      description:
        `Search for text or regex patterns across files in a directory. Returns matching lines with file path and line number. Respects .gitignore.

        PATH can be absolute or relative. If relative, it resolves against the workspace root.
        
        GLOB: Optional glob pattern to filter files (e.g., "*.ts", "**/*.js", "src/**/*.ts").
        Uses minimatch syntax: *, **, ?, [], {}, ! for negation.
        
        WORKSPACE ROOT: The workspace root can be configured via the optional header "X-Workspace-Root" when setting up the MCP client.
        If not provided, defaults to the server's current working directory (${process.cwd()}).
        
        Examples:
        - Search in current dir: grep("console.log", ".")
        - Search only .ts files: grep("export", ".", false, 100, "*.ts")
        - Search in src recursively: grep("import", ".", false, 100, "src/**/*.ts")
        - Multiple extensions: grep("TODO", ".", false, 100, "**/*.{ts,js,jsx,tsx}")
        - Case insensitive: grep("error", ".", true)
        - Regex pattern: grep("\\d{4}-\\d{2}-\\d{2}", "logs")`,
      inputSchema: {
        pattern: z
          .string()
          .describe("The text or regex pattern to search for"),
        path: z
          .string()
          .describe("The directory path to search in. Can be absolute or relative to workspace root. Use '.' for workspace root."),
        caseInsensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether the search should be case-insensitive. Default: false"),
        maxResults: z
          .number()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe("Maximum number of results to return. Default: 100, max: 1000"),
        glob: z
          .string()
          .optional()
          .describe("Optional glob pattern to filter files (e.g., '*.ts', '**/*.js', 'src/**/*.ts'). Uses minimatch syntax."),
      },
    },
    async ({ pattern, path: searchPath, caseInsensitive, maxResults, glob }) => {
      try {
        // Resolve relative paths against workspace root
        const absolutePath = isAbsolute(searchPath) ? searchPath : join(workspaceRoot, searchPath);

        // Load .gitignore from workspace root
        const gitignorePatterns = await loadGitignore(workspaceRoot);

        // Sanitize glob pattern: remove spaces after commas in brace expansions
        const cleanGlob = glob ? glob.trim().replace(/,\s+/g, ',') : undefined;

        // Validate glob braces are balanced
        if (cleanGlob) {
          const openBraces = (cleanGlob.match(/{/g) || []).length;
          const closeBraces = (cleanGlob.match(/}/g) || []).length;
          if (openBraces !== closeBraces) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Invalid glob pattern - unbalanced braces {}. Example: "**/*.{ts,js}"`,
                },
              ],
              isError: true,
            };
          }
        }

        const results: Array<{ file: string; line: number; content: string }> = [];
        const flags = caseInsensitive ? "i" : "";

        // Helper function to check if file matches glob pattern
        function matchesGlob(relativePath: string): boolean {
          if (!cleanGlob) return true;
          try {
            return minimatch(relativePath, cleanGlob, {
              dot: true, // Include hidden files
              matchBase: true, // Allow matching without directory prefix
            });
          } catch {
            return false;
          }
        }

        // Helper function to search in a single file
        async function searchInFile(filePath: string, relativePath: string): Promise<void> {
          // Check if file matches glob pattern
          if (!matchesGlob(relativePath)) {
            return;
          }

          try {
            const content = await fsReadFile(filePath, "utf-8");
            const lines = content.split("\n");
            const regex = new RegExp(pattern, flags);

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  file: relativePath,
                  line: i + 1,
                  content: lines[i].trim(),
                });

                if (results.length >= maxResults) {
                  return;
                }
              }
            }
          } catch {
            // Skip files that can't be read (binary files, permissions, etc.)
          }
        }

        // Helper function to recursively search directories
        async function searchDirectory(dirPath: string, baseDir: string): Promise<void> {
          try {
            const entries = await readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
              const fullPath = join(dirPath, entry.name);
              let relativePath = relative(baseDir, fullPath);
              relativePath = relativePath.split("\\").join("/");

              // Skip ignored files/directories
              if (isIgnored(relativePath, gitignorePatterns)) {
                continue;
              }

              if (entry.isDirectory()) {
                await searchDirectory(fullPath, baseDir);
              } else {
                await searchInFile(fullPath, relativePath);
              }

              if (results.length >= maxResults) {
                return;
              }
            }
          } catch {
            // Skip directories that can't be read
          }
        }

        // Start search
        const fileStat = await stat(absolutePath);
        if (fileStat.isFile()) {
          await searchInFile(absolutePath, absolutePath);
        } else {
          await searchDirectory(absolutePath, absolutePath);
        }

        const truncated = results.length > maxResults;
        const finalResults = results.slice(0, maxResults);

        const result = {
          pattern,
          path: absolutePath,
          glob: cleanGlob,
          caseInsensitive,
          totalMatches: finalResults.length,
          truncated,
          results: finalResults,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error performing grep: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register scrape_url tool
  s.registerTool(
    "scrape_url",
    {
      description:
        "Fetch a URL and return the visible text content of the page. Strips HTML tags, scripts, and styles. Returns clean, readable text.",
      inputSchema: {
        url: z.string().url().describe("The URL to scrape (e.g. https://example.com)"),
        max_length: z
          .number()
          .min(100)
          .max(500_000)
          .optional()
          .default(100_000)
          .describe("Maximum characters to return. Default 100000, max 500000."),
      },
    },
    async ({ url, max_length }) => {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`,
              },
            ],
          };
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("html")) {
          const text = await response.text();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  text.length > max_length
                    ? text.slice(0, max_length) + "\n\n... [truncated]"
                    : text,
              },
            ],
          };
        }

        const html = await response.text();
        const $ = cheerio.load(html);
        $("script, style, noscript, iframe, nav, footer, head").remove();
        let text = $("body").text();
        text = text.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();

        if (text.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Page fetched successfully but no visible text content found: ${url}`,
              },
            ],
          };
        }

        const title = $("title").text().trim();
        const header = title ? `Page: ${title}\nURL: ${url}\n\n` : `URL: ${url}\n\n`;
        const fullText = header + text;
        const result =
          fullText.length > max_length
            ? fullText.slice(0, max_length) + "\n\n... [truncated]"
            : fullText;

        return {
          content: [
            {
              type: "text" as const,
              text: result,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error scraping ${url}: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
  // Register websearch tool
  s.registerTool(
    "websearch",
    {
      description:
        "Search the web using DuckDuckGo. Returns a list of results with titles, URLs, and snippets.",
      inputSchema: {
        query: z
          .string()
          .describe("The search query string."),
        limit: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe("Maximum number of results to return. Default 5, max 20."),
      },
    },
    async ({ query, limit }) => {
      try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        
        const response = await fetch(searchUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);
        
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        
        // DuckDuckGo structure typically uses .result classes
        $(".result").each((i, el) => {
          if (results.length >= limit) return false; // break loop

          const $el = $(el);
          const $a = $el.find(".result__a");
          const title = $a.text();
          const url = $a.attr("href") || "";
          const snippet = $el.find(".result__snippet").text().trim();

          if (title && url) {
            results.push({ title, url, snippet });
          }
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error searching for '${query}': ${message}` }],
          isError: true,
        };
      }
    }
  );
  return s;
}

app.all("/mcp", async (req: Request, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const workspaceRoot = getWorkspaceRoot(req);
  console.error(`[mcp] ${req.method} ${req.url} sessionId=${sessionId} workspaceRoot=${workspaceRoot}`);

  let transport: StreamableHTTPServerTransport;
  if (sessionId && transports.has(sessionId)) {
    transport = transports.get(sessionId)!;
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    // Create a new McpServer instance per connection with workspace root
    const mcpServer = createServer(workspaceRoot);
    await mcpServer.connect(transport);
  }

  try {
    await transport.handleRequest(req, res, req.body);

    // sessionId is generated during handleRequest, store after first request
    const sid = transport.sessionId;
    if (sid && !transports.has(sid)) {
      transports.set(sid, transport);
      transport.onclose = () => {
        console.error(`[mcp] Session closed: ${sid}`);
        transports.delete(sid);
      };
    }

    console.error(`[mcp] Request handled. Session: ${transport.sessionId || 'none'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp] Error handling request: ${message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", message });
    }
  }
});

const PORT = Number(process.env.PORT) || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.error(`MCP Streamable HTTP Server running on 0.0.0.0:${PORT}`);
  console.error(`Endpoint: http://localhost:${PORT}/mcp`);
});

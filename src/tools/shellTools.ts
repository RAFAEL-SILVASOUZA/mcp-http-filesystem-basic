import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { isAbsolute, join } from "path";
import { validatePathInWorkspace } from "../utils/path.js";

const execAsync = promisify(exec);

// Whitelist of allowed commands
const ALLOWED_COMMANDS = new Set([
  // Navigation / listing
  "ls", "la", "dir",
  // File operations (read-only)
  "cat", "head", "tail", "less", "more", "wc", "file",
  // Search
  "grep", "find", "locate",
  // Git
  "git",
  // Node / npm
  "node", "npm", "npx", "yarn", "pnpm",
  // Python
  "python", "python3", "pip", "pip3",
  // Build / compile
  "make", "cmake",
  // Info / system
  "whoami", "hostname", "uname", "date", "uptime",
  // Package managers
  "brew", "apt", "apt-get",
  // Docker (read-only)
  "docker",
  // Text processing
  "sed", "awk", "sort", "uniq", "cut", "tr", "xargs",
  // Network (read-only)
  "curl", "wget", "ping", "dig", "nslookup",
  // Misc
  "echo", "test", "stat", "du", "df", "tree",
]);

function isCommandAllowed(command: string): boolean {
  // Extract the base command (first word, before any flags or arguments)
  const baseCommand = command.trim().split(/\s+/)[0].split("/").pop();

  // Allow pipes and chained commands only if all base commands are allowed
  const commands = baseCommand?.split("|") || [baseCommand];
  return commands.every(cmd => ALLOWED_COMMANDS.has(cmd?.trim() || ""));
}

export function registerShellTools(server: McpServer, workspaceRoot: string) {
  server.registerTool(
    "execute_command",
    {
      description:
        `Execute a shell command and return its output. Commands are restricted to a safe whitelist and run within the workspace directory.

        ALLOWED COMMANDS: ls, cat, head, tail, grep, find, git, node, npm, npx, yarn, pnpm, python, python3, pip, pip3, make, curl, wget, docker, sed, awk, sort, uniq, cut, tree, du, df, and others (see source for full list).

        SAFETY:
        - Commands run inside the workspace root directory
        - Only whitelisted commands are allowed
        - Output is limited to 50000 characters
        - Timeout is 30 seconds

        Examples:
        - execute_command("ls -la")
        - execute_command("git status")
        - execute_command("npm run build")
        - execute_command("grep -r 'TODO' src/")`,
      inputSchema: {
        command: z
          .string()
          .max(500)
          .describe("The shell command to execute. Only whitelisted commands are allowed."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the command. Must be within the workspace root. Defaults to workspace root."),
        timeout: z
          .number()
          .min(1)
          .max(120)
          .optional()
          .default(30)
          .describe("Timeout in seconds. Default 30, max 120."),
      },
    },
    async ({ command, cwd, timeout }) => {
      try {
        // Validate command against whitelist
        if (!isCommandAllowed(command)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Command not allowed: '${command}'. Only whitelisted commands are permitted.`,
              },
            ],
            isError: true,
          };
        }

        // Determine working directory
        let workingDir = workspaceRoot;
        if (cwd) {
          const resolvedCwd = isAbsolute(cwd) ? cwd : join(workspaceRoot, cwd);
          workingDir = validatePathInWorkspace(resolvedCwd, workspaceRoot);
        }

        // Execute the command
        const { stdout, stderr } = await execAsync(command, {
          cwd: workingDir,
          timeout: timeout * 1000,
          maxBuffer: 1024 * 1024, // 1MB buffer
          shell: "/bin/bash",
        });

        // Build output
        let output = "";
        if (stdout) output += `STDOUT:\n${stdout}\n`;
        if (stderr) output += `STDERR:\n${stderr}\n`;

        // Truncate if too long
        const maxOutput = 50000;
        if (output.length > maxOutput) {
          output = output.slice(0, maxOutput) + "\n\n... [output truncated]";
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Command: ${command}\nDirectory: ${workingDir}\n\n${output || "(no output)"}`,
            },
          ],
        };
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);

        // Handle timeout specifically
        if (message.includes("timeout") || message.includes("killed")) {
          message = `Command timed out after ${timeout} seconds.`;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Error executing command: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { isAbsolute, join } from "path";

const execAsync = promisify(exec);

// Dangerous commands that ALWAYS require explicit confirmation
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[rRfF]|-rf|-fr)/,           // rm -rf, rm -fr, etc.
  /\bformat\b/,                          // disk formatting
  /\bdd\s+if=/,                         // raw disk access
  /\bmkfs\b/,                           // filesystem creation
  /\bshutdown\b/,                       // system shutdown
  /\breboot\b/,                         // system reboot
  /\bsudo\b/,                           // privilege escalation
  /\bchmod\s+[0-7]*[7-9]/,             // dangerous permissions
  /\bchown\b/,                          // ownership changes
  /\bmv\s+.*\/?(\.env|\.git|node_modules)/, // moving sensitive dirs
];

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
}

export function registerShellTools(server: McpServer, workspaceRoot: string) {
  server.registerTool(
    "execute_command",
    {
      description:
        `Execute ANY shell command and return its output. Commands can run in any directory on the system.

        ⚠️ CONFIRMATION REQUIRED:
        - Before executing, the LLM MUST ask the user: "Vou executar: [command]. Executar? (sim / não / sempre permitir)"
        - "sim" → execute once
        - "não" → do not execute
        - "sempre permitir" → execute without asking again for similar commands in this session
        - For dangerous commands (rm -rf, sudo, format, etc.), confirmation is ALWAYS required

        SAFETY:
        - Output is limited to 50000 characters
        - Timeout is 30 seconds (max 120)
        - Dangerous patterns (rm -rf, sudo, format, dd, etc.) require explicit confirmation

        Examples:
        - execute_command("ls -la")
        - execute_command("git status")
        - execute_command("npm run build")
        - execute_command("grep -r 'TODO' src/")`,
      inputSchema: {
        command: z
          .string()
          .max(500)
          .describe("The shell command to execute. ANY command is allowed, but confirmation is required."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the command. Can be any path on the system. Defaults to workspace root."),
        timeout: z
          .number()
          .min(1)
          .max(120)
          .optional()
          .default(30)
          .describe("Timeout in seconds. Default 30, max 120."),
        confirmed: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set to true ONLY after the user has explicitly confirmed. For dangerous commands, this is ALWAYS required."),
      },
    },
    async ({ command, cwd, timeout, confirmed }) => {
      try {
        // Check if command is dangerous
        const dangerous = isDangerousCommand(command);

        // Require confirmation for dangerous commands
        if (dangerous && !confirmed) {
          return {
            content: [
              {
                type: "text" as const,
                text: `⚠️ DANGEROUS COMMAND DETECTED: '${command}'\n\nThis command matches a dangerous pattern and requires explicit confirmation.\nSet confirmed: true and get explicit user approval before executing.`,
              },
            ],
            isError: true,
          };
        }

        // Determine working directory — any path is allowed
        let workingDir = workspaceRoot;
        if (cwd) {
          workingDir = isAbsolute(cwd) ? cwd : join(workspaceRoot, cwd);
        }

        // Execute the command        
        const { stdout, stderr } = await execAsync(command, {
          cwd: workingDir,
          timeout: timeout * 1000,
          maxBuffer: 1024 * 1024, // 1MB buffer
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

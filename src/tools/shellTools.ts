import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { isAbsolute, join } from "path";
import {
  startBackgroundProcess,
  listBackgroundProcesses,
  readBackgroundOutput,
  stopBackgroundProcess,
  getRegisteredIds,
  type ProcessSnapshot,
} from "./backgroundProcesses.js";

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

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function describeStatus(snapshot: ProcessSnapshot): string {
  switch (snapshot.status) {
    case "running":
      return `running (há ${formatUptime(snapshot.uptimeSeconds)})`;
    case "killed":
      return `killed (durou ${formatUptime(snapshot.uptimeSeconds)})`;
    default:
      return `exited com código ${snapshot.exitCode ?? "desconhecido"} (durou ${formatUptime(snapshot.uptimeSeconds)})`;
  }
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function unknownIdResult(id: string) {
  const ids = getRegisteredIds();
  const known = ids.length > 0 ? ids.join(", ") : "(nenhum processo registrado)";
  return textResult(
    `Processo '${id}' não encontrado.\n\nIDs conhecidos: ${known}\n\nUse list-background-processes para ver os processos ativos.`,
    true
  );
}

export function registerShellTools(server: McpServer, workspaceRoot: string) {
  server.registerTool(
    "execute_command",
    {
      description:
        `Execute ANY shell command and return its output. Commands can run in any directory on the system.

        TWO MODES:
        - background: false (default) — waits for the command to finish and returns its output.
          Use for commands that terminate on their own: builds, tests, git, ls, grep.
        - background: true — starts the command and returns immediately with an ID and a PID.
          Use for long-running processes that NEVER terminate on their own: dev servers
          (npm run dev, node server.js), watchers, anything that would otherwise hang until
          the timeout. Then use read-background-output to follow the logs and
          stop-background-process to shut it down when you are done testing.

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
        - execute_command("grep -r 'TODO' src/")
        - execute_command("npm run dev", background: true)   → returns bg-1 / PID 12345`,
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
          .describe("Timeout in seconds. Default 30, max 120. IGNORED when background is true."),
        background: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Run the command in the background and return immediately with an ID (e.g. 'bg-1') and the OS PID, instead of waiting for it to finish. " +
            "Set to true for long-running processes that never exit on their own — dev servers (npm run dev, node server.js), watchers, API servers you want to test against. " +
            "Without this, such a command blocks the call until the timeout kills it, taking your server down with it. " +
            "The return includes whatever the process printed in its first ~2 seconds, so you can see immediately whether it started (e.g. 'Server listening on :3000') or crashed (e.g. 'EADDRINUSE'). " +
            "Afterwards use read-background-output to read more logs and stop-background-process to terminate it. Always stop what you start."
          ),
        confirmed: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set to true ONLY after the user has explicitly confirmed. For dangerous commands, this is ALWAYS required."),
      },
    },
    async ({ command, cwd, timeout, background, confirmed }) => {
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

        // Background mode: start and return the handle, do not wait for the end
        if (background) {
          const { snapshot, warmupOutput } = await startBackgroundProcess(command, workingDir);
          const crashed = snapshot.status !== "running";

          const header = crashed
            ? `⚠️ O processo terminou durante os 2s de warm-up — provavelmente falhou ao iniciar.`
            : `Processo iniciado em background`;

          const output =
            warmupOutput.length > 0
              ? warmupOutput.join("\n")
              : "(nenhuma saída nos primeiros 2 segundos)";

          const footer = crashed
            ? `Use read-background-output({ id: "${snapshot.id}" }) para ver o log completo.`
            : `Use read-background-output({ id: "${snapshot.id}" }) para ler mais.\n` +
              `Use stop-background-process({ id: "${snapshot.id}" }) para encerrar.`;

          return textResult(
            `${header}\n` +
            `ID: ${snapshot.id}\n` +
            `PID: ${snapshot.pid}\n` +
            `Comando: ${snapshot.command}\n` +
            `Diretório: ${snapshot.cwd}\n` +
            `Status: ${describeStatus(snapshot)}\n\n` +
            `--- Saída (primeiros 2s) ---\n${output}\n\n` +
            footer
          );
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

        // Handle timeout specifically (background commands have no timeout)
        if (!background && (message.includes("timeout") || message.includes("killed"))) {
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

  server.registerTool(
    "list-background-processes",
    {
      description:
        `List every process started with execute_command(background: true) in this MCP server.

        Shows the ID, the OS PID, the status (running / exited / killed), the command, the
        working directory and how long it has been alive. Processes that already finished stay
        listed for a while so you can still inspect their final output and exit code.

        Use this when you lost track of which IDs are active, or to make sure you are not
        leaving dev servers running.`,
      inputSchema: {},
    },
    async () => {
      const processes = listBackgroundProcesses();

      if (processes.length === 0) {
        return textResult(
          "Nenhum processo em background registrado.\n\n" +
          'Inicie um com execute_command({ command: "npm run dev", background: true }).'
        );
      }

      const lines = processes.map((p) =>
        `${p.id}  PID ${p.pid}  [${describeStatus(p)}]\n` +
        `  Comando: ${p.command}\n` +
        `  Diretório: ${p.cwd}\n` +
        `  Linhas de log: ${p.outputLines}${p.truncated ? " (truncado)" : ""}`
      );

      const running = processes.filter((p) => p.status === "running").length;

      return textResult(
        `${processes.length} processo(s) registrado(s), ${running} em execução:\n\n${lines.join("\n\n")}`
      );
    }
  );

  server.registerTool(
    "read-background-output",
    {
      description:
        `Read the captured stdout/stderr of a background process started with
        execute_command(background: true).

        Output is buffered in memory as it is produced — the last 1000 lines are kept. Call this
        after hitting your API to see the request logs, or after a process crashed to see why.

        Works on processes that already exited: the final log and exit code remain available.`,
      inputSchema: {
        id: z
          .string()
          .describe("The process ID returned by execute_command, e.g. 'bg-1'."),
        lines: z
          .number()
          .min(1)
          .max(1000)
          .optional()
          .default(100)
          .describe("How many of the most recent lines to return. Default 100, max 1000."),
      },
    },
    async ({ id, lines }) => {
      const result = readBackgroundOutput(id, lines);
      if (!result) return unknownIdResult(id);

      const { snapshot, omitted } = result;
      const body = result.lines.length > 0 ? result.lines.join("\n") : "(nenhuma saída capturada)";

      const notes: string[] = [];
      if (omitted > 0) notes.push(`${omitted} linha(s) anterior(es) omitida(s) — aumente 'lines' para ver mais.`);
      if (snapshot.truncated) notes.push("O buffer atingiu o limite de 1000 linhas; as mais antigas foram descartadas.");

      return textResult(
        `${snapshot.id} (PID ${snapshot.pid}) — ${describeStatus(snapshot)}\n` +
        `Comando: ${snapshot.command}\n\n` +
        `--- Saída ---\n${body}` +
        (notes.length > 0 ? `\n\n${notes.join("\n")}` : "")
      );
    }
  );

  server.registerTool(
    "stop-background-process",
    {
      description:
        `Terminate a process started with execute_command(background: true), using its ID.

        Kills the whole process tree, not just the shell wrapper — this is what actually frees
        the TCP port a dev server was holding. Returns the last 20 lines of output before death.

        Call this as soon as you are done testing against a server you started. Leaving processes
        running holds ports and consumes resources.`,
      inputSchema: {
        id: z
          .string()
          .describe("The process ID returned by execute_command, e.g. 'bg-1'."),
      },
    },
    async ({ id }) => {
      const result = await stopBackgroundProcess(id);
      if (!result) return unknownIdResult(id);

      const { snapshot, alreadyExited, forced, tail } = result;
      const body = tail.length > 0 ? tail.join("\n") : "(nenhuma saída capturada)";

      const header = alreadyExited
        ? `O processo ${snapshot.id} (PID ${snapshot.pid}) já havia terminado — nada a encerrar.`
        : `Processo ${snapshot.id} (PID ${snapshot.pid}) encerrado${forced ? " à força (não respondeu ao pedido educado)" : ""}.`;

      return textResult(
        `${header}\n` +
        `Comando: ${snapshot.command}\n` +
        `Status: ${describeStatus(snapshot)}\n\n` +
        `--- Últimas linhas ---\n${body}`
      );
    }
  );
}

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

const DEFAULT_MAX_OUTPUT_CHARS = 8000;
const MAX_OUTPUT_CHARS = 50000;

function compactOutput(text: string, maxChars: number): { text: string; omittedChars: number } {
  if (text.length <= maxChars) return { text, omittedChars: 0 };

  const markerReserve = 120;
  const available = Math.max(0, maxChars - markerReserve);
  const headLength = Math.floor(available * 0.6);
  const tailLength = available - headLength;
  const omittedChars = text.length - headLength - tailLength;
  const marker =
    `\n\n... [${omittedChars} characters omitted; showing beginning and end. ` +
    `Rerun with a narrower command or increase maxOutputChars.] ...\n\n`;

  return {
    text: text.slice(0, headLength) + marker + text.slice(text.length - tailLength),
    omittedChars,
  };
}

function commandStreams(stdout: string, stderr: string): string {
  let output = "";
  if (stdout) output += `STDOUT:\n${stdout.trimEnd()}\n`;
  if (stderr) output += `STDERR:\n${stderr.trimEnd()}\n`;
  return output || "(no output)";
}

/**
 * Comandos que SEMPRE exigem confirmação explícita (`confirmed: true`).
 *
 * A lista cobre os dois shells que `exec` pode abrir: /bin/sh em POSIX e
 * cmd.exe no Windows. Só padrões Unix deixariam o gate aberto na metade das
 * máquinas — `rd /s /q` apagaria a árvore sem passar por aqui. Os padrões do
 * lado Windows são case-insensitive porque o cmd.exe também é.
 *
 * Isto é uma rede de segurança, não a política. A política está em
 * prompts/agent-instructions.md; aqui só barramos o que é irreversível.
 */
const DANGEROUS_PATTERNS = [
  // POSIX
  /\brm\s+(-[rRfF]|-rf|-fr)/,           // rm -rf, rm -fr, etc.
  /\bdd\s+if=/,                         // raw disk access
  /\bmkfs\b/,                           // filesystem creation
  /\bsudo\b/,                           // privilege escalation
  /\bchmod\s+[0-7]*[7-9]/,              // dangerous permissions
  /\bchown\b/,                          // ownership changes
  /\bmv\s+.*\/?(\.env|\.git|node_modules)/, // moving sensitive dirs

  // Windows — cmd.exe e PowerShell invocado via -Command
  /\brd\s+\/s/i,                        // rd /s /q
  /\brmdir\s+\/s/i,                     // rmdir /s /q
  /\bdel\s+(\/[a-z]\s+)*\/s/i,          // del /s (recursivo)
  /\bRemove-Item\b[^|]*-Recurse/i,      // Remove-Item -Recurse -Force
  /\bFormat-Volume\b/i,                 // formatação via PowerShell
  /\brunas\b/i,                         // elevação de privilégio
  /\bdiskpart\b/i,                      // particionamento

  // Multiplataforma
  /\bformat\b/i,                        // disk formatting
  /\bshutdown\b/i,                      // system shutdown
  /\breboot\b/i,                        // system reboot
  /\bgit\s+reset\s+--hard\b/i,          // descarta trabalho não commitado
  /\bgit\s+clean\s+-[a-z]*[fd]/i,       // apaga arquivos não rastreados
  /\bgit\s+push\b[^|]*(--force|\s-f(\s|$))/i, // reescreve história remota
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, // destruição de dados
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
        `Execute a shell command and return its output. Commands can run in any directory on the system.

        SHELL: this runs through the system shell — cmd.exe on Windows, /bin/sh on Linux and
        macOS. It is NOT PowerShell and NOT bash. On Windows, 'ls', 'cat', 'grep' and 'rm' do
        not exist (use dir, type, findstr, del), '&&' works but ';' does not, variables are
        %VAR%, and paths with spaces must be quoted. Call get-system-info if unsure of the OS.

        TWO MODES:
        - background: false (default) — waits for the command to finish and returns its output.
          Use for commands that terminate on their own: builds, tests, git, directory listings.
        - background: true — starts the command and returns immediately with an ID and a PID.
          Use for long-running processes that NEVER terminate on their own: dev servers
          (npm run dev, node server.js), watchers, anything that would otherwise hang until
          the timeout. Then use read-background-output to follow the logs and
          stop-background-process to shut it down when you are done testing.

        NEVER invoke a command that waits for input or opens an editor — nothing is attached
        to stdin, so it blocks until the timeout and background: true does not help. Use the
        non-interactive flag: npm init -y, npx --yes, git commit --no-edit, git --no-pager.

        CONFIRMATION — depends on what the command does, not on it being a command. This is a
        default INSIDE your host client's policy, not an override of it: if your client requires
        approval for something listed below as free, ask — the host wins.
        - Read-only and verification commands (builds, type-checks, tests, linters,
          git status/diff/log, directory listings): run them, do not ask. Asking permission
          to verify defeats the requirement to verify. Starting THIS project's own server or
          watcher on localhost with background: true counts as verification — run it, and
          stop it before you finish.
        - State-changing commands (npm/pip install, network access, writing outside the
          workspace, anything not bound to localhost): ask once, then honour "sempre permitir".
          Read the lockfile before picking a package manager: package-lock.json → npm,
          pnpm-lock.yaml → pnpm, yarn.lock → yarn.
        - Destructive commands: ALWAYS ask, every time — recursive deletes, history rewrites
          (git reset --hard, push --force), DROP/TRUNCATE, sudo/runas, format/dd/mkfs.
          "sempre permitir" never covers these. They also require confirmed: true.

        SAFETY:
        - Output defaults to 8000 characters, preserving the beginning and end
        - Timeout is 30 seconds (max 120)
        - Commands matching a destructive pattern are refused unless confirmed: true. That
          detector is a BACKSTOP, not the policy — it will miss destructive commands it does
          not match, so classify semantically yourself. "It wasn't blocked" is not approval.

        Examples:
        - execute_command("git status")
        - execute_command("npm run build")
        - execute_command("npx tsc --noEmit")
        - execute_command("dir /b src")                      → Windows; use 'ls' on POSIX
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
        maxOutputChars: z
          .number()
          .int()
          .min(1000)
          .max(MAX_OUTPUT_CHARS)
          .optional()
          .default(DEFAULT_MAX_OUTPUT_CHARS)
          .describe("Maximum output characters returned. Default 8000, max 50000. Beginning and end are preserved."),
        confirmed: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set to true ONLY after the user has explicitly confirmed. For dangerous commands, this is ALWAYS required."),
      },
    },
    async ({ command, cwd, timeout, background, maxOutputChars, confirmed }) => {
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

          const rawOutput =
            warmupOutput.length > 0
              ? warmupOutput.join("\n")
              : "(nenhuma saída nos primeiros 2 segundos)";

          const output = compactOutput(rawOutput, maxOutputChars).text;

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

        const output = compactOutput(commandStreams(stdout, stderr), maxOutputChars).text;

        return {
          content: [
            {
              type: "text" as const,
              text: `Command: ${command}\nDirectory: ${workingDir}\n\n${output}`,
            },
          ],
        };
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);

        // Handle timeout specifically (background commands have no timeout)
        if (!background && (message.includes("timeout") || message.includes("killed"))) {
          message = `Command timed out after ${timeout} seconds.`;
        }

        const execError = error as { stdout?: string; stderr?: string };
        const captured = commandStreams(execError.stdout ?? "", execError.stderr ?? "");
        const details = captured === "(no output)"
          ? message
          : `${message}\n\n${captured}`;
        const compacted = compactOutput(details, maxOutputChars).text;

        return {
          content: [
            {
              type: "text" as const,
              text: `Error executing command:\n${compacted}`,
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
        maxOutputChars: z.number().int().min(1000).max(MAX_OUTPUT_CHARS).optional().default(DEFAULT_MAX_OUTPUT_CHARS).describe("Maximum log characters returned. Default 8000, max 50000."),
      },
    },
    async ({ id, lines, maxOutputChars }) => {
      const result = readBackgroundOutput(id, lines);
      if (!result) return unknownIdResult(id);

      const { snapshot, omitted } = result;
      const rawBody = result.lines.length > 0 ? result.lines.join("\n") : "(no output captured)";
      const compacted = compactOutput(rawBody, maxOutputChars);
      const body = compacted.text;

      const notes: string[] = [];
      if (compacted.omittedChars > 0) notes.push(`${compacted.omittedChars} character(s) omitted by the response limit.`);
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
      const rawBody = tail.length > 0 ? tail.join("\n") : "(no output captured)";
      const body = compactOutput(rawBody, DEFAULT_MAX_OUTPUT_CHARS).text;

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

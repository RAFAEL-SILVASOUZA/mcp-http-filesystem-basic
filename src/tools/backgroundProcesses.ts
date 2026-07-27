import { spawn, spawnSync } from "child_process";
import type { ChildProcess } from "child_process";

/**
 * Registro de processos em background.
 *
 * O Map vive no escopo do módulo, e não no do McpServer, porque
 * `createMcpServer` é chamado por sessão HTTP (ver server/express.ts).
 * Um registro por sessão faria a sessão seguinte perder o acesso aos
 * processos da anterior — que virariam órfãos, sem forma de serem mortos.
 */

const MAX_OUTPUT_LINES = 1000;
const MAX_EXITED_ENTRIES = 20;
const WARMUP_MS = 2000;
const KILL_GRACE_MS = 3000;

const isWindows = process.platform === "win32";

export type ProcessStatus = "running" | "exited" | "killed";

interface BackgroundProcess {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: Date;
  exitedAt: Date | null;
  status: ProcessStatus;
  exitCode: number | null;
  output: string[];
  truncated: boolean;
  child: ChildProcess;
}

export interface ProcessSnapshot {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: Date;
  exitedAt: Date | null;
  status: ProcessStatus;
  exitCode: number | null;
  uptimeSeconds: number;
  outputLines: number;
  truncated: boolean;
}

const registry = new Map<string, BackgroundProcess>();
let counter = 0;

function snapshot(proc: BackgroundProcess): ProcessSnapshot {
  const end = proc.exitedAt ?? new Date();
  return {
    id: proc.id,
    pid: proc.pid,
    command: proc.command,
    cwd: proc.cwd,
    startedAt: proc.startedAt,
    exitedAt: proc.exitedAt,
    status: proc.status,
    exitCode: proc.exitCode,
    uptimeSeconds: Math.round((end.getTime() - proc.startedAt.getTime()) / 1000),
    outputLines: proc.output.length,
    truncated: proc.truncated,
  };
}

function pushLine(proc: BackgroundProcess, line: string) {
  proc.output.push(line);
  if (proc.output.length > MAX_OUTPUT_LINES) {
    proc.output.splice(0, proc.output.length - MAX_OUTPUT_LINES);
    proc.truncated = true;
  }
}

/**
 * Chunks de stdout/stderr chegam fragmentados — uma linha pode vir partida
 * entre dois chunks. Só linhas completas entram no buffer; o resto fica
 * pendente até o próximo chunk (ou até o flush, no exit).
 */
function createLineAccumulator(proc: BackgroundProcess) {
  let pending = "";
  return {
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) pushLine(proc, line.replace(/\r$/, ""));
    },
    flush() {
      if (pending.length > 0) {
        pushLine(proc, pending.replace(/\r$/, ""));
        pending = "";
      }
    },
  };
}

function pruneExited() {
  const exited = [...registry.values()].filter((p) => p.status !== "running");
  if (exited.length <= MAX_EXITED_ENTRIES) return;
  exited.sort((a, b) => (a.exitedAt?.getTime() ?? 0) - (b.exitedAt?.getTime() ?? 0));
  for (const p of exited.slice(0, exited.length - MAX_EXITED_ENTRIES)) {
    registry.delete(p.id);
  }
}

/**
 * Mata a ÁRVORE de processos, não apenas o PID registrado.
 *
 * Com `shell: true`, no Windows o PID é o do cmd.exe e o node real é filho
 * dele — matar só o PID deixaria a API órfã segurando a porta. O /T do
 * taskkill resolve isso. Em POSIX, o spawn usa `detached: true` para criar
 * um grupo de processos próprio, e o kill negativo atinge o grupo inteiro.
 */
function killTree(pid: number, force: boolean) {
  if (pid <= 0) return;

  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // processo já morreu
    }
  }
}

function waitForExit(proc: BackgroundProcess, ms: number): Promise<boolean> {
  if (proc.exitedAt) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      proc.child.removeListener("exit", onExit);
      resolve(false);
    }, ms);
    proc.child.once("exit", onExit);
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface StartResult {
  snapshot: ProcessSnapshot;
  warmupOutput: string[];
}

/**
 * Inicia o comando em background e aguarda ~2s antes de retornar, para que a
 * saída de inicialização (ex: "Server listening on :3000" ou "EADDRINUSE")
 * já venha no primeiro retorno.
 */
export async function startBackgroundProcess(command: string, cwd: string): Promise<StartResult> {
  const child = spawn(command, {
    shell: true,
    cwd,
    windowsHide: true,
    detached: !isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const id = `bg-${++counter}`;
  const proc: BackgroundProcess = {
    id,
    pid: child.pid ?? -1,
    command,
    cwd,
    startedAt: new Date(),
    exitedAt: null,
    status: "running",
    exitCode: null,
    output: [],
    truncated: false,
    child,
  };

  const stdoutAcc = createLineAccumulator(proc);
  const stderrAcc = createLineAccumulator(proc);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdoutAcc.push(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderrAcc.push(chunk));

  const state = { spawnError: null as Error | null };

  child.on("error", (err: Error) => {
    state.spawnError = err;
    pushLine(proc, `[erro ao iniciar] ${err.message}`);
    if (proc.status === "running") {
      proc.status = "exited";
      proc.exitedAt = new Date();
    }
  });

  child.on("exit", (code, signal) => {
    stdoutAcc.flush();
    stderrAcc.flush();
    proc.exitedAt = new Date();
    proc.exitCode = code;
    if (code === null && signal) {
      pushLine(proc, `[processo encerrado pelo sinal ${signal}]`);
    }
    if (proc.status === "running") proc.status = "exited";
  });

  registry.set(id, proc);
  pruneExited();

  await delay(WARMUP_MS);

  // Falha de spawn (cwd inexistente, binário não encontrado): não há processo
  // para gerenciar, então não faz sentido deixar a entrada no registro.
  if (state.spawnError && proc.pid <= 0) {
    registry.delete(id);
    throw new Error(state.spawnError.message);
  }

  return { snapshot: snapshot(proc), warmupOutput: [...proc.output] };
}

export function listBackgroundProcesses(): ProcessSnapshot[] {
  return [...registry.values()].map(snapshot);
}

export function getRegisteredIds(): string[] {
  return [...registry.keys()];
}

export interface OutputResult {
  snapshot: ProcessSnapshot;
  lines: string[];
  omitted: number;
}

export function readBackgroundOutput(id: string, lines: number): OutputResult | null {
  const proc = registry.get(id);
  if (!proc) return null;

  const requested = Math.max(1, lines);
  const slice = proc.output.slice(-requested);
  return {
    snapshot: snapshot(proc),
    lines: slice,
    omitted: proc.output.length - slice.length,
  };
}

export interface StopResult {
  snapshot: ProcessSnapshot;
  alreadyExited: boolean;
  forced: boolean;
  tail: string[];
}

export async function stopBackgroundProcess(id: string): Promise<StopResult | null> {
  const proc = registry.get(id);
  if (!proc) return null;

  if (proc.status !== "running") {
    return {
      snapshot: snapshot(proc),
      alreadyExited: true,
      forced: false,
      tail: proc.output.slice(-20),
    };
  }

  proc.status = "killed";
  killTree(proc.pid, false);

  let forced = false;
  const exited = await waitForExit(proc, KILL_GRACE_MS);
  if (!exited) {
    forced = true;
    killTree(proc.pid, true);
    await waitForExit(proc, KILL_GRACE_MS);
  }

  return {
    snapshot: snapshot(proc),
    alreadyExited: false,
    forced,
    tail: proc.output.slice(-20),
  };
}

/**
 * Encerramento síncrono de tudo que ainda estiver vivo. Precisa ser síncrono
 * porque o handler de 'exit' do Node não executa trabalho assíncrono.
 */
export function killAllBackgroundProcesses() {
  for (const proc of registry.values()) {
    if (proc.status !== "running") continue;
    proc.status = "killed";
    killTree(proc.pid, true);
  }
}

// Sem isto, derrubar o servidor MCP deixaria servidores de desenvolvimento
// órfãos segurando as portas.
process.on("exit", killAllBackgroundProcesses);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killAllBackgroundProcesses();
    process.exit(0);
  });
}

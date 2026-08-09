import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultWorkerPath = fileURLToPath(new URL('./embed-worker.ts', import.meta.url));

interface Pending {
  resolve: (v: number[][]) => void;
  reject: (e: Error) => void;
}

/**
 * Server-side handle to the on-demand bge-m3 worker (ADR-0060). The API process
 * itself holds NO model — it lazily forks the worker on first use, multiplexes
 * embed requests over IPC by id, and transparently respawns after the worker
 * self-exits on idle. `preheat()` is the SSE-connect hook (S3): warm the model
 * while the user is still typing so the first query isn't a 5–15s cold start.
 */
export class EmbedSidecar {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  dim = 0;

  constructor(
    private workerPath: string = defaultWorkerPath,
    private execArgv: string[] = ['--import', 'tsx'],
  ) {}

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    const child = fork(this.workerPath, [], {
      execArgv: this.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      child.on('message', (msg: any) => {
        if (msg?.ready) {
          this.dim = msg.dim;
          settled = true;
          resolve();
          return;
        }
        if (msg?.id != null) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.vecs);
        }
      });
      const fail = (err: Error) => {
        this.child = null;
        this.ready = null;
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (!settled) reject(err); // no-op once ready has resolved (idle exit)
      };
      child.on('exit', (code) => fail(new Error(`embed worker exited (code ${code})`)));
      child.on('error', fail);
    });
    return this.ready;
  }

  /** Fire-and-forget warm-up (SSE connect). Swallows spawn errors. */
  preheat(): void {
    this.ensure().catch(() => {});
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.ensure();
    const child = this.child;
    if (!child) throw new Error('embed worker unavailable');
    const id = this.seq++;
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.send({ id, texts });
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
}

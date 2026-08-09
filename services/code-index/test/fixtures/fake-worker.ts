// Test fixture: an IPC-compatible embed worker that loads NO model. Mirrors the
// embed-worker protocol so EmbedSidecar can be exercised fast. Encodes its own pid
// into the first vector component so a test can detect a respawn (new process).
const IDLE = Number(process.env.FAKE_IDLE_MS || 0);
let timer: NodeJS.Timeout | undefined;
const resetIdle = () => {
  if (IDLE <= 0) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => process.exit(0), IDLE);
  timer.unref();
};

process.on('message', (msg: { id: number; texts: string[] }) => {
  resetIdle();
  const vecs = msg.texts.map((t) => [process.pid, t.length, 0]);
  process.send?.({ id: msg.id, vecs });
});

process.send?.({ ready: true, dim: 3, pid: process.pid });
resetIdle();

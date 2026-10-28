// Bound local download/transcode work independently of the upstream task count.
export class WorkGate {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  acquire(signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = {resolve, reject, signal};
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', entry.abort, {once: true});
      this.queue.push(entry); this.drain();
    });
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) { entry.reject(entry.signal.reason); continue; }
      this.active++;
      let released = false;
      entry.resolve(() => { if (!released) { released = true; this.active--; this.drain(); } });
    }
  }
  async run(work, signal) {
    const release = await this.acquire(signal);
    try { signal?.throwIfAborted(); return await work(); }
    finally { release(); }
  }
}

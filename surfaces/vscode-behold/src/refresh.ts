/**
 * Re-read on save, without a pile of reads. A change schedules one read after
 * a short quiet period; a change that arrives while a read runs schedules one
 * more after it, so the last save is always the one drawn.
 */
export class Refresher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private again = false;
  private disposed = false;

  constructor(
    private readonly read: () => Promise<void>,
    private readonly quietMs = 300,
  ) {}

  /** Schedule a read (the first one too: it is not special). */
  request(): void {
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.quietMs);
  }

  /** Read now, bypassing the quiet period. */
  now(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.run();
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      await this.read();
    } finally {
      this.running = false;
      if (this.again && !this.disposed) {
        this.again = false;
        this.request();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Whether saving `path` can change what a folder draws: Terraform and chant source, and the JSON, YAML and workspace files members read. */
export function affectsGraph(path: string, root: string): boolean {
  const norm = path.split("\\").join("/");
  const base = root.split("\\").join("/").replace(/\/$/, "");
  if (norm !== base && !norm.startsWith(`${base}/`)) return false;
  const inside = norm.slice(base.length);
  if (/\/(node_modules|\.git|\.terraform|dist)\//.test(inside)) return false;
  return /\.(tf|tf\.json|tfvars|hcl|ts|json|ya?ml)$/i.test(inside) || /\/\.terraform\.lock\.hcl$/.test(inside);
}

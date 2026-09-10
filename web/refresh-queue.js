// One active refresh and one pending refresh, regardless of how many events
// arrive. All callers wait for the latest requested view to finish loading.
export function createRefreshQueue(run) {
  let active;
  let pending;
  let revision = 0;
  return (options = {}) => {
    revision++;
    pending = { ...options, quiet: pending ? !!pending.quiet && !!options.quiet : !!options.quiet };
    if (!active) {
      active = Promise.resolve().then(async () => {
        try {
          while (pending) {
            const next = pending;
            pending = undefined;
            const current = revision;
            await run(next, () => current === revision);
          }
        } finally {
          active = undefined;
        }
      });
    }
    return active;
  };
}

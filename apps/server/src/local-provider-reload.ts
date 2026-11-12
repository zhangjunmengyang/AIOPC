/** Retries local credential/config changes once active work permits an engine reload. */
export function createLocalProviderReload(options: { reload: () => Promise<boolean>; retryMs?: number }) {
  let stopped = false;
  let requested = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped || running || timer || !requested) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, options.retryMs ?? 1_000);
    timer.unref?.();
  };
  const flush = async () => {
    if (stopped || running || !requested) return;
    requested = false;
    running = true;
    try { if (!await options.reload()) requested = true; }
    catch { requested = true; }
    finally { running = false; schedule(); }
  };
  return {
    request() { if (!stopped) { requested = true; schedule(); } },
    stop() { stopped = true; requested = false; if (timer) clearTimeout(timer); timer = undefined; },
  };
}

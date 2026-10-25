// Agent failures must finish promptly so the panel can show a retry action.
export async function agentJson(url, { timeout = 5000 } = {}) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Feel agent timed out. Check your dev server and try again.'));
    }, timeout);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`Feel agent returned ${res.status}. Check your dev server and try again.`);
        return res.json();
      })(),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

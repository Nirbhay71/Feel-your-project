// axios support: keep your code in the stack even when axios sends later.
//
// With a request interceptor, axios doesn't send right away — it runs the
// interceptors first (asynchronously), so when XMLHttpRequest.send() finally
// runs, the stack only has axios in it. Especially with .then() chains
// (salaryApi.getRule(id).then(…)) there's no trace of who asked.
//
// So: capture the stack when you *call* axios (Axios.prototype.request, which
// api.get/post/… all go through), and run axios's adapter — the part that
// creates the XHR and sends it — inside withStack(), so network.js records
// that stack instead of the late one.
//
// Loaded by the Vite plugin only when the app has axios installed.

import { captureStack, withStack } from './network.js';

export function patchAxios(axios) {
  const proto = axios?.Axios?.prototype;
  if (!proto || proto.__feelPatched || typeof axios.getAdapter !== 'function') return;
  proto.__feelPatched = true;

  const request = proto.request;
  proto.request = function (configOrUrl, config) {
    const stack = captureStack(); // your code is still on the stack here
    const cfg = typeof configOrUrl === 'string' ? { ...config, url: configOrUrl } : { ...configOrUrl };

    // Wrap whichever adapter would have been used (yours, or the default).
    const adapter = axios.getAdapter(cfg.adapter ?? this.defaults.adapter ?? axios.defaults.adapter);
    cfg.adapter = (resolved) => withStack(stack, () => adapter(resolved));
    return request.call(this, cfg);
  };
}

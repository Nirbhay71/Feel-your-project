import http from 'node:http';

// These tests exercise Node HTTP servers, not browser networking. Node's
// fetch rejects some OS-assigned ephemeral ports before sending a request.
export function localFetch(url, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve(new Response(
        [204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks),
        { status: res.statusCode, headers: res.headers },
      )));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Local test server timed out')));
    request.on('error', reject);
  });
}

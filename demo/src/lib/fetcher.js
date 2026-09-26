// The usual SWR fetcher: SWR calls it with the key (the URL).
// Shared by several components — which makes "who made this request?" harder.
export const fetcher = (url) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  });

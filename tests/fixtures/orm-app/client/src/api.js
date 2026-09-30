export const getJson = (url, options) => fetch(url, options).then((r) => r.json());

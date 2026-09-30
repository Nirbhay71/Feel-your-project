// The loader withFeel registers with Next's bundler — a Turbopack rule and a
// webpack rule both point at this file (see index.js).
//
// It's CommonJS because that's what both bundlers load loaders as; the real
// work is in transform.js (ES module), loaded on first use. Any failure hands
// the file on untouched: Feel must never be the reason your app won't build.

module.exports = function feelLoader(source, inputMap) {
  const callback = this.async();
  const options = (this.getOptions ? this.getOptions() : this.query) || {};
  const file = this.resourcePath;
  if (/[\\/]node_modules[\\/]/.test(file)) return callback(null, source, inputMap);

  import('./transform.js')
    .then(({ transformForNext }) => transformForNext(String(source), file, options))
    .catch(() => null)
    .then((out) => {
      if (!out) return callback(null, source, inputMap);
      // Both bundlers chain a returned map onto their own; with the file's
      // text inside it, the browser devtools show what you wrote.
      if (out.map && !out.map.sourcesContent?.[0]) out.map.sourcesContent = [String(source)];
      callback(null, out.code, out.map ?? undefined);
    });
};

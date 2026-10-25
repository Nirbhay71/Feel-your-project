// Bounded syntax edits preserve the app's config, comments and plugin order.
// Unusual configurations get manual instructions instead of guessed edits.
import { parse } from '@babel/parser';
import MagicString from 'magic-string';

const tree = (code, file) => parse(code, { sourceType: 'unambiguous', plugins: /\.[cm]?ts$/.test(file) ? ['typescript'] : [] });
const imported = (node, source) => node.type === 'ImportDeclaration' && node.source.value === source;
const required = (node, source) => node?.type === 'CallExpression' && node.callee.name === 'require' && node.arguments[0]?.value === source;
const moduleExport = (node) => node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' && node.expression.left.type === 'MemberExpression' && node.expression.left.object.name === 'module' && node.expression.left.property.name === 'exports';
function preamble(ast) { return ast.program.directives.at(-1)?.end ?? ast.program.interpreter?.end ?? 0; }
function unique(code, name) { while (new RegExp(`\\b${name}\\b`).test(code)) name += '_'; return name; }
function configExport(ast) {
  const nodes = ast.program.body.filter((n) => n.type === 'ExportDefaultDeclaration' || moduleExport(n));
  if (nodes.length !== 1) throw new Error('Could not identify one config export.');
  const node = nodes[0];
  return { expression: node.declaration ?? node.expression.right, cjs: moduleExport(node) };
}

export function configEdit(code, file, framework, relativeRoot = '.') {
  const ast = tree(code, file);
  const out = new MagicString(code);
  const { expression, cjs } = configExport(ast);
  const source = framework === 'next' ? '@feel-dev/next' : '@feel-dev/vite-plugin';
  if (ast.program.body.some((n) => imported(n, source.replace('@feel-dev/', '@feel/')) || n.type === 'VariableDeclaration' && n.declarations.some((d) => required(d.init, source.replace('@feel-dev/', '@feel/'))))) throw new Error('Legacy @feel packages found. Replace the old integration before adding @feel-dev to avoid loading Feel twice.');
  let binding;
  for (const node of ast.program.body) {
    if (imported(node, source)) binding = node.specifiers.find((s) => framework === 'next' ? s.imported?.name === 'withFeel' : s.type === 'ImportDefaultSpecifier')?.local.name;
    if (node.type === 'VariableDeclaration') for (const d of node.declarations) {
      if (required(d.init, source) || d.init?.type === 'MemberExpression' && d.init.property.name === 'default' && required(d.init.object, source)) binding = d.id.type === 'Identifier' && framework === 'vite' ? d.id.name : d.id.type === 'ObjectPattern' ? d.id.properties.find((p) => p.key.name === 'withFeel')?.value.name : undefined;
    }
  }
  const existing = !!binding;
  binding ??= unique(code, framework === 'next' ? 'feelWithNext' : 'feelPlugin');
  let options = '';
  if (relativeRoot !== '.') {
    if (framework === 'next') options = `{ projectRoot: ${JSON.stringify(relativeRoot)} }`;
    else if (cjs) options = `{ projectRoot: require('node:path').resolve(__dirname, ${JSON.stringify(relativeRoot)}) }`;
    else {
      const url = unique(code, 'feelFileURLToPath');
      out.appendLeft(preamble(ast), `\nimport { fileURLToPath as ${url} } from 'node:url';\n`);
      options = `{ projectRoot: ${url}(new URL(${JSON.stringify(relativeRoot + '/')}, import.meta.url)) }`;
    }
  }
  if (framework === 'next') {
    if (expression.type === 'CallExpression' && expression.callee.name === binding) return code;
    out.prependLeft(expression.start, `${binding}(`);
    out.appendRight(expression.end, `${options ? ', ' + options : ''})`);
  } else {
    let object = expression;
    if (object.type === 'Identifier') {
      object = ast.program.body.flatMap((n) => (n.declaration ?? n).declarations ?? []).find((d) => d.id.name === object.name)?.init;
    }
    if (object?.type === 'CallExpression' && object.arguments.length === 1) object = object.arguments[0];
    if (object?.type === 'ArrowFunctionExpression') object = object.body;
    if (object?.type === 'ArrowFunctionExpression' || object?.type === 'FunctionExpression') object = object.body;
    if (object?.type === 'BlockStatement') {
      const returns = object.body.filter((n) => n.type === 'ReturnStatement');
      object = returns.length === 1 ? returns[0].argument : null;
    }
    if (object?.type !== 'ObjectExpression') throw new Error('Vite config is dynamic; add Feel to its plugins array manually.');
    const plugins = object.properties.find((p) => p.key?.name === 'plugins' || p.key?.value === 'plugins');
    if (plugins && plugins.value?.type !== 'ArrayExpression') throw new Error('The plugins value is dynamic; add Feel manually.');
    if (plugins?.value.elements.some((n) => n?.type === 'CallExpression' && n.callee.name === binding)) return code;
    if (plugins) out.appendLeft(plugins.value.start + 1, `${binding}(${options})${plugins.value.elements.length ? ', ' : ''}`);
    else out.appendLeft(object.start + 1, `\n  plugins: [${binding}(${options})],`);
  }
  if (!existing) {
    const statement = cjs
      ? framework === 'next' ? `const { withFeel: ${binding} } = require('${source}');` : `const ${binding} = require('${source}').default;`
      : framework === 'next' ? `import { withFeel as ${binding} } from '${source}';` : `import ${binding} from '${source}';`;
    out.appendLeft(preamble(ast), '\n' + statement + '\n');
  }
  return out.toString();
}

export function firstImport(code, file, source, cjs = false) {
  const ast = tree(code, file);
  if (ast.program.body.some((n) => imported(n, source.replace('@feel-dev/', '@feel/')) || n.type === 'ExpressionStatement' && required(n.expression, source.replace('@feel-dev/', '@feel/')))) throw new Error('Legacy @feel registration found. Replace it with the current @feel-dev import instead of loading both.');
  cjs = cjs && ast.program.sourceType !== 'module';
  const out = new MagicString(code);
  const node = ast.program.body.find((n) => imported(n, source) || n.type === 'ExpressionStatement' && required(n.expression, source));
  if (node === ast.program.body[0]) return code;
  if (node) out.remove(node.start, node.end);
  out.appendLeft(preamble(ast), `\n${cjs ? `require('${source}');` : `import '${source}';`}\n`);
  return out.toString();
}

export function instrumentationEdit(code, file) {
  const ast = tree(code, file);
  const declaration = ast.program.body.map((n) => n.declaration ?? n).find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'register');
  if (!declaration) throw new Error('Existing instrumentation has no plain register function; merge the development import manually.');
  const hasImport = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'CallExpression' && node.callee.type === 'Import' && node.arguments[0]?.value === '@feel-dev/next/register') return true;
    return Object.values(node).some((value) => Array.isArray(value) ? value.some(hasImport) : hasImport(value));
  };
  if (hasImport(declaration.body)) return code;
  const out = new MagicString(code);
  if (!declaration.async) out.prependLeft(declaration.start, 'async ');
  const position = declaration.body.directives.at(-1)?.end ?? declaration.body.start + 1;
  out.appendLeft(position, "\n  if (process.env.NODE_ENV === 'development' && process.env.NEXT_RUNTIME === 'nodejs') {\n    await import('@feel-dev/next/register');\n  }\n");
  return out.toString();
}

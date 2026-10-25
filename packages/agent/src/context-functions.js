// Follow a destructured callback from a custom context hook to a single,
// statically identifiable provider in the hook's module. Ambiguous or dynamic
// providers stay unresolved rather than attributing another component's calls.
import { traverse, findTopLevelFunction, functionName } from './ast.js';
import { loadFile, refTarget } from './files.js';

function reactCall(call, name) {
  if (!call?.isCallExpression()) return false;
  const callee = call.get('callee');
  if (callee.isIdentifier()) {
    const binding = callee.scope.getBinding(callee.node.name)?.path;
    return binding?.isImportSpecifier() && binding.node.imported.name === name && binding.parent.source.value === 'react';
  }
  if (!callee.isMemberExpression() || callee.node.computed || callee.node.property.name !== name) return false;
  const binding = callee.scope.getBinding(callee.node.object.name)?.path;
  return (binding?.isImportDefaultSpecifier() || binding?.isImportNamespaceSpecifier()) && binding.parent.source.value === 'react';
}

function valueOf(p) {
  if (p.isIdentifier()) {
    const binding = p.scope.getBinding(p.node.name);
    if (!binding?.constant) return p;
    if (binding.path.isVariableDeclarator()) return binding.path.get('init');
    if (binding.path.isFunctionDeclaration()) return binding.path;
  }
  return p;
}

async function contextCallback(hookTarget, property) {
  const loaded = await loadFile(hookTarget.file).catch(() => null);
  const hook = loaded?.ast && findTopLevelFunction(loaded.ast, hookTarget.name);
  if (!hook) return null;
  const contexts = [];
  const inspectReturn = (expression) => {
    const call = valueOf(expression);
    if (!reactCall(call, 'useContext')) return;
    const context = call.get('arguments.0');
    if (!context?.isIdentifier()) return;
    const binding = context.scope.getBinding(context.node.name);
    // Restrict inference to a context created in this module.
    if (binding?.constant && binding.scope.path.isProgram() && binding.path.isVariableDeclarator() && reactCall(binding.path.get('init'), 'createContext')) contexts.push(binding);
  };
  const body = hook.get('body');
  if (!body.isBlockStatement()) inspectReturn(body);
  else hook.traverse({ ReturnStatement(p) { if (p.getFunctionParent() === hook && p.node.argument) inspectReturn(p.get('argument')); } });
  if (contexts.length !== 1) return null;
  const context = contexts[0];
  const providers = [];
  traverse(loaded.ast, {
    JSXOpeningElement(p) {
      const name = p.node.name;
      const identifier = name.type === 'JSXMemberExpression' && name.property.name === 'Provider' ? name.object : name;
      if (identifier.type !== 'JSXIdentifier' || p.scope.getBinding(identifier.name) !== context) return;
      providers.push(p);
    },
  });
  if (providers.length !== 1) return null;
  const attr = providers[0].get('attributes').find((p) => p.isJSXAttribute() && p.node.name.name === 'value');
  if (!attr?.get('value').isJSXExpressionContainer()) return null;
  const value = valueOf(attr.get('value.expression'));
  if (!value.isObjectExpression()) return null;
  const prop = value.get('properties').find((p) => !p.node.computed && (p.node.key?.name ?? p.node.key?.value) === property);
  if (!prop?.isObjectProperty()) return null;
  let fn = valueOf(prop.get('value'));
  if (reactCall(fn, 'useCallback')) fn = fn.get('arguments.0');
  if (!fn?.isFunction()) return null;
  return { file: hookTarget.file, name: functionName(fn) ?? property, fn };
}

export async function contextFunctions(fn, file) {
  const references = new Map();
  fn.traverse({
    Identifier(p) {
      if (!p.isReferencedIdentifier()) return;
      const binding = p.scope.getBinding(p.node.name);
      if (!binding?.constant) return;
      const declaration = binding?.path;
      if (!declaration?.isVariableDeclarator() || declaration.node.id.type !== 'ObjectPattern') return;
      const property = declaration.node.id.properties.find((p) => p.type === 'ObjectProperty' && !p.computed && p.value.type === 'Identifier' && p.value.name === binding.identifier.name);
      const init = declaration.get('init');
      if (!property || !init.isCallExpression()) return;
      const target = refTarget(init.get('callee'), file);
      if (target) references.set(`${target.file}#${target.name}:${property.key.name ?? property.key.value}`, { target, property: property.key.name ?? property.key.value });
    },
  });
  const targets = await Promise.all([...references.values()].map(({ target, property }) => contextCallback(target, property)));
  return targets.filter(Boolean);
}

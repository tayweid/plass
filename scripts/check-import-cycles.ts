import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const sourceRoot = path.resolve('src');
const files = walk(sourceRoot).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
const fileSet = new Set(files);
const graph = new Map<string, string[]>();

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const deps: string[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    let specifier: string | null = null;
    if (ts.isImportDeclaration(statement) && isValueImport(statement)) {
      specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifier = statement.moduleSpecifier.text;
    }
    if (!specifier) continue;
    if (!specifier.startsWith('.')) continue;
    const base = path.resolve(path.dirname(file), specifier);
    const resolved = [base, `${base}.ts`, path.join(base, 'index.ts')].find((candidate) => fileSet.has(candidate));
    if (resolved) deps.push(resolved);
  }
  graph.set(file, deps);
}

function isValueImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

const visiting = new Set<string>();
const visited = new Set<string>();
const stack: string[] = [];
const cycles: string[][] = [];

function visit(file: string) {
  if (visited.has(file)) return;
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.push([...stack.slice(start), file]);
    return;
  }
  visiting.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}

for (const file of files) visit(file);

if (cycles.length) {
  console.error('Static import cycles detected:');
  for (const cycle of cycles) {
    console.error('  ' + cycle.map((file) => path.relative(process.cwd(), file)).join(' -> '));
  }
  process.exit(1);
}
console.log(`static import graph is acyclic (${files.length} modules)`);

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

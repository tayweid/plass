import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('tsconfig.json not found');

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], formatHost()));
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath), {
  noEmit: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
});
const program = ts.createProgram(parsed.fileNames, parsed.options);
const unusedCodes = new Set([6133, 6192, 6196]);
const frozenLinebreaker = path.resolve('src/layout/port/linebreak.ts');

const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
  if (!unusedCodes.has(diagnostic.code)) return false;
  // The vendored Typst line breaker is deliberately frozen byte-for-byte.
  // Its unused `Item` type import is the sole checked-in exception; remove
  // this waiver when the next upstream port naturally touches that file.
  if (
    diagnostic.code === 6196 &&
    diagnostic.file &&
    path.resolve(diagnostic.file.fileName) === frozenLinebreaker &&
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').includes("'Item'")
  ) {
    return false;
  }
  return true;
});

if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost()));
  process.exit(1);
}
console.log('unused-code check passed (one documented frozen-port exception)');

function formatHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => ts.sys.newLine,
  };
}

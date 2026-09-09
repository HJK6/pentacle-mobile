import { register } from 'node:module';
import Module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expoConstantsStub = fileURLToPath(new URL('./stubs/expoConstants.cjs', import.meta.url));
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveExpoConstantsAlias(request, parent, isMain, options) {
  return resolveFilename.call(
    this,
    request === 'expo-constants' ? expoConstantsStub : request,
    parent,
    isMain,
    options,
  );
};

const hookSource = `
const expoConstantsStub = ${JSON.stringify(pathToFileURL(expoConstantsStub).href)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'expo-constants') {
    return nextResolve(expoConstantsStub, context);
  }
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url);

export function createRequire(): never {
  throw new Error("Node.js module loading is unavailable in the browser");
}

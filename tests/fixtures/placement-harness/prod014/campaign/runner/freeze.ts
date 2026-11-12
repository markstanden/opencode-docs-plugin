// Typecheck shim only: a materialised campaign supplies ../runner/freeze.ts
// from the pinned analysis modules. The live commands never import this copy.
export * from "../../../analysis/freeze.ts";

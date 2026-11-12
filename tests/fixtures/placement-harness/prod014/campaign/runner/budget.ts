// Typecheck shim only: a materialised campaign supplies ../runner/budget.ts
// from the pinned analysis modules. The live commands never import this copy.
export * from "../../../analysis/budget.ts";

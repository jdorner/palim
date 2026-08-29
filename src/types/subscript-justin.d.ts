/**
 * Ambient type declaration for the `subscript/justin` subpath export.
 *
 * The `subscript` package ships types for its main entry (`subscript.d.ts`)
 * but not for the `/justin` preset subpath. This declares the default export
 * as a callable that compiles an expression string into an evaluator, matching
 * the runtime shape used in `templateEval.ts`.
 */
declare module "subscript/justin" {
  /** A compiled expression evaluator: given a context object, returns a value. */
  export type Evaluator = (ctx?: Record<string, unknown>) => unknown;

  /**
   * Compile an expression string (justin preset: JSON + expressions +
   * templates + arrows) into an evaluator.
   *
   * @param source - The expression source
   * @returns A compiled evaluator function
   */
  const justin: (source: string) => Evaluator;

  export default justin;
}

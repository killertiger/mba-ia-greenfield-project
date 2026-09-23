/**
 * Stub for `@css-inline/css-inline`, mapped in both Jest configs.
 *
 * The real package is a native (N-API) binding that `HandlebarsAdapter`
 * requires at import time. It registers a `CustomGC` handle that is never
 * released, so Jest hangs after the suites finish and only exits with
 * `--forceExit` — which would also hide genuine leaks (an undestroyed
 * DataSource, an app that was never closed).
 *
 * Replacing it under test is safe because the mail templates contain no CSS
 * at all, so inlining is a no-op for them: `inline()` returns the HTML as is.
 * If a template ever gains a `<style>` block and a test needs to assert on the
 * inlined result, that test must exercise `inline()` some other way.
 */
export function inline(html: string): string {
  return html;
}

export function inlineFragment(html: string): string {
  return html;
}

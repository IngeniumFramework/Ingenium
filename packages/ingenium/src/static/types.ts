/**
 * Options for the `ingenium.static` middleware.
 */
export interface StaticOptions {
  /**
   * The file to serve when a directory is requested. Set to `false` to
   * disable directory-index resolution. Default: `'index.html'`.
   */
  index?: string | false

  /**
   * `Cache-Control: max-age=<seconds>` to set on served files, in
   * MILLISECONDS (Express convention). Default: `0` (no caching).
   */
  maxAge?: number

  /**
   * Extensions to try (in order) when the requested path doesn't exist.
   * For example, `['html']` lets `/about` resolve to `/about.html`.
   * Default: `[]` (off).
   */
  extensions?: string[]

  /**
   * How to treat files / directories whose name starts with `.`:
   * - `'allow'`  — serve normally
   * - `'deny'`   — respond with 403
   * - `'ignore'` — call `next()` (let routes 404 it). DEFAULT.
   */
  dotfiles?: 'allow' | 'deny' | 'ignore'

  /**
   * How to treat symlinks whose real target escapes `root`:
   * - `'deny'`  — resolve the final target with `realpath` and 403 if it lands
   *   outside the (realpath-resolved) root. DEFAULT.
   * - `'allow'` — skip the realpath check and serve whatever the lexical path
   *   resolves to, even across a symlink that points out of `root`.
   *
   * WHY the default is `'deny'`: the lexical `..`/confinement check is defeated
   * by a symlink *inside* the root that points outside it (e.g. a link planted
   * in a user-upload directory) — the joined path stays under root but the bytes
   * served come from elsewhere. Resolving the real target closes that escape.
   * Costs one extra `realpath` per served file; set `'allow'` if you
   * deliberately symlink assets in from outside the root and accept the risk.
   */
  symlinks?: 'allow' | 'deny'
}

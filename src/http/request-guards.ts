/**
 * Guards shared by the catalog build (scripts), the catalog loader and the HTTP client, so that a
 * crafted WADL or a tampered catalog is refused at every stage, not only at one of them.
 */

/** Characters that have no business in a REST operation path: query, fragment, backslash, controls, spaces. */
// oxlint-disable-next-line eslint/no-control-regex -- control characters are exactly what is refused
const FORBIDDEN_CHARS = /[?#\\\s\u0000-\u001f\u007f]/;
/** Percent-encoded dot, slash and backslash: URL normalisation or a proxy could turn them into traversal. */
const ENCODED_SEPARATOR = /%(?:2e|2f|5c)/i;

/**
 * Why `path` is not a safe REST operation path, or `undefined` when it is. A safe path starts with
 * `/rest/`, has no `.` or `..` segment, no encoded dot, slash or backslash, no backslash, query,
 * fragment, whitespace or control character, and stays under `/rest/` once normalised as a URL.
 */
export function restPathProblem(path: string): string | undefined {
  if (!path.startsWith('/rest/') || path.length === '/rest/'.length)
    return 'it must start with /rest/';
  if (FORBIDDEN_CHARS.test(path))
    return 'it contains a forbidden character (?, #, \\, whitespace or control character)';
  if (ENCODED_SEPARATOR.test(path))
    return 'it contains a percent-encoded dot, slash or backslash (%2e, %2f, %5c)';
  if (path.split('/').some((segment) => segment === '.' || segment === '..'))
    return 'it contains a "." or ".." segment';
  if (!new URL(path, 'https://host.invalid').pathname.startsWith('/rest/'))
    return 'it does not stay under /rest/ once normalised';
  return undefined;
}

/** Methods that always change state: never acceptable as `read` (POST may be, e.g. a JQL search). */
const NEVER_READ: ReadonlySet<string> = new Set(['PUT', 'PATCH', 'DELETE']);

/** Why `method` cannot carry the access class `access`, or `undefined` when the pair is acceptable. */
export function accessProblem(method: string, access: string): string | undefined {
  return access === 'read' && NEVER_READ.has(method)
    ? `${method} operations cannot be classified as read`
    : undefined;
}

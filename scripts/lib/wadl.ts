import { XMLParser } from 'fast-xml-parser';
import { PATH_PLACEHOLDER } from '../../src/catalog/catalog.ts';
import type { HttpMethod } from '../../src/http/jira-client.ts';
import { restPathProblem } from '../../src/http/request-guards.ts';
import type {
  ApiFamily,
  OperationParam,
  ParamType,
  ParsedOperation,
} from '../../src/catalog/types.ts';

type XmlDoc = string | { '#text'?: string; title?: string };
interface XmlParam {
  name: string;
  style?: string;
  type?: string;
  required?: string;
  repeating?: string;
  default?: string;
  doc?: XmlDoc[];
}
interface XmlRequest {
  param?: XmlParam[];
  representation?: { mediaType?: string }[];
}
interface XmlMethod {
  name: string;
  doc?: XmlDoc[];
  request?: XmlRequest[];
}
interface XmlResource {
  path: string;
  param?: XmlParam[];
  method?: XmlMethod[];
  resource?: XmlResource[];
}
interface XmlResources {
  base?: unknown;
  resource?: XmlResource[];
}
interface XmlRoot {
  application?: { resources?: XmlResources[] } | string;
}

const ARRAY_TAGS = new Set([
  'resources',
  'resource',
  'method',
  'param',
  'request',
  'representation',
  'doc',
]);
const METHODS: ReadonlySet<string> = new Set<HttpMethod>([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  textNodeName: '#text',
  stopNodes: ['*.doc'],
  isArray: (name, _jpath, _isLeaf, isAttribute) => !isAttribute && ARRAY_TAGS.has(name),
});

const INTEGER_TYPES: ReadonlySet<string> = new Set([
  'int',
  'long',
  'short',
  'integer',
  'byte',
  'unsignedint',
  'unsignedlong',
  'unsignedshort',
  'unsignedbyte',
  'nonnegativeinteger',
  'positiveinteger',
  'nonpositiveinteger',
  'negativeinteger',
]);

/** Maps an XML Schema type (any namespace prefix: `xs:`, `xsd:`…) to a parameter type. */
function mapType(xsType: string | undefined): ParamType {
  const t = (xsType ?? 'string').replace(/^[\w.-]+:/, '').toLowerCase();
  if (INTEGER_TYPES.has(t)) return 'integer';
  if (['double', 'float', 'decimal'].includes(t)) return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** A `<doc>` text, without CDATA markers; a doc with only a `title` attribute gives its title. */
function oneDoc(d: XmlDoc): string {
  const text = typeof d === 'string' ? d : (d['#text'] ?? '');
  const unwrapped = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return unwrapped.trim() || (typeof d === 'string' ? '' : (d.title ?? ''));
}

function docText(docs: XmlDoc[] | undefined): string {
  const raw = (docs ?? []).map(oneDoc).join(' ');
  return decodeEntities(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/**
 * Reduces each `{name}` / `{name: regex}` template to `{name}`. Braces are matched with a depth
 * counter, so a regex constraint may itself contain braces (e.g. `{key: [A-Z]{2,}-\d+}`).
 * An unbalanced `{` is left as is.
 */
export function stripTemplateConstraints(segment: string): string {
  let out = '';
  let i = 0;
  while (i < segment.length) {
    const open = segment.indexOf('{', i);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let j = open; j < segment.length; j++) {
      if (segment[j] === '{') depth++;
      else if (segment[j] === '}' && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close === -1) break;
    const inner = segment.slice(open + 1, close);
    const colon = inner.indexOf(':');
    out += `${segment.slice(i, open)}{${(colon === -1 ? inner : inner.slice(0, colon)).trim()}}`;
    i = close + 1;
  }
  return out + segment.slice(i);
}

function joinPath(base: string, segment: string): string {
  const clean = stripTemplateConstraints(segment).replace(/^\/+|\/+$/g, '');
  return clean ? `${base}/${clean}` : base;
}

/** Lowercase, without parameters (`; charset=…`), so that runtime checks compare plain types. */
export function normalizeMediaType(type: string): string {
  return (type.split(';')[0] ?? '').trim().toLowerCase();
}

function toQueryParam(p: XmlParam): OperationParam {
  const description = docText(p.doc);
  return {
    name: p.name,
    in: 'query',
    type: mapType(p.type),
    required: p.required === 'true',
    repeating: p.repeating === 'true',
    ...(p.default === undefined ? {} : { default: p.default }),
    ...(description ? { description } : {}),
  };
}

function pathParams(path: string, templateTypes: ReadonlyMap<string, ParamType>): OperationParam[] {
  // A placeholder repeated in a path (`{x}/b/{x}`) is one parameter.
  const names = [...new Set([...path.matchAll(PATH_PLACEHOLDER)].map((m) => m[1] ?? ''))];
  return names.map((name) => ({
    name,
    in: 'path' as const,
    type: templateTypes.get(name) ?? 'string',
    required: true,
    repeating: false,
  }));
}

/** Parameter styles the generic tools cannot send: counted and reported, never silently lost. */
const IGNORED_STYLES: ReadonlySet<string> = new Set(['matrix', 'header', 'plain']);

interface WalkState {
  api: ApiFamily;
  out: ParsedOperation[];
  ignoredParams: number;
}

function walk(
  res: XmlResource,
  parentPath: string,
  parentTemplates: ReadonlyMap<string, ParamType>,
  state: WalkState,
): void {
  const { api, out } = state;
  const path = joinPath(parentPath, res.path);
  const templates = new Map(parentTemplates);
  for (const p of res.param ?? [])
    if (p.style === 'template') templates.set(p.name, mapType(p.type));
  const resourceQuery = (res.param ?? []).filter((p) => p.style === 'query');
  state.ignoredParams += (res.param ?? []).filter((p) => IGNORED_STYLES.has(p.style ?? '')).length;

  for (const m of res.method ?? []) {
    if (!METHODS.has(m.name)) continue;
    // A crafted WADL must not produce an operation that escapes /rest/ (traversal, encoded
    // separators, query or fragment injection): the build fails instead.
    const problem = restPathProblem(path);
    if (problem)
      throw new Error(
        `Unsafe operation path in the ${api} WADL: ${JSON.stringify(path)} — ${problem}`,
      );
    const request = m.request?.[0];
    const methodParams = request?.param ?? [];
    state.ignoredParams += methodParams.filter((p) => IGNORED_STYLES.has(p.style ?? '')).length;
    // A method-level parameter overrides the resource-level one of the same name (more specific).
    const query = new Map<string, OperationParam>();
    for (const p of [...resourceQuery, ...methodParams.filter((q) => q.style === 'query')])
      query.set(p.name, toQueryParam(p));
    const mediaTypes = [
      ...new Set(
        (request?.representation ?? [])
          .map((r) => (r.mediaType ? normalizeMediaType(r.mediaType) : ''))
          .filter(Boolean),
      ),
    ];
    out.push({
      id: `${m.name} ${path}`,
      api,
      method: m.name as HttpMethod,
      path,
      summary: docText(m.doc),
      body: { accepted: (request?.representation?.length ?? 0) > 0, mediaTypes },
      params: [...pathParams(path, templates), ...query.values()],
    });
  }
  for (const child of res.resource ?? []) walk(child, path, templates, state);
}

/**
 * Merges two declarations of the same method + path (sibling `<resource>` blocks): union of the
 * parameters (required or repeatable if either says so), body accepted if either accepts one,
 * union of media types; the first summary is kept.
 */
function mergeOperations(first: ParsedOperation, second: ParsedOperation): ParsedOperation {
  const params = new Map(first.params.map((p) => [`${p.in} ${p.name}`, p]));
  for (const p of second.params) {
    const key = `${p.in} ${p.name}`;
    const known = params.get(key);
    params.set(
      key,
      known
        ? {
            ...known,
            required: known.required || p.required,
            repeating: known.repeating || p.repeating,
          }
        : p,
    );
  }
  return {
    ...first,
    summary: first.summary || second.summary,
    body: {
      accepted: first.body.accepted || second.body.accepted,
      mediaTypes: [...new Set([...first.body.mediaTypes, ...second.body.mediaTypes])],
    },
    params: [...params.values()],
  };
}

function notAWadl(api: ApiFamily, why: string): Error {
  return new Error(
    `The ${api} WADL is not a usable WADL (${why}): a login, proxy or error page may have been fetched instead — check JIRA_BASE_URL and run npm run catalog:fetch again`,
  );
}

function parseRoot(xml: string, api: ApiFamily): XmlResources[] {
  if (!xml.trim()) throw notAWadl(api, 'empty file');
  let root: XmlRoot;
  try {
    root = parser.parse(xml) as XmlRoot;
  } catch {
    throw notAWadl(api, 'not well-formed XML');
  }
  const application = root.application;
  if (application === undefined) throw notAWadl(api, 'no <application> root element');
  const resources = typeof application === 'object' ? (application.resources ?? []) : [];
  if (!resources.some((r) => (r.resource ?? []).length > 0))
    throw notAWadl(api, 'no <resources> element with a <resource>');
  return resources;
}

/** The pathname of a `<resources base>`, or a clear error naming the source (never a bare "Invalid URL"). */
function basePathname(base: unknown, api: ApiFamily): string {
  if (typeof base === 'string' && URL.canParse(base))
    return new URL(base).pathname.replace(/\/+$/, '');
  // Not an absolute URL, so it carries no instance host: it can be shown.
  throw new Error(
    `The ${api} WADL has a <resources> element without an absolute base URL (base=${JSON.stringify(base ?? null)})`,
  );
}

/**
 * Operations declared by a WADL, sorted by id. Throws when the text is not a WADL (empty, HTML,
 * no `<application>` / `<resources>`), when a base is not an absolute URL, when a path escapes
 * /rest/, or when no operation is declared. Duplicates are merged and reported through `warn`.
 */
export function parseWadl(
  xml: string,
  api: ApiFamily,
  warn: (message: string) => void = (message) => console.error(message),
): ParsedOperation[] {
  const state: WalkState = { api, out: [], ignoredParams: 0 };
  for (const resources of parseRoot(xml, api)) {
    const pathname = basePathname(resources.base, api);
    // Under a context path (https://host/jira/rest/...), operation paths start at /rest/: the
    // client prepends JIRA_BASE_URL, which already carries the context path.
    const rest = `${pathname}/`.indexOf('/rest/');
    const base = rest === -1 ? pathname : pathname.slice(rest);
    for (const res of resources.resource ?? []) walk(res, base, new Map(), state);
  }
  if (state.out.length === 0) throw notAWadl(api, 'no operation declared');
  const byId = new Map<string, ParsedOperation>();
  let duplicates = 0;
  for (const op of state.out) {
    const known = byId.get(op.id);
    if (known) duplicates++;
    byId.set(op.id, known ? mergeOperations(known, op) : op);
  }
  if (duplicates > 0)
    warn(`⚠ ${api} WADL: ${duplicates} duplicate method + path declaration(s) merged`);
  if (state.ignoredParams > 0)
    warn(
      `⚠ ${api} WADL: ${state.ignoredParams} matrix / header parameter(s) ignored (the generic tools cannot send them)`,
    );
  return [...byId.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

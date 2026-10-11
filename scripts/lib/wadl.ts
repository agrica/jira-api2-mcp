import { XMLParser } from 'fast-xml-parser';
import { PATH_PLACEHOLDER } from '../../src/catalog/catalog.ts';
import type { HttpMethod } from '../../src/http/jira-client.ts';
import type {
  ApiFamily,
  OperationParam,
  ParamType,
  ParsedOperation,
} from '../../src/catalog/types.ts';

type XmlDoc = string | { '#text'?: string };
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
interface XmlRoot {
  application?: { resources?: { base: string; resource?: XmlResource[] }[] };
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

function mapType(xsType: string | undefined): ParamType {
  const t = (xsType ?? 'string').replace(/^xs:/, '');
  if (['int', 'long', 'short', 'integer', 'byte'].includes(t)) return 'integer';
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

function docText(docs: XmlDoc[] | undefined): string {
  const raw = (docs ?? []).map((d) => (typeof d === 'string' ? d : (d['#text'] ?? ''))).join(' ');
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
  return [...path.matchAll(PATH_PLACEHOLDER)].map((m) => {
    const name = m[1] ?? '';
    return {
      name,
      in: 'path' as const,
      type: templateTypes.get(name) ?? 'string',
      required: true,
      repeating: false,
    };
  });
}

function walk(
  res: XmlResource,
  parentPath: string,
  parentTemplates: ReadonlyMap<string, ParamType>,
  api: ApiFamily,
  out: ParsedOperation[],
): void {
  const path = joinPath(parentPath, res.path);
  const templates = new Map(parentTemplates);
  for (const p of res.param ?? [])
    if (p.style === 'template') templates.set(p.name, mapType(p.type));
  const resourceQuery = (res.param ?? []).filter((p) => p.style === 'query').map(toQueryParam);

  for (const m of res.method ?? []) {
    if (!METHODS.has(m.name)) continue;
    const request = m.request?.[0];
    const query = [
      ...resourceQuery,
      ...(request?.param ?? []).filter((p) => p.style === 'query').map(toQueryParam),
    ];
    const unique = query.filter((p, i) => query.findIndex((q) => q.name === p.name) === i);
    const mediaTypes = [
      ...new Set(
        (request?.representation ?? [])
          .map((r) => r.mediaType)
          .filter((t): t is string => Boolean(t)),
      ),
    ];
    out.push({
      id: `${m.name} ${path}`,
      api,
      method: m.name as HttpMethod,
      path,
      summary: docText(m.doc),
      body: { accepted: (request?.representation?.length ?? 0) > 0, mediaTypes },
      params: [...pathParams(path, templates), ...unique],
    });
  }
  for (const child of res.resource ?? []) walk(child, path, templates, api, out);
}

export function parseWadl(xml: string, api: ApiFamily): ParsedOperation[] {
  const root = parser.parse(xml) as XmlRoot;
  const out: ParsedOperation[] = [];
  for (const resources of root.application?.resources ?? []) {
    const pathname = new URL(resources.base).pathname.replace(/\/+$/, '');
    // Under a context path (https://host/jira/rest/...), operation paths start at /rest/: the
    // client prepends JIRA_BASE_URL, which already carries the context path.
    const rest = `${pathname}/`.indexOf('/rest/');
    const base = rest === -1 ? pathname : pathname.slice(rest);
    for (const res of resources.resource ?? []) walk(res, base, new Map(), api, out);
  }
  const seen = new Set<string>();
  return out
    .filter((op) => (seen.has(op.id) ? false : (seen.add(op.id), true)))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

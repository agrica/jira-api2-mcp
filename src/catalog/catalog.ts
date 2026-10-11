import type {
  Access,
  HttpMethod,
  JiraRequest,
  QueryScalar,
  QueryValue,
} from '../http/jira-client.ts';
import { normalizeForSearch } from '../util/normalize.ts';
import {
  API_FAMILIES,
  type ApiFamily,
  type CatalogMeta,
  type Operation,
  type OperationParam,
} from './types.ts';

export interface SearchOptions {
  query?: string;
  api?: ApiFamily;
  method?: HttpMethod;
  access?: Access;
  limit?: number;
}

export interface CallArguments {
  pathParams?: Readonly<Record<string, string | number>>;
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
}

/**
 * A path placeholder of a catalog operation, e.g. `{issueIdOrKey}`, `{issue-key}` or `{a.b}`.
 * Shared with the WADL parser so that extracted parameter names are exactly the ones substituted here.
 */
export const PATH_PLACEHOLDER = /\{([\w.-]+)\}/g;

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

function checkType(op: Operation, p: OperationParam, value: QueryScalar): void {
  const text = String(value).trim();
  const ok =
    p.type === 'integer'
      ? /^-?\d+$/.test(text)
      : p.type === 'number'
        ? text !== '' && Number.isFinite(Number(text))
        : p.type === 'boolean'
          ? text === 'true' || text === 'false'
          : true;
  if (!ok)
    throw new CatalogError(
      `Parameter "${p.name}" of ${op.id} expects ${p.type}, got ${JSON.stringify(value)}`,
    );
}

function encodePathParam(
  op: Operation,
  p: OperationParam,
  value: string | number | undefined,
): string {
  if (value === undefined)
    throw new CatalogError(`Missing path parameter "${p.name}" for ${op.id}`);
  const text = String(value);
  if (text === '' || text === '.' || text === '..') {
    throw new CatalogError(`Invalid value for path parameter "${p.name}": "${text}"`);
  }
  checkType(op, p, value);
  return encodeURIComponent(text);
}

export function describeOperation(op: Operation): Operation & { notes: string[] } {
  return {
    ...op,
    notes: [
      op.body.accepted
        ? `Accepts a request body (${op.body.mediaTypes.join(', ') || 'media type not declared'}). The WADL does not say whether the body is required and gives no schema: Jira validates its content.`
        : 'Takes no request body.',
      'Path and query parameters are checked against the WADL (declared names, types, repeatable, required when declared). The WADL may omit parameters or required flags; Jira performs the remaining checks.',
      `Access class: ${op.access} (${op.accessReason}).`,
    ],
  };
}

/** Families that stay off unless their environment variable is true. The others are always on. */
export const FAMILY_SWITCHES: Readonly<Partial<Record<ApiFamily, string>>> = {
  xray: 'JIRA_ENABLE_XRAY',
};

/** Families exposed by the server, from the state of each switch (e.g. `{ xray: true }`). */
export function enabledFamilies(
  switches: Readonly<Partial<Record<ApiFamily, boolean>>>,
): ApiFamily[] {
  return API_FAMILIES.filter(
    (family) => FAMILY_SWITCHES[family] === undefined || switches[family] === true,
  );
}

export class Catalog {
  readonly meta: CatalogMeta | undefined;
  /** Enabled families, in canonical order; never empty. */
  readonly families: readonly ApiFamily[];
  /** Enabled families that have at least one operation in this catalog. */
  readonly availableFamilies: readonly ApiFamily[];
  readonly #operations: readonly Operation[];
  readonly #byId: ReadonlyMap<string, Operation>;
  readonly #haystacks: ReadonlyMap<string, string>;

  constructor(
    allOperations: readonly Operation[],
    meta?: CatalogMeta,
    families: readonly ApiFamily[] = API_FAMILIES,
  ) {
    this.families = API_FAMILIES.filter((family) => families.includes(family));
    if (this.families.length === 0)
      throw new CatalogError('At least one API family must be enabled.');
    this.meta = meta;
    this.#byId = new Map(allOperations.map((op) => [op.id, op]));
    this.#operations = allOperations.filter((op) => this.families.includes(op.api));
    this.availableFamilies = this.families.filter((family) =>
      this.#operations.some((op) => op.api === family),
    );
    this.#haystacks = new Map(
      this.#operations.map((op) => [op.id, normalizeForSearch(`${op.id} ${op.summary}`)]),
    );
  }

  get size(): number {
    return this.#operations.length;
  }

  /** The operation, if it exists and its family is enabled. */
  get(id: string): Operation | undefined {
    const op = this.#byId.get(id.trim());
    return op && this.families.includes(op.api) ? op : undefined;
  }

  require(id: string): Operation {
    const op = this.#byId.get(id.trim());
    if (!op)
      throw new CatalogError(
        `Unknown operation "${id}". Use jira_list_operations to find a valid operationId.`,
      );
    if (!this.families.includes(op.api)) {
      const variable = FAMILY_SWITCHES[op.api];
      throw new CatalogError(
        `Operation "${op.id}" belongs to the ${op.api} API family, which is disabled on this server` +
          (variable ? ` (enable it with ${variable}=true).` : '.'),
      );
    }
    return op;
  }

  search(options: SearchOptions = {}): { total: number; operations: Operation[] } {
    const terms = normalizeForSearch(options.query ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const matches = this.#operations.filter(
      (op) =>
        (!options.api || op.api === options.api) &&
        (!options.method || op.method === options.method) &&
        (!options.access || op.access === options.access) &&
        terms.every((term) => this.#haystacks.get(op.id)?.includes(term)),
    );
    matches.sort(
      (a, b) => a.path.length - b.path.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return { total: matches.length, operations: matches.slice(0, limit) };
  }

  buildRequest(op: Operation, args: CallArguments = {}): JiraRequest {
    const pathParams = args.pathParams ?? {};
    const declaredPath = op.params.filter((p) => p.in === 'path');
    const unknownPath = Object.keys(pathParams).filter(
      (k) => !declaredPath.some((p) => p.name === k),
    );
    if (unknownPath.length > 0) {
      throw new CatalogError(
        `Unknown path parameter(s) for ${op.id}: ${unknownPath.join(', ')}. Expected: ${declaredPath.map((p) => p.name).join(', ') || 'none'}`,
      );
    }
    const path = op.path.replace(PATH_PLACEHOLDER, (_match, name: string) => {
      const param: OperationParam = declaredPath.find((p) => p.name === name) ?? {
        name,
        in: 'path',
        type: 'string',
        required: true,
        repeating: false,
      };
      return encodePathParam(op, param, pathParams[name]);
    });

    const query = args.query ?? {};
    const declaredQuery = op.params.filter((p) => p.in === 'query');
    const unknownQuery = Object.keys(query).filter((k) => !declaredQuery.some((p) => p.name === k));
    if (unknownQuery.length > 0) {
      throw new CatalogError(
        `Unknown query parameter(s) for ${op.id}: ${unknownQuery.join(', ')}. Allowed: ${declaredQuery.map((p) => p.name).join(', ') || 'none'}`,
      );
    }
    for (const p of declaredQuery) {
      const value = query[p.name];
      if (value === undefined) continue;
      if (typeof value === 'object' && !p.repeating) {
        throw new CatalogError(
          `Parameter "${p.name}" of ${op.id} is not repeatable: pass a single value (Jira often expects a comma-separated list).`,
        );
      }
      for (const v of typeof value === 'object' ? value : [value]) checkType(op, p, v);
    }
    const missing = declaredQuery
      .filter((p) => p.required && query[p.name] === undefined)
      .map((p) => p.name);
    if (missing.length > 0) {
      throw new CatalogError(
        `Missing required query parameter(s) for ${op.id}: ${missing.join(', ')}`,
      );
    }

    if (args.body !== undefined) {
      if (!op.body.accepted) throw new CatalogError(`${op.id} does not accept a request body`);
      // fetch throws a TypeError for a GET/HEAD body: refuse it here, before any (retried) call.
      if (op.method === 'GET' || op.method === 'HEAD') {
        throw new CatalogError(
          `${op.id}: a ${op.method} request cannot carry a body. Pass the values as query parameters.`,
        );
      }
      const types = op.body.mediaTypes;
      if (types.length > 0 && !types.some((t) => t.includes('json'))) {
        throw new CatalogError(
          `${op.id} expects ${types.join(', ')}, which the generic tool cannot send. Use a dedicated tool (e.g. jira_add_attachment).`,
        );
      }
    }
    return { method: op.method, path, access: op.access, query, body: args.body };
  }
}

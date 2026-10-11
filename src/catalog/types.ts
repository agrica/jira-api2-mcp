import type { Access, HttpMethod } from '../http/jira-client.ts';

export type ApiFamily = 'api' | 'agile' | 'xray';
export type ParamType = 'string' | 'integer' | 'number' | 'boolean';

export interface OperationParam {
  name: string;
  in: 'path' | 'query';
  type: ParamType;
  /** As declared by the WADL. Jersey rarely declares it: absence does not mean optional for Jira. */
  required: boolean;
  repeating: boolean;
  default?: string;
  description?: string;
}

/** The WADL only lists accepted media types: it never says whether a body is required, nor its schema. */
export interface OperationBody {
  accepted: boolean;
  mediaTypes: string[];
}

export interface ParsedOperation {
  /** `"<METHOD> <path>"`, unique within the catalog. */
  id: string;
  api: ApiFamily;
  method: HttpMethod;
  path: string;
  summary: string;
  body: OperationBody;
  params: OperationParam[];
}

export interface Operation extends ParsedOperation {
  access: Access;
  /** Where the class comes from: a default rule (possibly "not individually reviewed") or a signed review decision. */
  accessReason: string;
}

export interface CatalogMeta {
  jiraVersion: string;
  jiraBuildNumber: number;
  fetchedAt: string;
  generatedAt: string;
  counts: Record<ApiFamily, number>;
}

export interface CatalogFile {
  meta: CatalogMeta;
  operations: Operation[];
}

export interface AccessDecision {
  access: Access;
  reason: string;
  /** Git identity of the reviewer. */
  reviewedBy: string;
  /** YYYY-MM-DD */
  reviewedOn: string;
}

export type AccessDecisions = Readonly<Record<string, AccessDecision>>;

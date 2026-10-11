import type { Access } from '../../src/http/jira-client.ts';
import { accessProblem } from '../../src/http/request-guards.ts';
import type { AccessDecisions, Operation, ParsedOperation } from '../../src/catalog/types.ts';

export type ReviewCategory = 'get-side-effect' | 'post-read-like' | 'write-destructive-like';

export interface ReviewCandidate {
  id: string;
  category: ReviewCategory;
  /** The path fragment that triggered the heuristic (a hint, never a proof). */
  matched: string;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Path heuristics that select operations for HUMAN review. They detect nothing and never reclassify:
 * an operation without a matching word is not proven safe, and a matching word proves nothing.
 */
export const REVIEW_HEURISTICS: readonly {
  category: ReviewCategory;
  methods: ReadonlySet<string>;
  pattern: RegExp;
}[] = [
  {
    category: 'get-side-effect',
    methods: SAFE_METHODS,
    pattern:
      /(reindex|run|execute|trigger|start|stop|restart|cancel|abort|clear|reset|purge|delete|remove|rebuild|sync|refresh|generate|logout|lock|unlock|approve|reject|send|notify|import|upgrade|migrate|enable|disable|activate|deactivate)/i,
  },
  {
    category: 'post-read-like',
    methods: new Set(['POST']),
    pattern: /(search|query|picker|find|export|validate|check|preview|count)/i,
  },
  {
    category: 'write-destructive-like',
    methods: new Set(['POST', 'PUT', 'PATCH']),
    pattern:
      /(delete|remove|purge|clear|reset|truncate|archive|bulk|mass|merge|move|restore|rollback|revoke|disable|deactivate|destroy|drop|cleanup|wipe|reindex)/i,
  },
];

function defaultAccess(op: ParsedOperation): { access: Access; accessReason: string } {
  if (SAFE_METHODS.has(op.method)) {
    return {
      access: 'read',
      accessReason: 'default rule: safe HTTP method (not individually reviewed)',
    };
  }
  if (op.method === 'DELETE')
    return { access: 'destructive', accessReason: 'default rule: DELETE method' };
  return { access: 'write', accessReason: 'default rule: unsafe HTTP method' };
}

const ACCESS_CLASSES: readonly Access[] = ['read', 'write', 'destructive'];
const DECISION_FIELDS: ReadonlySet<string> = new Set([
  'access',
  'reason',
  'reviewedBy',
  'reviewedOn',
]);
const DAY_MS = 86_400_000;
const DECISION_ID = /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \/rest\//;

/** Values that stand for "to be filled in": `<…>`, TODO, TBD, FIXME, ?, x, xxx, n/a, none, unknown. */
const PLACEHOLDER = /^(?:<[^>]*>|(?:todo|tbd|fixme)(?:\b.*)?|\?+|x+|n\/?a|none|unknown|-+|\.+)$/i;

export const PLACEHOLDER_REVIEWER_HINT =
  'replace the placeholder reviewer in catalog/access-decisions.json after reviewing the decision';

function textProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return 'is required';
  return PLACEHOLDER.test(value.trim()) ? `is a placeholder (${JSON.stringify(value)})` : undefined;
}

/** A real calendar date YYYY-MM-DD, not after tomorrow (UTC): one day of margin for time zones. */
function dateProblem(value: unknown, now: Date): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return 'must be a YYYY-MM-DD date';
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return `is not a calendar date (${value})`;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return date.getTime() > today + DAY_MS ? `is in the future (${value})` : undefined;
}

function decisionFieldProblems(id: string, raw: unknown, now: Date): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return ['must be an object with access, reason, reviewedBy and reviewedOn'];
  if (!DECISION_ID.test(id))
    return [
      'the id must be "<METHOD> /rest/…" with METHOD one of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
    ];
  const d = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(d))
    if (!DECISION_FIELDS.has(key)) problems.push(`unknown field "${key}"`);
  if (typeof d.access !== 'string' || !(ACCESS_CLASSES as readonly string[]).includes(d.access)) {
    problems.push(
      `"access" must be exactly read, write or destructive (got ${JSON.stringify(d.access ?? null)})`,
    );
  } else {
    const problem = accessProblem(id.split(' ')[0] ?? '', d.access);
    if (problem) problems.push(problem);
  }
  const reason = textProblem(d.reason);
  if (reason) problems.push(`"reason" ${reason}: explain the decision`);
  const reviewer = textProblem(d.reviewedBy);
  if (reviewer === 'is required')
    problems.push('"reviewedBy" is required: name the reviewer (git identity)');
  else if (reviewer) problems.push(`"reviewedBy" ${reviewer}: ${PLACEHOLDER_REVIEWER_HINT}`);
  const date = dateProblem(d.reviewedOn, now);
  if (date) problems.push(`"reviewedOn" ${date}`);
  return problems;
}

/**
 * Every problem of the decisions file, one line each naming the decision (stale decisions included).
 * The access class is checked against the method of the id, as the server checks it at load.
 */
export function decisionProblems(decisions: unknown, now: Date = new Date()): string[] {
  if (typeof decisions !== 'object' || decisions === null || Array.isArray(decisions))
    return ['catalog/access-decisions.json must be a JSON object keyed by operation id'];
  return Object.entries(decisions).flatMap(([id, raw]) =>
    decisionFieldProblems(id, raw, now).map((p) => `Access decision for ${id}: ${p}`),
  );
}

export function classifyOperations(
  parsed: readonly ParsedOperation[],
  decisions: AccessDecisions,
  now: Date = new Date(),
): {
  operations: Operation[];
  staleDecisions: string[];
  candidates: ReviewCandidate[];
  pending: ReviewCandidate[];
} {
  const problems = decisionProblems(decisions, now);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const ids = new Set(parsed.map((op) => op.id));
  const candidates: ReviewCandidate[] = [];
  const operations = parsed.map((op): Operation => {
    for (const h of REVIEW_HEURISTICS) {
      const match = h.methods.has(op.method) ? h.pattern.exec(op.path) : null;
      if (match) candidates.push({ id: op.id, category: h.category, matched: match[0] });
    }
    const d = decisions[op.id];
    if (!d) return { ...op, ...defaultAccess(op) };
    return {
      ...op,
      access: d.access,
      accessReason: `reviewed: ${d.reason.trim()} (${d.reviewedBy.trim()}, ${d.reviewedOn})`,
    };
  });
  return {
    operations,
    staleDecisions: Object.keys(decisions)
      .filter((id) => !ids.has(id))
      .toSorted(),
    candidates,
    pending: candidates.filter((c) => !decisions[c.id]),
  };
}

import type { Access } from '../../src/http/jira-client.ts';
import type {
  AccessDecision,
  AccessDecisions,
  Operation,
  ParsedOperation,
} from '../../src/catalog/types.ts';

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

function validateDecision(op: ParsedOperation, d: AccessDecision): void {
  if (!d.reason.trim()) throw new Error(`Access decision for ${op.id}: "reason" is required`);
  if (!d.reviewedBy.trim() || d.reviewedBy.trim().startsWith('<')) {
    throw new Error(
      `Access decision for ${op.id}: "reviewedBy" must name the reviewer (git identity)`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.reviewedOn)) {
    throw new Error(`Access decision for ${op.id}: "reviewedOn" must be a YYYY-MM-DD date`);
  }
  if (op.method === 'DELETE' && d.access === 'read') {
    throw new Error(`${op.id}: DELETE operations cannot be classified as read`);
  }
}

export function classifyOperations(
  parsed: readonly ParsedOperation[],
  decisions: AccessDecisions,
): {
  operations: Operation[];
  staleDecisions: string[];
  candidates: ReviewCandidate[];
  pending: ReviewCandidate[];
} {
  const ids = new Set(parsed.map((op) => op.id));
  const candidates: ReviewCandidate[] = [];
  const operations = parsed.map((op): Operation => {
    for (const h of REVIEW_HEURISTICS) {
      const match = h.methods.has(op.method) ? h.pattern.exec(op.path) : null;
      if (match) candidates.push({ id: op.id, category: h.category, matched: match[0] });
    }
    const d = decisions[op.id];
    if (!d) return { ...op, ...defaultAccess(op) };
    validateDecision(op, d);
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

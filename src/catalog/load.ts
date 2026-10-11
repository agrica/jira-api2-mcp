import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { API_FAMILIES, type CatalogFile } from './types.ts';

/** `src/catalog/load.ts` and `dist/catalog/load.js` both resolve to `<root>/catalog/catalog.json`. */
export const DEFAULT_CATALOG_PATH = fileURLToPath(
  new URL('../../catalog/catalog.json', import.meta.url),
);

const paramSchema = z.object({
  name: z.string().min(1),
  in: z.enum(['path', 'query']),
  type: z.enum(['string', 'integer', 'number', 'boolean']),
  required: z.boolean(),
  repeating: z.boolean(),
  default: z.string().optional(),
  description: z.string().optional(),
});

const operationSchema = z.object({
  id: z.string().min(1),
  api: z.enum(API_FAMILIES),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']),
  path: z.string().startsWith('/rest/'),
  summary: z.string(),
  body: z.object({ accepted: z.boolean(), mediaTypes: z.array(z.string()) }),
  params: z.array(paramSchema),
  access: z.enum(['read', 'write', 'destructive']),
  accessReason: z.string().min(1),
});

const catalogSchema = z.object({
  meta: z.object({
    jiraVersion: z.string().min(1),
    jiraBuildNumber: z.number().int(),
    fetchedAt: z.string().min(1),
    generatedAt: z.string().min(1),
    counts: z.object({ api: z.number().int(), agile: z.number().int(), xray: z.number().int() }),
  }),
  operations: z.array(operationSchema),
});

export async function loadCatalogFile(path: string = DEFAULT_CATALOG_PATH): Promise<CatalogFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Operation catalog not found at ${path}. It is not stored in git: run "npm run catalog:fetch" then "npm run catalog:build", or install a packaged build (README › Installation).`,
        { cause: error },
      );
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Operation catalog at ${path} is not valid JSON`);
  }
  const result = catalogSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Operation catalog at ${path} is invalid: ${issues}`);
  }
  return result.data;
}

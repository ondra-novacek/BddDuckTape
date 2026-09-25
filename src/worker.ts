import { polishScenarioField, type AiField, type GeminiConfig, type PolishInput } from './server/ai/client';
import { createHttpError } from './server/errors';
import { groupStickyNotes } from './server/miro/group';
import { fetchStickyNotesFromMiro } from './server/miro/client';
import { createXrayTestsInTestSet, XrayApiError } from './server/xray/client';
import { extractIssueKey } from './server/xray/issueKey';
import type { CreateXrayTestsInput, CreateXrayTestsResult, XrayConfig } from './server/xray/types';

export interface WorkerEnv {
  MIRO_ACCESS_TOKEN?: string;
  XRAY_CLIENT_ID?: string;
  XRAY_CLIENT_SECRET?: string;
  XRAY_BASE_URL?: string;
  JIRA_BASE_URL?: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
  GEMINI_API_KEY?: string;
}

type StickyNotesFetcher = typeof fetchStickyNotesFromMiro;
type XrayExporter = (config: XrayConfig, input: CreateXrayTestsInput) => Promise<CreateXrayTestsResult>;
type AiPolisher = (config: GeminiConfig, input: PolishInput) => Promise<string>;

export interface WorkerDependencies {
  fetchStickyNotes?: StickyNotesFetcher;
  exportXrayTests?: XrayExporter;
  polishScenario?: AiPolisher;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function isScenario(value: unknown): value is CreateXrayTestsInput['scenarios'][number] {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { sourceId?: unknown }).sourceId === 'string' &&
    (value as { sourceId: string }).sourceId.trim().length > 0 &&
    typeof (value as { summary?: unknown }).summary === 'string' &&
    (value as { summary: string }).summary.trim().length > 0 &&
    typeof (value as { gherkin?: unknown }).gherkin === 'string' &&
    (value as { gherkin: string }).gherkin.trim().length > 0
  );
}

function isField(value: unknown): value is AiField {
  return value === 'summary' || value === 'gherkin';
}

async function requestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw createHttpError(400, 'Provide a valid JSON request body.');
  }
}

export function createWorkerHandler(env: WorkerEnv, dependencies: WorkerDependencies = {}) {
  const fetchStickyNotes = dependencies.fetchStickyNotes ?? fetchStickyNotesFromMiro;
  const exportXrayTests = dependencies.exportXrayTests ?? createXrayTestsInTestSet;
  const polishScenario = dependencies.polishScenario ?? polishScenarioField;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/miro/sticky-notes') {
      const boardId = url.searchParams.get('boardId')?.trim();
      if (!boardId) {
        return json({ error: 'Provide a board ID in the request.' }, 400);
      }
      if (!env.MIRO_ACCESS_TOKEN) {
        return json(
          { error: 'Set MIRO_ACCESS_TOKEN in .env before fetching Miro data.' },
          500
        );
      }
      try {
        const notes = await fetchStickyNotes({ boardId, accessToken: env.MIRO_ACCESS_TOKEN });
        const groups = groupStickyNotes(notes);
        return json({ boardId, count: notes.length, groupCount: groups.length, notes, groups });
      } catch (error) {
        const status = typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status
          : 502;
        return json({ error: error instanceof Error ? error.message : 'Miro request failed' }, status);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/xray/tests') {
      if (!env.XRAY_CLIENT_ID || !env.XRAY_CLIENT_SECRET) {
        return json(
          { error: 'Set XRAY_CLIENT_ID and XRAY_CLIENT_SECRET in .env before exporting to Xray.' },
          500
        );
      }
      let body: { testSetKey?: unknown; scenarios?: unknown };
      try {
        body = (await requestJson(request)) as typeof body;
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Provide a valid JSON request body.' }, 400);
      }
      const testSetKey = typeof body.testSetKey === 'string' ? extractIssueKey(body.testSetKey) : null;
      if (!testSetKey) {
        return json({ error: 'Provide a Jira issue key or Jira issue URL for the Xray Test Set.' }, 400);
      }
      if (!Array.isArray(body.scenarios) || body.scenarios.length === 0 || !body.scenarios.every(isScenario)) {
        return json({ error: 'Each scenario needs a sourceId, summary, and gherkin body.' }, 400);
      }
      try {
        const result = await exportXrayTests(
          {
            clientId: env.XRAY_CLIENT_ID,
            clientSecret: env.XRAY_CLIENT_SECRET,
            baseUrl: env.XRAY_BASE_URL ?? 'https://xray.cloud.getxray.app',
            jiraBaseUrl: env.JIRA_BASE_URL,
            jiraEmail: env.JIRA_EMAIL,
            jiraApiToken: env.JIRA_API_TOKEN
          },
          {
            testSetKey,
            scenarios: body.scenarios.map((scenario) => ({
              sourceId: scenario.sourceId.trim(),
              summary: scenario.summary.trim(),
              gherkin: scenario.gherkin.trim()
            }))
          }
        );
        const jiraBaseUrl = env.JIRA_BASE_URL?.replace(/\/$/, '');
        const jiraIssueUrl = (issueKey: string) => jiraBaseUrl ? `${jiraBaseUrl}/browse/${issueKey}` : undefined;
        return json({
          ...result,
          testSet: { key: testSetKey, url: jiraIssueUrl(testSetKey) },
          created: result.created.map((test) => ({ ...test, url: jiraIssueUrl(test.key) }))
        });
      } catch (error) {
        if (error instanceof XrayApiError) {
          return json(
            { error: error.message, scenarioIndex: error.scenarioIndex, created: error.created },
            error.status
          );
        }
        return json({ error: error instanceof Error ? error.message : 'Xray export failed.' }, 502);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/ai/polish') {
      if (!env.GEMINI_API_KEY) {
        return json({ error: 'Set GEMINI_API_KEY in .env before using AI suggestions.' }, 500);
      }
      let body: { field?: unknown; summary?: unknown; gherkin?: unknown };
      try {
        body = (await requestJson(request)) as typeof body;
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Provide a valid JSON request body.' }, 400);
      }
      if (!isField(body.field) || typeof body.summary !== 'string' || typeof body.gherkin !== 'string') {
        return json({ error: 'Provide a field, summary, and Gherkin text for an AI suggestion.' }, 400);
      }
      if (body.field === 'summary' && !body.summary.trim() && !body.gherkin.trim()) {
        return json({ error: 'Add Gherkin before asking AI to create a summary.' }, 400);
      }
      if (body.field === 'gherkin' && !body.gherkin.trim()) {
        return json({ error: 'Add Gherkin before asking AI to polish it.' }, 400);
      }
      try {
        const proposal = await polishScenario(
          { apiKey: env.GEMINI_API_KEY, model: 'gemini-3.5-flash-lite' },
          { field: body.field, summary: body.summary, gherkin: body.gherkin }
        );
        return json({ proposal });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Gemini could not create a suggestion.' }, 502);
      }
    }

    return json({ error: 'Not found.' }, 404);
  };
}

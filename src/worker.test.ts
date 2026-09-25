import { describe, expect, it, vi } from 'vitest';
import { createWorkerHandler } from './worker';

describe('Worker API handler', () => {
  it('returns the health contract without configuration', async () => {
    const handler = createWorkerHandler({});

    const response = await handler(new Request('https://app.example/api/health'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('returns the Miro validation error for a missing board ID', async () => {
    const handler = createWorkerHandler({ MIRO_ACCESS_TOKEN: 'token' });

    const response = await handler(new Request('https://app.example/api/miro/sticky-notes'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Provide a board ID in the request.'
    });
  });

  it('returns Miro data through the same Worker route contract', async () => {
    const fetchStickyNotes = vi.fn().mockResolvedValue([
      {
        id: 'note-1',
        content: '<p>Scenario</p>',
        plainText: 'Scenario',
        fillColor: 'blue',
        position: { x: 1, y: 2 }
      }
    ]);
    const handler = createWorkerHandler({ MIRO_ACCESS_TOKEN: 'token' }, { fetchStickyNotes });

    const response = await handler(
      new Request('https://app.example/api/miro/sticky-notes?boardId=board-123')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      boardId: 'board-123',
      count: 1,
      groupCount: 1
    });
  });

  it('returns the Xray credential error before calling an upstream service', async () => {
    const handler = createWorkerHandler({});

    const response = await handler(
      new Request('https://app.example/api/xray/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testSetKey: 'LW1-28042',
          scenarios: [{ sourceId: 'note-1', summary: 'Summary', gherkin: 'Scenario: test' }]
        })
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Set XRAY_CLIENT_ID and XRAY_CLIENT_SECRET in .env before exporting to Xray.'
    });
  });

  it('passes optional Jira fallback bindings to the Xray exporter', async () => {
    const exportXrayTests = vi.fn().mockResolvedValue({ created: [], warnings: [] });
    const handler = createWorkerHandler(
      {
        XRAY_CLIENT_ID: 'client-id',
        XRAY_CLIENT_SECRET: 'client-secret',
        XRAY_BASE_URL: 'https://xray.example',
        JIRA_BASE_URL: 'https://jira.example',
        JIRA_EMAIL: 'bot@example.com',
        JIRA_API_TOKEN: 'jira-token'
      },
      { exportXrayTests }
    );

    await handler(
      new Request('https://app.example/api/xray/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testSetKey: 'LW1-28042',
          scenarios: [{ sourceId: 'note-1', summary: 'Summary', gherkin: 'Scenario: test' }]
        })
      })
    );

    expect(exportXrayTests).toHaveBeenCalledWith(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        baseUrl: 'https://xray.example',
        jiraBaseUrl: 'https://jira.example',
        jiraEmail: 'bot@example.com',
        jiraApiToken: 'jira-token'
      },
      {
        testSetKey: 'LW1-28042',
        scenarios: [{ sourceId: 'note-1', summary: 'Summary', gherkin: 'Scenario: test' }]
      }
    );
  });

  it('returns an AI proposal from the Worker route', async () => {
    const polishScenario = vi.fn().mockResolvedValue('Successful customer login');
    const handler = createWorkerHandler({ GEMINI_API_KEY: 'gemini-key' }, { polishScenario });

    const response = await handler(
      new Request('https://app.example/api/ai/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field: 'summary',
          summary: '',
          gherkin: 'Scenario: customer logs in\nGiven a registered customer'
        })
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ proposal: 'Successful customer login' });
  });
});

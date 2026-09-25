import type {
  CreatedXrayTest,
  CreateXrayTestsInput,
  CreateXrayTestsResult,
  XrayConfig,
  XrayScenarioInput,
} from "./types";
import { getProjectKeyFromIssueKey } from "./issueKey";

export class XrayApiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly scenarioIndex?: number,
    readonly created: CreatedXrayTest[] = [],
  ) {
    super(message);
  }
}

const createTestMutation = `
mutation CreateTest($testType: UpdateTestTypeInput!, $gherkin: String!, $jira: JSON!) {
  createTest(testType: $testType, gherkin: $gherkin, jira: $jira) {
    test {
      issueId
      jira(fields: ["key"])
    }
    warnings
  }
}`;

const addTestsToTestSetMutation = `
mutation AddTestsToTestSet($issueId: String!, $testIssueIds: [String]!) {
  addTestsToTestSet(issueId: $issueId, testIssueIds: $testIssueIds) {
    addedTests
    warning
  }
}`;

const getTestSetQuery = `
query GetTestSet($jql: String!) {
  getTestSets(jql: $jql, limit: 1) {
    results {
      issueId
      jira(fields: ["key"])
    }
  }
}`;

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function encodeBasicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function authenticate(
  config: XrayConfig,
  fetcher: typeof fetch,
): Promise<string> {
  const response = await fetcher(`${config.baseUrl}/api/v2/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  const body = await readJsonResponse(response);

  if (!response.ok || typeof body !== "string") {
    throw new XrayApiError(
      "Xray authentication failed.",
      response.status || 502,
    );
  }

  return body;
}

async function graphql(
  config: XrayConfig,
  token: string,
  query: string,
  variables: unknown,
  fetcher: typeof fetch,
) {
  const response = await fetcher(`${config.baseUrl}/api/v2/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new XrayApiError(
      "Xray GraphQL request failed.",
      response.status || 502,
    );
  }

  if (
    body &&
    typeof body === "object" &&
    "errors" in body &&
    Array.isArray((body as { errors: unknown }).errors) &&
    (body as { errors: unknown[] }).errors.length > 0
  ) {
    throw new XrayApiError("Xray GraphQL returned errors.");
  }

  return body;
}

function createTestVariables(projectKey: string, scenario: XrayScenarioInput) {
  return {
    testType: { name: "Cucumber" },
    gherkin: scenario.gherkin,
    jira: {
      fields: {
        project: { key: projectKey },
        summary: scenario.summary,
      },
    },
  };
}

async function resolveTestSetIssueId(
  config: XrayConfig,
  token: string,
  testSetKey: string,
  fetcher: typeof fetch,
): Promise<string> {
  const body = (await graphql(
    config,
    token,
    getTestSetQuery,
    { jql: `key = '${testSetKey}'` },
    fetcher,
  )) as {
    data?: {
      getTestSets?: {
        results?: Array<{ issueId?: unknown; jira?: { key?: unknown } }>;
      };
    };
  };

  const testSet = body.data?.getTestSets?.results?.[0];
  if (typeof testSet?.issueId === "string") {
    return testSet.issueId;
  }

  const jiraIssue = await resolveJiraIssue(config, testSetKey, fetcher);
  if (!jiraIssue) {
    throw new XrayApiError(`Xray Test Set ${testSetKey} was not found.`, 404);
  }

  if (jiraIssue.issueTypeName !== "Test Set") {
    throw new XrayApiError(
      `Jira issue ${testSetKey} exists as ${jiraIssue.id}, but is not an Xray Test Set.`,
      404,
    );
  }

  return jiraIssue.id;
}

async function resolveJiraIssue(
  config: XrayConfig,
  testSetKey: string,
  fetcher: typeof fetch,
): Promise<{ id: string; issueTypeName: string | null } | null> {
  if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) {
    return null;
  }

  const response = await fetcher(
    `${config.jiraBaseUrl.replace(/\/$/, "")}/rest/api/3/issue/${testSetKey}?fields=issuetype`,
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${encodeBasicAuth(config.jiraEmail, config.jiraApiToken)}`,
        Accept: "application/json",
      },
    },
  );
  const body = (await readJsonResponse(response)) as {
    id?: unknown;
    fields?: { issuetype?: { name?: unknown } };
  } | null;

  if (!response.ok || typeof body?.id !== "string") {
    return null;
  }

  return {
    id: body.id,
    issueTypeName:
      typeof body.fields?.issuetype?.name === "string"
        ? body.fields.issuetype.name
        : null,
  };
}

export async function createXrayTestsInTestSet(
  config: XrayConfig,
  input: CreateXrayTestsInput,
  fetcher: typeof fetch = fetch,
): Promise<CreateXrayTestsResult> {
  const token = await authenticate(config, fetcher);
  const testSetIssueId = await resolveTestSetIssueId(
    config,
    token,
    input.testSetKey,
    fetcher,
  );
  const projectKey = getProjectKeyFromIssueKey(input.testSetKey);
  const created: CreatedXrayTest[] = [];
  const warnings: string[] = [];

  for (const [index, scenario] of input.scenarios.entries()) {
    try {
      // Temporary diagnostic: remove after validating exported Gherkin.
      console.log(`${projectKey}-X${index + 1}`, JSON.stringify({ gherkin: scenario.gherkin }));
      const body = (await graphql(
        config,
        token,
        createTestMutation,
        createTestVariables(projectKey, scenario),
        fetcher,
      )) as {
        data?: {
          createTest?: {
            test?: { issueId?: unknown; jira?: { key?: unknown } };
            warnings?: string[];
          };
        };
      };

      const issueId = body.data?.createTest?.test?.issueId;
      const key = body.data?.createTest?.test?.jira?.key;

      if (typeof issueId !== "string" || typeof key !== "string") {
        throw new XrayApiError("Xray did not return the created Test key.");
      }

      created.push({ sourceId: scenario.sourceId, issueId, key });
      warnings.push(...(body.data?.createTest?.warnings ?? []));
    } catch (error) {
      if (error instanceof XrayApiError) {
        throw new XrayApiError(error.message, error.status, index, created);
      }

      throw new XrayApiError("Xray Test creation failed.", 502, index, created);
    }
  }

  try {
    const body = (await graphql(
      config,
      token,
      addTestsToTestSetMutation,
      {
        issueId: testSetIssueId,
        testIssueIds: created.map((test) => test.issueId),
      },
      fetcher,
    )) as { data?: { addTestsToTestSet?: { warning?: string | null } } };

    const warning = body.data?.addTestsToTestSet?.warning;
    if (warning) {
      warnings.push(warning);
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? `Created Tests but failed to attach them to the Test Set: ${error.message}`
        : "Created Tests but failed to attach them to the Test Set.";
    throw new XrayApiError(message, 502, undefined, created);
  }

  return { created, warnings };
}

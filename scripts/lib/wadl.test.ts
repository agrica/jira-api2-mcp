import { describe, expect, it } from 'vitest';
import { parseWadl } from './wadl.ts';

const WADL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <doc xmlns:jersey="http://jersey.java.net/" jersey:generatedBy="Jersey: 1.19"/>
  <resources base="https://jira.example/rest/api/2/">
    <resource path="issue">
      <method id="createIssue" name="POST">
        <doc>Creates an issue &lt;p&gt;or a sub-task&lt;/p&gt; &amp; more</doc>
        <request>
          <param name="updateHistory" style="query" type="xs:boolean" default="false"/>
          <representation mediaType="application/json"/>
        </request>
        <response><representation mediaType="application/json"/></response>
      </method>
      <resource path="{issueIdOrKey}">
        <param name="issueIdOrKey" style="template" type="xs:string"/>
        <method id="getIssue" name="GET">
          <request>
            <param name="fields" style="query" type="xs:string" repeating="true"/>
            <param name="expand" style="query" type="xs:string"/>
          </request>
        </method>
        <method id="deleteIssue" name="DELETE"/>
        <resource path="/transitions/">
          <method id="getTransitions" name="GET"/>
        </resource>
        <resource path="attachments">
          <method id="addAttachment" name="POST">
            <request><representation mediaType="multipart/form-data"/></request>
          </method>
        </resource>
      </resource>
    </resource>
    <resource path="board/{boardId: [0-9]+}">
      <param name="boardId" style="template" type="xs:long"/>
      <method id="getBoard" name="GET">
        <request><param name="startAt" style="query" type="xs:int" required="true"/></request>
      </method>
      <method id="weird" name="TRACE"/>
    </resource>
  </resources>
</application>`;

describe('parseWadl', () => {
  const ops = parseWadl(WADL, 'api');
  const byId = (id: string) => ops.find((o) => o.id === id);

  it('flattens nested resources into sorted, unique operation ids and skips unknown verbs', () => {
    expect(ops.map((o) => o.id)).toEqual([
      'DELETE /rest/api/2/issue/{issueIdOrKey}',
      'GET /rest/api/2/board/{boardId}',
      'GET /rest/api/2/issue/{issueIdOrKey}',
      'GET /rest/api/2/issue/{issueIdOrKey}/transitions',
      'POST /rest/api/2/issue',
      'POST /rest/api/2/issue/{issueIdOrKey}/attachments',
    ]);
    expect(ops.every((o) => o.api === 'api')).toBe(true);
  });

  it('types path params from template declarations and reads query params', () => {
    expect(byId('GET /rest/api/2/issue/{issueIdOrKey}')?.params).toEqual([
      { name: 'issueIdOrKey', in: 'path', type: 'string', required: true, repeating: false },
      { name: 'fields', in: 'query', type: 'string', required: false, repeating: true },
      { name: 'expand', in: 'query', type: 'string', required: false, repeating: false },
    ]);
    expect(byId('GET /rest/api/2/board/{boardId}')?.params).toEqual([
      { name: 'boardId', in: 'path', type: 'integer', required: true, repeating: false },
      { name: 'startAt', in: 'query', type: 'integer', required: true, repeating: false },
    ]);
  });

  it('records accepted body media types (not whether a body is required) and cleans docs', () => {
    const create = byId('POST /rest/api/2/issue');
    expect(create?.body).toEqual({ accepted: true, mediaTypes: ['application/json'] });
    expect(create?.summary).toBe('Creates an issue or a sub-task & more');
    expect(create?.params).toEqual([
      {
        name: 'updateHistory',
        in: 'query',
        type: 'boolean',
        required: false,
        repeating: false,
        default: 'false',
      },
    ]);
    expect(byId('POST /rest/api/2/issue/{issueIdOrKey}/attachments')?.body).toEqual({
      accepted: true,
      mediaTypes: ['multipart/form-data'],
    });
    expect(byId('DELETE /rest/api/2/issue/{issueIdOrKey}')?.body).toEqual({
      accepted: false,
      mediaTypes: [],
    });
  });

  it('keeps the path from the first /rest/ segment when Jira runs under a context path', () => {
    const contextPath = WADL.replace(
      'https://jira.example/rest/api/2/',
      'https://jira.example.com/jira/rest/api/2/',
    );
    const ids = parseWadl(contextPath, 'api').map((o) => o.id);
    expect(ids).toContain('POST /rest/api/2/issue');
    expect(ids.every((id) => id.split(' ')[1]?.startsWith('/rest/'))).toBe(true);
    const noRest = WADL.replace(
      'https://jira.example/rest/api/2/',
      'https://jira.example.com/jira/',
    );
    expect(parseWadl(noRest, 'api').map((o) => o.id)).toContain('POST /jira/issue');
  });
});

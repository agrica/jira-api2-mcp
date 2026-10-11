import { describe, expect, it, vi } from 'vitest';
import { parseWadl } from './wadl.ts';

/** A WADL declaring a single GET resource at `path`, under a context path. */
const one = (path: string) => `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://jira.example.com/jira/rest/api/2/"><resource path="${path}"><method name="GET"/></resource></resources>
</application>`;

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
    expect(() => parseWadl(noRest, 'api')).toThrow(/"\/jira\/issue" — it must start with \/rest\//);
  });

  it('handles template names with "-" or "." and regex constraints with nested braces', () => {
    const xml = `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://jira.example.com/rest/demo/1.0/">
    <resource path="issue/{issue-key}">
      <param name="issue-key" style="template" type="xs:string"/>
      <method id="a" name="GET"/>
      <resource path="{a.b}/x">
        <param name="a.b" style="template" type="xs:long"/>
        <method id="b" name="GET"/>
      </resource>
    </resource>
    <resource path="key/{key: [A-Z]{2,}-\\d+}/{ id : \\d{1,9} }">
      <method id="c" name="GET"/>
    </resource>
    <resource path="broken/{oops">
      <method id="d" name="GET"/>
    </resource>
  </resources>
</application>`;
    const parsed = parseWadl(xml, 'api');
    expect(parsed.map((o) => o.id)).toEqual([
      'GET /rest/demo/1.0/broken/{oops',
      'GET /rest/demo/1.0/issue/{issue-key}',
      'GET /rest/demo/1.0/issue/{issue-key}/{a.b}/x',
      'GET /rest/demo/1.0/key/{key}/{id}',
    ]);
    const find = (id: string) => parsed.find((o) => o.id === id);
    expect(find('GET /rest/demo/1.0/issue/{issue-key}/{a.b}/x')?.params).toEqual([
      { name: 'issue-key', in: 'path', type: 'string', required: true, repeating: false },
      { name: 'a.b', in: 'path', type: 'integer', required: true, repeating: false },
    ]);
    expect(find('GET /rest/demo/1.0/key/{key}/{id}')?.params.map((p) => p.name)).toEqual([
      'key',
      'id',
    ]);
    expect(find('GET /rest/demo/1.0/broken/{oops')?.params).toEqual([]);
  });

  it('refuses resource paths that escape /rest/ (audit PoC inputs)', () => {
    for (const path of [
      '%2e%2e/%2e%2e/%2e%2e/plugins/servlet/x',
      String.raw`..\..\..\secure\admin`,
      '../../../secure/Logout!default.jspa',
      'x?os_authType=basic#',
      '..;/..;/..;/secure/admin',
      '.;/x',
      '..;jsessionid=1/secure/admin',
      'a%2Fb',
      './x',
    ])
      expect(() => parseWadl(one(path), 'api')).toThrow(/Unsafe operation path in the api WADL/);
  });

  it('refuses a WADL whose resources base is outside /rest/', () => {
    const xml = `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://jira.example.com/plugins/servlet/"><resource path="x"><method name="GET"/></resource></resources>
</application>`;
    expect(() => parseWadl(xml, 'api')).toThrow(/must start with \/rest\//);
  });
});

const wrap = (
  resources: string,
  base = 'https://jira.example.com/rest/api/2/',
) => `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="${base}">${resources}</resources>
</application>`;

describe('parseWadl — not a WADL', () => {
  it.each([
    ['empty file', ''],
    ['empty file', '  \n'],
    [
      'no <application> root element',
      '<html><head><title>Log in</title></head><body>SSO</body></html>',
    ],
    ['no <application> root element', '<!DOCTYPE html><html><body><br></body></html>'],
    ['not well-formed XML', 'garbage <<<'],
    [
      'no <resources> element with a <resource>',
      '<application><resources base="https://jira.example.com/rest/api/2/"/></application>',
    ],
    ['no <resources> element with a <resource>', '<application/>'],
    ['no operation declared', wrap('<resource path="x"><method name="TRACE"/></resource>')],
  ])('refuses a source with %s', (why, xml) => {
    expect(() => parseWadl(xml, 'agile')).toThrow(
      `The agile WADL is not a usable WADL (${why}): a login, proxy or error page may have been fetched instead`,
    );
  });

  it('names the source instead of a bare "Invalid URL" for a relative or missing base', () => {
    const op = '<resource path="x"><method name="GET"/></resource>';
    expect(() => parseWadl(wrap(op, 'rest/api/2/'), 'api')).toThrow(
      'The api WADL has a <resources> element without an absolute base URL (base="rest/api/2/")',
    );
    const noBase = `<application><resources>${op}</resources></application>`;
    expect(() => parseWadl(noBase, 'api')).toThrow(
      'The api WADL has a <resources> element without an absolute base URL (base=null)',
    );
  });
});

describe('parseWadl — duplicates, parameters, media types and docs', () => {
  it('merges a method + path declared twice and reports the count', () => {
    const warn = vi.fn<(message: string) => void>();
    const ops = parseWadl(
      wrap(`
<resource path="dup">
  <method name="POST"><doc>First doc</doc><request><param name="a" style="query"/></request></method>
</resource>
<resource path="dup/">
  <method name="POST"><doc>Second doc</doc><request>
    <param name="a" style="query" required="true"/>
    <param name="b" style="query" type="xs:int" required="true"/>
    <representation mediaType="application/json"/>
  </request></method>
</resource>`),
      'api',
      warn,
    );
    expect(ops).toEqual([
      {
        id: 'POST /rest/api/2/dup',
        api: 'api',
        method: 'POST',
        path: '/rest/api/2/dup',
        summary: 'First doc',
        body: { accepted: true, mediaTypes: ['application/json'] },
        params: [
          { name: 'a', in: 'query', type: 'string', required: true, repeating: false },
          { name: 'b', in: 'query', type: 'integer', required: true, repeating: false },
        ],
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      '⚠ api WADL: 1 duplicate method + path declaration(s) merged',
    );
  });

  it('lets a method-level query parameter override the resource-level one', () => {
    const [op] = parseWadl(
      wrap(`<resource path="r"><param name="q" style="query"/>
  <method name="GET"><request><param name="q" style="query" type="xs:long" required="true"/></request></method>
</resource>`),
      'api',
      vi.fn<(message: string) => void>(),
    );
    expect(op?.params).toEqual([
      { name: 'q', in: 'query', type: 'integer', required: true, repeating: false },
    ]);
  });

  it('maps xsd: and unsigned types, dedupes repeated placeholders and counts ignored styles', () => {
    const warn = vi.fn<(message: string) => void>();
    const [op] = parseWadl(
      wrap(`<resource path="{x}/b/{x}"><param name="x" style="template" type="xsd:unsignedInt"/>
  <param name="m" style="matrix"/>
  <method name="GET"><request>
    <param name="n" style="query" type="xsd:nonNegativeInteger"/>
    <param name="d" style="query" type="xsd:decimal"/>
    <param name="h" style="header"/>
  </request></method>
</resource>`),
      'api',
      warn,
    );
    expect(op?.params).toEqual([
      { name: 'x', in: 'path', type: 'integer', required: true, repeating: false },
      { name: 'n', in: 'query', type: 'integer', required: false, repeating: false },
      { name: 'd', in: 'query', type: 'number', required: false, repeating: false },
    ]);
    expect(warn).toHaveBeenCalledWith(
      '⚠ api WADL: 2 matrix / header / plain parameter(s) ignored (the generic tools cannot send them)',
    );
  });

  it('normalises media types (lowercase, no parameters), "*/*" included', () => {
    const [op] = parseWadl(
      wrap(`<resource path="r"><method name="PUT"><request>
  <representation mediaType="Application/JSON; charset=UTF-8"/>
  <representation mediaType="application/json"/>
  <representation mediaType="*/*"/>
</request></method></resource>`),
      'api',
      vi.fn<(message: string) => void>(),
    );
    expect(op?.body).toEqual({ accepted: true, mediaTypes: ['application/json', '*/*'] });
  });

  it('unwraps CDATA docs and falls back to the doc title', () => {
    const ops = parseWadl(
      wrap(`<resource path="a"><method name="GET"><doc><![CDATA[Get <b>issue</b> by key]]></doc></method></resource>
<resource path="b"><method name="GET"><doc title="Get things"/></method></resource>`),
      'api',
    );
    expect(ops.map((o) => o.summary)).toEqual(['Get issue by key', 'Get things']);
  });
});

describe('parseWadl — wave 2 review follow-ups', () => {
  it('merges a parameter declared with two types as string and keeps the first defined default', () => {
    const [op] = parseWadl(
      wrap(`
<resource path="dup"><method name="GET"><request>
  <param name="a" style="query" type="xs:int"/>
  <param name="b" style="query" type="xs:int"/>
</request></method></resource>
<resource path="dup/"><method name="GET"><request>
  <param name="a" style="query" type="xs:boolean" default="true"/>
  <param name="b" style="query" type="xs:long" default="5"/>
</request></method></resource>`),
      'api',
      vi.fn<(message: string) => void>(),
    );
    expect(op?.params).toEqual([
      {
        name: 'a',
        in: 'query',
        type: 'string',
        required: false,
        repeating: false,
        default: 'true',
      },
      { name: 'b', in: 'query', type: 'integer', required: false, repeating: false, default: '5' },
    ]);
  });

  it('skips an extra empty <resources/> without a base', () => {
    const xml = `<application>
  <resources base="https://jira.example.com/rest/api/2/"><resource path="x"><method name="GET"/></resource></resources>
  <resources/>
</application>`;
    expect(parseWadl(xml, 'api').map((o) => o.id)).toEqual(['GET /rest/api/2/x']);
  });

  it('names plain parameters in the ignored-parameter warning', () => {
    const warn = vi.fn<(message: string) => void>();
    parseWadl(
      wrap('<resource path="r"><param name="p" style="plain"/><method name="GET"/></resource>'),
      'api',
      warn,
    );
    expect(warn).toHaveBeenCalledWith(
      '⚠ api WADL: 1 matrix / header / plain parameter(s) ignored (the generic tools cannot send them)',
    );
  });
});

describe('parseWadl — doc entities (final review)', () => {
  it('keeps out-of-range numeric entities as text instead of throwing', () => {
    const xml = `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://jira.example.com/rest/api/2/"><resource path="x"><method name="GET"><doc>a &#99999999; b &#65;</doc></method></resource></resources>
</application>`;
    expect(parseWadl(xml, 'api')[0]?.summary).toBe('a &#99999999; b A');
  });
});

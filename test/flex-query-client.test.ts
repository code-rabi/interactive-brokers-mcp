// test/flex-query-client.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FlexQueryClient } from '../src/flex-query-client.js';

const mockFetch = vi.fn();

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : `Error`,
  });
}

describe('FlexQueryClient', () => {
  let client: FlexQueryClient;
  const mockToken = 'test-token-123';
  const mockQueryId = '123456';
  const mockReferenceCode = 'ref-code-789';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    client = new FlexQueryClient({ token: mockToken });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('should initialize with token', () => {
      expect(client).toBeDefined();
    });
  });

  describe('sendRequest', () => {
    it('should successfully send request and return reference code', async () => {
      const mockResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
  <ReferenceCode>${mockReferenceCode}</ReferenceCode>
  <Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url>
</FlexStatementResponse>`;

      mockFetch.mockResolvedValueOnce(xmlResponse(mockResponseXml));

      const result = await client.sendRequest(mockQueryId);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/SendRequest?'),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );

      // Verify query params
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain(`t=${mockToken}`);
      expect(url).toContain(`q=${mockQueryId}`);
      expect(url).toContain('v=3');

      expect(result).toEqual({
        referenceCode: mockReferenceCode,
        url: 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement',
      });
    });

    it('should handle error response', async () => {
      const mockResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Fail</Status>
  <ErrorCode>1003</ErrorCode>
  <ErrorMessage>Token is not valid</ErrorMessage>
</FlexStatementResponse>`;

      mockFetch.mockResolvedValueOnce(xmlResponse(mockResponseXml));

      const result = await client.sendRequest(mockQueryId);

      expect(result).toEqual({
        error: 'Token is not valid',
        errorCode: '1003',
      });
    });

    it('should wrap HTTP errors with a descriptive message', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse('Server Error', 500));

      await expect(client.sendRequest(mockQueryId)).rejects.toThrow(
        'Failed to send flex query request: HTTP 500:'
      );
    });

    it('should throw on unexpected response format', async () => {
      const mockResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<UnexpectedFormat>
  <Data>Something</Data>
</UnexpectedFormat>`;

      mockFetch.mockResolvedValueOnce(xmlResponse(mockResponseXml));

      await expect(client.sendRequest(mockQueryId)).rejects.toThrow(
        'Unexpected response format from Flex Query service'
      );
    });
  });

  describe('getStatement', () => {
    it('should successfully get statement', async () => {
      const statementXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
</FlexStatementResponse>`;

      mockFetch.mockResolvedValueOnce(xmlResponse(statementXml));

      const result = await client.getStatement(mockReferenceCode);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/GetStatement?'),
        expect.anything()
      );

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain(`t=${mockToken}`);
      expect(url).toContain(`q=${mockReferenceCode}`);
      expect(url).toContain('v=3');

      expect(result).toEqual({
        data: statementXml,
      });
    });

    it('should handle FlexQueryResponse format', async () => {
      const flexQueryXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Test Query" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U12345" />
  </FlexStatements>
</FlexQueryResponse>`;

      mockFetch.mockResolvedValueOnce(xmlResponse(flexQueryXml));

      const result = await client.getStatement(mockReferenceCode);

      expect(result).toEqual({
        data: flexQueryXml,
      });
    });

    it('should handle error response', async () => {
      const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 02:00 PM EDT">
  <Status>Fail</Status>
  <ErrorCode>1019</ErrorCode>
  <ErrorMessage>Statement generation in progress</ErrorMessage>
</FlexStatementResponse>`;

      mockFetch.mockResolvedValueOnce(xmlResponse(errorXml));

      const result = await client.getStatement(mockReferenceCode);

      expect(result).toEqual({
        error: 'Statement generation in progress',
        errorCode: '1019',
      });
    });

    it('should wrap HTTP errors with a descriptive message', async () => {
      mockFetch.mockResolvedValueOnce(xmlResponse('Server Error', 500));

      await expect(client.getStatement(mockReferenceCode)).rejects.toThrow(
        'Failed to get flex statement: HTTP 500:'
      );
    });
  });

  describe('executeQuery', () => {
    it('should execute query and return statement', async () => {
      const sendResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
  <ReferenceCode>${mockReferenceCode}</ReferenceCode>
</FlexStatementResponse>`;

      const statementXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Test Query" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U12345" fromDate="2023-01-01" toDate="2023-12-31">
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;

      mockFetch
        .mockResolvedValueOnce(xmlResponse(sendResponseXml))
        .mockResolvedValueOnce(xmlResponse(statementXml));

      const result = await client.executeQuery(mockQueryId, 3, 100);

      expect(result).toEqual({
        data: statementXml,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry when statement is not ready', async () => {
      const sendResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
  <ReferenceCode>${mockReferenceCode}</ReferenceCode>
</FlexStatementResponse>`;

      const notReadyXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 02:00 PM EDT">
  <Status>Fail</Status>
  <ErrorCode>1019</ErrorCode>
  <ErrorMessage>Statement generation in progress</ErrorMessage>
</FlexStatementResponse>`;

      const statementXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Test Query" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U12345" />
  </FlexStatements>
</FlexQueryResponse>`;

      mockFetch
        .mockResolvedValueOnce(xmlResponse(sendResponseXml))
        .mockResolvedValueOnce(xmlResponse(notReadyXml))
        .mockResolvedValueOnce(xmlResponse(statementXml));

      const result = await client.executeQuery(mockQueryId, 3, 100);

      expect(result).toEqual({
        data: statementXml,
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['1001', 'Statement could not be generated at this time. try again shortly.'],
      ['1009', 'Server is under heavy load.'],
      ['1019', 'Statement generation in progress'],
      ['1021', 'Statement could not be retrieved at this time.'],
    ])('should retry on transient error code %s', async (errorCode, errorMessage) => {
      const sendResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
  <ReferenceCode>${mockReferenceCode}</ReferenceCode>
</FlexStatementResponse>`;

      const transientXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 02:00 PM EDT">
  <Status>Fail</Status>
  <ErrorCode>${errorCode}</ErrorCode>
  <ErrorMessage>${errorMessage}</ErrorMessage>
</FlexStatementResponse>`;

      const statementXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Test Query" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U12345" />
  </FlexStatements>
</FlexQueryResponse>`;

      mockFetch
        .mockResolvedValueOnce(xmlResponse(sendResponseXml))
        .mockResolvedValueOnce(xmlResponse(transientXml))
        .mockResolvedValueOnce(xmlResponse(statementXml));

      const result = await client.executeQuery(mockQueryId, 3, 100);

      expect(result).toEqual({
        data: statementXml,
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should not retry on terminal error codes', async () => {
      const sendResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
  <ReferenceCode>${mockReferenceCode}</ReferenceCode>
</FlexStatementResponse>`;

      const terminalXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 02:00 PM EDT">
  <Status>Fail</Status>
  <ErrorCode>1015</ErrorCode>
  <ErrorMessage>Token is invalid.</ErrorMessage>
</FlexStatementResponse>`;

      mockFetch
        .mockResolvedValueOnce(xmlResponse(sendResponseXml))
        .mockResolvedValueOnce(xmlResponse(terminalXml));

      const result = await client.executeQuery(mockQueryId, 5, 10);

      expect(result).toEqual({
        error: 'Token is invalid.',
        errorCode: '1015',
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry transient errors even when the error code itself differs but the message says "try again"', async () => {
      const sendResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
  <ReferenceCode>${mockReferenceCode}</ReferenceCode>
</FlexStatementResponse>`;

      const transientXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 02:00 PM EDT">
  <Status>Fail</Status>
  <ErrorCode>9999</ErrorCode>
  <ErrorMessage>Statement could not be retrieved. Try Again Shortly.</ErrorMessage>
</FlexStatementResponse>`;

      const statementXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Test Query" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U12345" />
  </FlexStatements>
</FlexQueryResponse>`;

      mockFetch
        .mockResolvedValueOnce(xmlResponse(sendResponseXml))
        .mockResolvedValueOnce(xmlResponse(transientXml))
        .mockResolvedValueOnce(xmlResponse(statementXml));

      const result = await client.executeQuery(mockQueryId, 3, 100);

      expect(result).toEqual({
        data: statementXml,
      });
    });

    it('should error when sendRequest returns error', async () => {
      const errorResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Fail</Status>
  <ErrorCode>1003</ErrorCode>
  <ErrorMessage>Token is not valid</ErrorMessage>
</FlexStatementResponse>`;

      mockFetch.mockResolvedValueOnce(xmlResponse(errorResponseXml));

      const result = await client.executeQuery(mockQueryId);

      expect(result).toEqual({
        error: 'Token is not valid',
        errorCode: '1003',
      });
    });

    it('should error when no reference code received', async () => {
      const sendResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
</FlexStatementResponse>`;

      mockFetch.mockResolvedValueOnce(xmlResponse(sendResponseXml));

      const result = await client.executeQuery(mockQueryId);

      expect(result).toEqual({
        error: 'No reference code received from flex query service',
      });
    });

    it('should return timeout error after max retries', async () => {
      const sendResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 01:59 PM EDT">
  <Status>Success</Status>
  <ReferenceCode>${mockReferenceCode}</ReferenceCode>
</FlexStatementResponse>`;

      const notReadyXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="26 August, 2023 02:00 PM EDT">
  <Status>Fail</Status>
  <ErrorCode>1019</ErrorCode>
  <ErrorMessage>Statement generation in progress</ErrorMessage>
</FlexStatementResponse>`;

      mockFetch
        .mockResolvedValueOnce(xmlResponse(sendResponseXml))
        .mockImplementation(() => Promise.resolve(xmlResponse(notReadyXml)));

      const result = await client.executeQuery(mockQueryId, 3, 10);

      expect(result).toEqual({
        error: 'Statement not ready after 3 retries. Please try again later.',
      });
    });
  });

  describe('parseStatement', () => {
    it('should parse XML statement into JSON', async () => {
      const xmlData = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Test Query" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U12345" fromDate="2023-01-01" toDate="2023-12-31">
      <AccountInformation currency="USD" />
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;

      const result = await client.parseStatement(xmlData);
      expect(result).toBeDefined();

      expect(result.FlexQueryResponse).toBeDefined();
      expect(result.FlexQueryResponse.queryName).toBe('Test Query');
      expect(result.FlexQueryResponse.type).toBe('AF');
    });

    it('should handle parsing errors', async () => {
      const invalidXml = 'This is not valid XML';

      await expect(client.parseStatement(invalidXml)).rejects.toThrow(
        'Failed to parse flex statement XML'
      );
    });

    it('should parse XML with mergeAttrs option', async () => {
      const xmlData = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Test" type="AF">
  <Data value="123" />
</FlexQueryResponse>`;

      const result = await client.parseStatement(xmlData);

      expect(result.FlexQueryResponse.Data.value).toBe('123');
    });
  });
});

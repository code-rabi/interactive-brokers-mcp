import { Logger } from "./logger.js";
import { parseStringPromise } from "xml2js";
import { HttpClient, HttpError, isHttpError } from "./http.js";

interface FlexQueryClientConfig {
  token: string;
}

interface FlexStatementStatusResponse {
  Status?: string;
  ReferenceCode?: string;
  Url?: string;
  ErrorMessage?: string;
  ErrorCode?: string;
}

interface FlexQueryResponse {
  referenceCode?: string;
  url?: string;
  error?: string;
  errorCode?: string;
}

interface FlexStatementResponse {
  data?: string;
  error?: string;
  errorCode?: string;
}

type ParsedFlexDocument = {
  FlexStatementResponse?: FlexStatementStatusResponse;
  FlexQueryResponse?: unknown;
};

export class FlexQueryClient {
  static readonly TRANSIENT_GET_STATEMENT_ERROR_CODES = new Set([
    "1001",
    "1004",
    "1005",
    "1006",
    "1007",
    "1008",
    "1009",
    "1010",
    "1011",
    "1012",
    "1018",
    "1019",
    "1020",
    "1021",
  ]);

  private readonly token: string;
  private readonly http = new HttpClient({
    baseUrl: "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService",
    timeout: 30000,
  });

  constructor(config: FlexQueryClientConfig) {
    this.token = config.token;
  }

  private async getXml(
    path: string,
    params: Record<string, string>,
    errorPrefix: string,
  ): Promise<string> {
    try {
      const response = await this.http.request<string>("GET", path, { params });
      return typeof response.data === "string" ? response.data : String(response.data ?? "");
    } catch (error) {
      if (isHttpError(error)) {
        throw new Error(`${errorPrefix}: ${this.describeHttpError(error)}`);
      }
      throw error;
    }
  }

  private async parseXml(xml: string): Promise<ParsedFlexDocument> {
    return (await parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
    })) as ParsedFlexDocument;
  }

  private describeHttpError(error: HttpError): string {
    const body =
      typeof error.response.data === "string"
        ? error.response.data
        : JSON.stringify(error.response.data);

    return `HTTP ${error.response.status}: ${body ?? ""}`;
  }

  private extractErrorMessage(response: FlexStatementStatusResponse): string {
    return response.ErrorMessage || response.ErrorCode || "Unknown error";
  }

  async sendRequest(queryId: string): Promise<FlexQueryResponse> {
    Logger.log(`[FLEX-QUERY] Sending request for query ID: ${queryId}`);

    const xml = await this.getXml(
      "/SendRequest",
      { t: this.token, q: queryId, v: "3" },
      "Failed to send flex query request",
    );
    const parsed = await this.parseXml(xml);
    const flexResponse = parsed.FlexStatementResponse;

    if (!flexResponse) {
      throw new Error("Unexpected response format from Flex Query service");
    }

    if (flexResponse.Status === "Success") {
      return {
        referenceCode: flexResponse.ReferenceCode,
        url: flexResponse.Url,
      };
    }

    if (flexResponse.Status === "Fail") {
      return {
        error: this.extractErrorMessage(flexResponse),
        errorCode: flexResponse.ErrorCode,
      };
    }

    throw new Error("Unexpected response format from Flex Query service");
  }

  async getStatement(referenceCode: string): Promise<FlexStatementResponse> {
    Logger.log(`[FLEX-QUERY] Retrieving statement for reference code: ${referenceCode}`);

    const xml = await this.getXml(
      "/GetStatement",
      { t: this.token, q: referenceCode, v: "3" },
      "Failed to get flex statement",
    );
    const parsed = await this.parseXml(xml);

    if ("FlexQueryResponse" in parsed) {
      return { data: xml };
    }

    if (parsed.FlexStatementResponse?.Status === "Success") {
      return { data: xml };
    }

    if (parsed.FlexStatementResponse?.Status === "Fail") {
      return {
        error: this.extractErrorMessage(parsed.FlexStatementResponse),
        errorCode: parsed.FlexStatementResponse.ErrorCode,
      };
    }

    throw new Error("Unexpected response format from Flex Query service");
  }

  async executeQuery(
    queryId: string,
    maxRetries: number = 10,
    retryDelayMs: number = 2000,
  ): Promise<FlexStatementResponse> {
    Logger.log(`[FLEX-QUERY] Executing flex query ${queryId}`);

    const sendResponse = await this.sendRequest(queryId);
    if (sendResponse.error) {
      return {
        error: sendResponse.error,
        errorCode: sendResponse.errorCode,
      };
    }

    if (!sendResponse.referenceCode) {
      return {
        error: "No reference code received from flex query service",
      };
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }

      Logger.log(
        `[FLEX-QUERY] Attempt ${attempt + 1}/${maxRetries} to retrieve statement...`,
      );

      const statementResponse = await this.getStatement(sendResponse.referenceCode);
      if (!statementResponse.error) {
        Logger.log("[FLEX-QUERY] Statement retrieved successfully");
        return statementResponse;
      }

      const code = statementResponse.errorCode ?? "";
      const normalizedError = statementResponse.error.toLowerCase();
      const isTransient =
        FlexQueryClient.TRANSIENT_GET_STATEMENT_ERROR_CODES.has(code) ||
        normalizedError.includes("not ready") ||
        normalizedError.includes("in progress") ||
        normalizedError.includes("try again");

      if (!isTransient) {
        return statementResponse;
      }

      Logger.log(
        `[FLEX-QUERY] Statement not ready yet (code ${code || "?"}: ${statementResponse.error}), retrying...`,
      );
    }

    return {
      error: `Statement not ready after ${maxRetries} retries. Please try again later.`,
    };
  }

  async parseStatement(xmlData: string): Promise<any> {
    try {
      return await parseStringPromise(xmlData, {
        explicitArray: false,
        mergeAttrs: true,
      });
    } catch (error) {
      Logger.error("[FLEX-QUERY] Failed to parse statement:", error);
      throw new Error("Failed to parse flex statement XML");
    }
  }
}

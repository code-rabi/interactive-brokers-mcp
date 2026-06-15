import { Logger } from "./logger.js";
import { parseStringPromise } from "xml2js";
import { HttpError, isHttpError } from "./http.js";

interface FlexQueryClientConfig {
  token: string;
}

interface FlexQueryResponse {
  referenceCode?: string;
  url?: string;
  error?: string;
  errorCode?: string;
}

interface FlexStatementResponse {
  data?: string; // XML data
  error?: string;
  errorCode?: string;
}

/**
 * Client for Interactive Brokers Flex Query Web Service
 * API Documentation: https://www.interactivebrokers.com/en/software/am/am/reports/flex_web_service_version_3.htm
 */
export class FlexQueryClient {
  // IB Flex Web Service error codes that mean "try again shortly" — the statement
  // is being prepared. All other Fail codes are terminal (bad token, invalid query, etc.).
  private static readonly TRANSIENT_GET_STATEMENT_ERROR_CODES = new Set([
    "1001", // Statement could not be generated at this time
    "1004", // Statement is incomplete at this time
    "1005", // Settlement data is not ready
    "1006", // FIFO P/L data is not ready
    "1007", // MTM P/L data is not ready
    "1008", // MTM and FIFO P/L data is not ready
    "1009", // Server is under heavy load
    "1018", // Too many requests from this token
    "1019", // Statement generation in progress
    "1021", // Statement could not be retrieved at this time
  ]);

  private token: string;
  // Fixed: gdcdyn → ndcdyn, /Universal/servlet → /AccountManagement/FlexWebService
  private baseUrl = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

  constructor(config: FlexQueryClientConfig) {
    this.token = config.token;
  }

  private async get(url: string, params: Record<string, string>): Promise<{ data: string }> {
    const fullUrl = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      fullUrl.searchParams.set(key, value);
    }
    const response = await fetch(fullUrl.toString(), {
      signal: AbortSignal.timeout(60000),
    });
    const data = await response.text();
    if (!response.ok) {
      throw new HttpError(
        `HTTP ${response.status}: ${response.statusText}`,
        { status: response.status, statusText: response.statusText, data },
        { url: fullUrl.toString(), method: "GET" },
      );
    }
    return { data };
  }

  /**
   * Send a request to execute a flex query
   * @param queryId The flex query ID to execute
   * @returns Response containing reference code or error
   */
  async sendRequest(queryId: string): Promise<FlexQueryResponse> {
    try {
      Logger.log(`[FLEX-QUERY] Sending request for query ID: ${queryId}`);

      const url = `${this.baseUrl}/SendRequest`;
      const params = {
        t: this.token,
        q: queryId,
        v: "3", // API version
      };

      const response = await this.get(url, params);

      Logger.log(`[FLEX-QUERY] SendRequest response:`, response.data);

      // Parse XML response
      const parsed = await parseStringPromise(response.data, { explicitArray: false });

      if (parsed.FlexStatementResponse) {
        const flexResponse = parsed.FlexStatementResponse;

        if (flexResponse.Status === "Success") {
          return {
            referenceCode: flexResponse.ReferenceCode,
            url: flexResponse.Url,
          };
        } else if (flexResponse.Status === "Fail") {
          return {
            error: flexResponse.ErrorMessage || flexResponse.ErrorCode || "Unknown error",
            errorCode: flexResponse.ErrorCode,
          };
        }
      }

      throw new Error("Unexpected response format from Flex Query service");
    } catch (error) {
      Logger.error("[FLEX-QUERY] Failed to send request:", error);

      if (isHttpError(error)) {
        throw new Error(`Failed to send flex query request: ${error.message}`);
      }

      throw error;
    }
  }

  /**
   * Get the statement data using a reference code
   * @param referenceCode The reference code from sendRequest
   * @returns The flex statement data (XML format) or error
   */
  async getStatement(referenceCode: string): Promise<FlexStatementResponse> {
    try {
      Logger.log(`[FLEX-QUERY] Getting statement for reference code: ${referenceCode}`);

      const url = `${this.baseUrl}/GetStatement`;
      const params = {
        t: this.token,
        q: referenceCode,
        v: "3", // API version
      };

      const response = await this.get(url, params);

      // Parse XML response
      const parsed = await parseStringPromise(response.data, { explicitArray: false });

      if (parsed.FlexStatementResponse) {
        const flexResponse = parsed.FlexStatementResponse;

        if (flexResponse.Status === "Success") {
          // The actual statement data is in the response
          return {
            data: response.data,
          };
        } else if (flexResponse.Status === "Fail") {
          return {
            error: flexResponse.ErrorMessage || flexResponse.ErrorCode || "Unknown error",
            errorCode: flexResponse.ErrorCode,
          };
        }
      } else if (parsed.FlexQueryResponse) {
        // This is the actual statement data
        return {
          data: response.data,
        };
      }

      throw new Error("Unexpected response format from Flex Query service");
    } catch (error) {
      Logger.error("[FLEX-QUERY] Failed to get statement:", error);

      if (isHttpError(error)) {
        throw new Error(`Failed to get flex statement: ${error.message}`);
      }

      throw error;
    }
  }

  /**
   * Execute a flex query and wait for the results
   * @param queryId The flex query ID to execute
   * @param maxRetries Maximum number of retries for getting the statement (default: 10)
   * @param retryDelayMs Delay between retries in milliseconds (default: 2000)
   * @returns The flex statement data or error
   */
  async executeQuery(
    queryId: string,
    maxRetries: number = 10,
    retryDelayMs: number = 2000
  ): Promise<FlexStatementResponse> {
    // Step 1: Send the request
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

    Logger.log(`[FLEX-QUERY] Query submitted, reference code: ${sendResponse.referenceCode}`);
    Logger.log(`[FLEX-QUERY] Waiting for statement to be ready (max ${maxRetries} retries)...`);

    // Step 2: Poll for the statement
    for (let i = 0; i < maxRetries; i++) {
      // Wait before checking
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

      Logger.log(`[FLEX-QUERY] Attempt ${i + 1}/${maxRetries} to retrieve statement...`);

      const statementResponse = await this.getStatement(sendResponse.referenceCode);

      if (statementResponse.error) {
        const code = statementResponse.errorCode ?? "";
        const normalizedError = statementResponse.error.toLowerCase();
        const isTransient =
          FlexQueryClient.TRANSIENT_GET_STATEMENT_ERROR_CODES.has(code) ||
          normalizedError.includes("in progress") ||
          normalizedError.includes("not ready") ||
          normalizedError.includes("try again");

        if (isTransient) {
          Logger.log(
            `[FLEX-QUERY] Statement not ready yet (code ${code || "?"}: ${statementResponse.error}), retrying...`
          );
          continue;
        }

        // It's a real error
        return statementResponse;
      }

      // Success!
      Logger.log(`[FLEX-QUERY] Statement retrieved successfully`);
      return statementResponse;
    }

    return {
      error: `Statement not ready after ${maxRetries} retries. Please try again later.`,
    };
  }

  /**
   * Parse flex statement XML data into a more usable JSON format
   * @param xmlData The XML data from getStatement
   * @returns Parsed JSON object
   */
  async parseStatement(xmlData: string): Promise<any> {
    try {
      const parsed = await parseStringPromise(xmlData, {
        explicitArray: false,
        mergeAttrs: true,
      });
      return parsed;
    } catch (error) {
      Logger.error("[FLEX-QUERY] Failed to parse statement:", error);
      throw new Error("Failed to parse flex statement XML");
    }
  }
}

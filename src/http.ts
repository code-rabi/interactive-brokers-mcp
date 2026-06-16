import type { Dispatcher } from "undici";

declare global {
  interface RequestInit {
    dispatcher?: Dispatcher;
  }
}

interface HttpClientConfig {
  baseUrl?: string;
  timeout?: number;
  dispatcher?: Dispatcher;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  timeout?: number;
  skipDefaultHeaders?: boolean;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
}

export class HttpError extends Error {
  response: { status: number; statusText: string; data: unknown };
  config: { url?: string; method?: string };

  constructor(
    message: string,
    response: { status: number; statusText: string; data: unknown },
    config: { url?: string; method?: string } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.response = response;
    this.config = config;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class HttpClient {
  private baseUrl: string;
  private timeout: number;
  private dispatcher?: Dispatcher;
  private defaultHeaders: Record<string, string> = {};

  constructor(config: HttpClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? "";
    this.timeout = config.timeout ?? 30000;
    this.dispatcher = config.dispatcher;
  }

  setHeader(name: string, value: string): void {
    this.defaultHeaders[name] = value;
  }

  removeHeader(name: string): void {
    delete this.defaultHeaders[name];
  }

  async request<T = unknown>(
    method: string,
    urlOrPath: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    let url: string;
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
      url = urlOrPath;
    } else {
      url = `${this.baseUrl}${urlOrPath}`;
    }

    if (options?.params) {
      const separator = url.includes("?") ? "&" : "?";
      url += separator + new URLSearchParams(options.params).toString();
    }

    const headers: Record<string, string> = options?.skipDefaultHeaders
      ? {}
      : { ...this.defaultHeaders };

    if (options?.body !== undefined && typeof options.body !== "string") {
      headers["Content-Type"] ??= "application/json";
    }
    if (options?.headers) {
      Object.assign(headers, options.headers);
    }

    let body: string | undefined;
    if (options?.body !== undefined) {
      body =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options?.timeout ?? this.timeout),
      dispatcher: this.dispatcher,
    });

    const data = await parseBody(response);

    if (!response.ok) {
      throw new HttpError(
        `Request failed with status ${response.status}`,
        { status: response.status, statusText: response.statusText, data },
        { url, method },
      );
    }

    return {
      data: data as T,
      status: response.status,
      statusText: response.statusText,
    };
  }
}

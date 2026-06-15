import type { Dispatcher } from "undici";

declare global {
  interface RequestInit {
    dispatcher?: Dispatcher;
  }
}

export class HttpError extends Error {
  response: { status: number; statusText: string; data: any };
  config: { url?: string; method?: string };

  constructor(
    message: string,
    response: { status: number; statusText: string; data: any },
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

export async function parseBody(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

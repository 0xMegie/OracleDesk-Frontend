export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(error: ApiErrorPayload, status: number) {
    super(error.message);
    this.name = "ApiError";
    this.code = error.code;
    this.status = status;
    this.details = error.details;
  }
}

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error: ApiErrorPayload | null;
  meta?: unknown;
}

type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface ApiResponse<T> {
  data: T;
  meta?: unknown;
}

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://oracledesk-backend.onrender.com/api/v1";
const TOKEN_KEY = "oracledesk_token";
const USER_ID_KEY = "oracledesk_user_id";
const WALLET_KEY = "oracledesk_wallet";

function getBrowserStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function buildUrl(path: string, params?: QueryParams) {
  const url = new URL(path.replace(/^\//, ""), `${API_URL.replace(/\/$/, "")}/`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url.toString();
}

export function getStoredToken() {
  return getBrowserStorage()?.getItem(TOKEN_KEY) ?? null;
}

export function storeAuthSession(session: { token: string; userId: string; walletAddress: string }) {
  const storage = getBrowserStorage();
  storage?.setItem(TOKEN_KEY, session.token);
  storage?.setItem(USER_ID_KEY, session.userId);
  storage?.setItem(WALLET_KEY, session.walletAddress);
}

/** Wallet address the stored session belongs to, if any. */
export function getStoredSessionWallet() {
  const storage = getBrowserStorage();
  return storage?.getItem(TOKEN_KEY) ? storage.getItem(WALLET_KEY) : null;
}

export function clearAuthSession() {
  const storage = getBrowserStorage();
  storage?.removeItem(TOKEN_KEY);
  storage?.removeItem(USER_ID_KEY);
  storage?.removeItem(WALLET_KEY);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  params?: QueryParams,
): Promise<ApiResponse<T>> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);

  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, params), {
      ...init,
      headers,
    });
  } catch (error) {
    // Standard browser error for network failures (including ECONNREFUSED)
    if (error instanceof TypeError && (error.message === "Failed to fetch" || error.message.includes("NetworkError"))) {
      throw new ApiError(
        {
          code: "BACKEND_UNREACHABLE",
          message: `Could not connect to the API server. Please ensure the backend is running at ${API_URL}`,
        },
        0
      );
    }
    throw error;
  }

  const envelope = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  const apiError = envelope?.error;

  if (!response.ok || envelope?.ok === false) {
    if (apiError?.code === "TOKEN_EXPIRED") {
      clearAuthSession();
    }

    throw new ApiError(
      apiError ?? {
        code: `HTTP_${response.status}`,
        message: response.statusText || "Request failed",
      },
      response.status,
    );
  }

  return {
    data: envelope?.data as T,
    meta: envelope?.meta,
  };
}

/**
 * Enhanced error handling with JWT expiry detection.
 * Returns true if the error indicates an expired or invalid token that needs re-auth.
 */
export function isAuthError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.code === "TOKEN_EXPIRED" || error.code === "UNAUTHORIZED" || error.status === 401;
  }
  return false;
}

export const apiClient = {
  get<T>(path: string, params?: QueryParams) {
    return request<T>(path, { method: "GET" }, params);
  },

  post<T>(path: string, body?: unknown) {
    return request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  },

  put<T>(path: string, body?: unknown) {
    return request<T>(path, {
      method: "PUT",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  },

  patch<T>(path: string, body?: unknown) {
    return request<T>(path, {
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  },
};

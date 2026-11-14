/**
 * Jest manual mock for react-native-keychain.
 * In-memory store; reset between tests via `__resetStore()`.
 */
const store: Record<string, string> = {};

export const setGenericPassword = jest.fn(
  async (_username: string, password: string, options?: { service?: string }) => {
    const key = options?.service ?? "__default__";
    store[key] = password;
    return true;
  }
);

export const getGenericPassword = jest.fn(
  async (options?: { service?: string }): Promise<{ username: string; password: string } | false> => {
    const key = options?.service ?? "__default__";
    const pw = store[key];
    if (pw === undefined) return false;
    return { username: "k9o_refresh_token", password: pw };
  }
);

export const resetGenericPassword = jest.fn(
  async (options?: { service?: string }) => {
    const key = options?.service ?? "__default__";
    delete store[key];
    return true;
  }
);

/** Test helper — wipe the in-memory store between tests. */
export function __resetStore(): void {
  for (const key of Object.keys(store)) delete store[key];
  setGenericPassword.mockClear();
  getGenericPassword.mockClear();
  resetGenericPassword.mockClear();
}

import * as Keychain from "react-native-keychain";

const SERVICE = "dev.kilimanjaro.gate";
const USERNAME = "k9o_refresh_token";

/**
 * Refresh-token persistence backed by `react-native-keychain`.
 *
 * On iOS this writes to the Keychain with
 * `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` semantics (library
 * default). On Android it uses the Keystore-backed encrypted store.
 * Token material never leaves the device.
 *
 * Implement `TokenStore` for custom persistence or testing.
 */
export class KeychainTokenStore implements TokenStore {
  async save(token: string): Promise<void> {
    await Keychain.setGenericPassword(USERNAME, token, { service: SERVICE });
  }

  async load(): Promise<string | null> {
    const result = await Keychain.getGenericPassword({ service: SERVICE });
    if (result === false) return null;
    return result.password;
  }

  async delete(): Promise<void> {
    await Keychain.resetGenericPassword({ service: SERVICE });
  }
}

/** Minimal token-store interface for injection and testing. */
export interface TokenStore {
  save(token: string): Promise<void>;
  load(): Promise<string | null>;
  delete(): Promise<void>;
}

// Vault-prefixed addresses (ROADMAP item 37, DESIGN §6.44), as pure functions shared by the app
// and the service worker: an extra vault's app lives under `/v/<name>/`, the default vault's at `/`.

const NAME = '[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?';
const VAULT_PATH = new RegExp(`^/v/(${NAME})(?=/|$)`);
const VALID_NAME = new RegExp(`^${NAME}$`);

/** The extra vault named by a pathname, or null for the default vault. */
export function vaultFromPathname(pathname: string): string | null {
  const m = VAULT_PATH.exec(pathname);
  return m ? m[1] : null;
}

export function isValidVaultName(name: string): boolean {
  return VALID_NAME.test(name);
}

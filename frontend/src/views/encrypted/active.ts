// The open encrypted note's actions, for the palette (DESIGN §6.33).

export interface EncryptedControls {
  unlocked(): boolean;
  changePassphrase(): void;
  removeEncryption(): void;
}

const active = new Map<string, EncryptedControls>();

export function setActiveEncrypted(path: string, controls: EncryptedControls): () => void {
  active.set(path, controls);
  return () => {
    if (active.get(path) === controls) active.delete(path);
  };
}

export function activeEncrypted(path: string | null): EncryptedControls | null {
  return path === null ? null : (active.get(path) ?? null);
}

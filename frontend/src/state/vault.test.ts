import { afterEach, describe, expect, it } from 'vitest';
import { apiUrl, appPathname, appTitle, appUrl, currentVault, isValidVaultName, routeOfAppUrl, setCurrentVaultForTests, vaultBasename, vaultFromPathname, vaultKey } from './vault';

describe('vault addresses (ROADMAP item 37, DESIGN §6.41)', () => {
  afterEach(() => setCurrentVaultForTests(null));

  it('reads the vault from the address', () => {
    expect(vaultFromPathname('/')).toBeNull();
    expect(vaultFromPathname('/n/Note.md')).toBeNull();
    expect(vaultFromPathname('/v/work')).toBe('work');
    expect(vaultFromPathname('/v/work/')).toBe('work');
    expect(vaultFromPathname('/v/work/n/Plan.md')).toBe('work');
    expect(vaultFromPathname('/v/Work/n/Plan.md')).toBeNull();
    expect(vaultFromPathname('/v/-x/')).toBeNull();
    expect(vaultFromPathname('/v/workshop')).toBe('workshop');
    expect(vaultFromPathname('/vault/x')).toBeNull();
    expect(isValidVaultName('a')).toBe(true);
    expect(isValidVaultName('my-vault-2')).toBe(true);
    expect(isValidVaultName('a'.repeat(32))).toBe(true);
    expect(isValidVaultName('a'.repeat(33))).toBe(false);
    expect(isValidVaultName('My Vault')).toBe(false);
    expect(isValidVaultName('x-')).toBe(false);
    expect(isValidVaultName('..')).toBe(false);
  });

  it('leaves every address of the default vault unchanged', () => {
    expect(currentVault()).toBeNull();
    expect(vaultBasename()).toBe('');
    expect(apiUrl('/api/files?path=a.md')).toBe('/api/files?path=a.md');
    expect(appUrl('/n/a.md')).toBe('/n/a.md');
    expect(appPathname('/n/a.md')).toBe('/n/a.md');
    expect(vaultKey('notesapp:workspace')).toBe('notesapp:workspace');
    expect(appTitle('Plan')).toBe('Plan · Notes');
    expect(routeOfAppUrl('/x/tasks/today?task=1')).toBe('/x/tasks/today?task=1');
    expect(routeOfAppUrl('/v/work/x/tasks')).toBeNull();
  });

  it('prefixes an extra vault’s API and app addresses, except the server-wide vault list', () => {
    setCurrentVaultForTests('work');
    expect(vaultBasename()).toBe('/v/work');
    expect(apiUrl('/api/files?path=a.md')).toBe('/api/v/work/files?path=a.md');
    expect(apiUrl('/api/events?clientId=x')).toBe('/api/v/work/events?clientId=x');
    expect(apiUrl('/api/vaults')).toBe('/api/vaults');
    expect(apiUrl('/api/vaultsx')).toBe('/api/v/work/vaultsx');
    expect(apiUrl('/clipper/clipper.js')).toBe('/clipper/clipper.js');
    expect(appUrl('/n/a.md')).toBe('/v/work/n/a.md');
    expect(appPathname('/v/work/n/a.md')).toBe('/n/a.md');
    expect(appPathname('/v/work')).toBe('/');
    expect(appPathname('/v/workshop/n/a.md')).toBe('/v/workshop/n/a.md');
    expect(vaultKey('notesapp:workspace')).toBe('notesapp:workspace@work');
    expect(appTitle('Plan')).toBe('Plan · work · Notes');
    expect(routeOfAppUrl('/v/work/x/tasks/today?task=1')).toBe('/x/tasks/today?task=1');
    expect(routeOfAppUrl('/v/work/?open=daily')).toBe('/?open=daily');
    expect(routeOfAppUrl('/x/tasks')).toBeNull();
    expect(routeOfAppUrl('/v/play/x/tasks')).toBeNull();
  });
});

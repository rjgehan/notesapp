import { afterEach, describe, expect, it } from 'vitest';
import { decryptPayload, deriveKey, encryptText, newWriteKey } from './cipher';
import { createKey, isUnlocked, lock, onLock, openCached, resetKeyringForTests, unlock } from './keyring';
import { base64ToBytes, decodePayload, saltId } from './meld';

// Made with Node's own crypto (pbkdf2Sync + aes-256-gcm with a 16-byte IV), independently of the
// app's WebCrypto code, following Meld Encrypt's CryptoHelper2304 (v2) and CryptoHelper (v1).
const PASS = 'correct horse battery staple';
const V2 = 'AAECAwQFBgcICQoLDA0OD/Dg0MCwoJCAcGBQQDAgEACrsoTj31BFp/0kZclovXUwtfxEYrfkMTA+IESxsfk2+AYujp7x4gue6vCN0sWz';
const V1 = 'AAECAwQFBgcICQoLDA0OD4kAbwhEuK2XodQep9+VZhvQlc+pGra9UGpS';

afterEach(() => resetKeyringForTests());

describe('WebCrypto payloads (item 27)', () => {
  it('decrypts payloads made by an independent implementation of the plugin format', async () => {
    const v2 = decodePayload(V2, 2);
    expect(await decryptPayload(v2, await deriveKey(PASS, v2.salt, 2))).toBe('Bank PIN: 4242 ✓\nsecond line');
    const v1 = decodePayload(V1, 1);
    expect(await decryptPayload(v1, await deriveKey(PASS, v1.salt, 1))).toBe('old secret');
  });

  it('rejects a wrong passphrase and tampered ciphertext', async () => {
    const v2 = decodePayload(V2, 2);
    expect(await decryptPayload(v2, await deriveKey('wrong', v2.salt, 2))).toBeNull();
    const bytes = base64ToBytes(V2);
    bytes[bytes.length - 1] ^= 1;
    const tampered = decodePayload(btoa(String.fromCharCode(...bytes)), 2);
    expect(await decryptPayload(tampered, await deriveKey(PASS, tampered.salt, 2))).toBeNull();
  });

  it('round-trips with a fresh IV every time and the key’s salt in every payload', async () => {
    const write = await newWriteKey(PASS);
    const a = await encryptText('same text', write);
    const b = await encryptText('same text', write);
    expect(a).not.toBe(b);
    const pa = decodePayload(a, 2);
    const pb = decodePayload(b, 2);
    expect(saltId(pa.iv)).not.toBe(saltId(pb.iv));
    expect(saltId(pa.salt)).toBe(saltId(write.salt));
    expect(await decryptPayload(pa, write.key)).toBe('same text');
    // Another device opens it from the passphrase alone.
    expect(await decryptPayload(pb, await deriveKey(PASS, pb.salt, 2))).toBe('same text');
  });

  it('creates keys that cannot be exported', async () => {
    const { key } = await newWriteKey(PASS);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});

describe('the session keyring (item 27)', () => {
  it('reports a wrong passphrase, then keeps the right key for the session', async () => {
    const payload = decodePayload(V2, 2);
    expect(await unlock('nope', payload)).toBeNull();
    expect(isUnlocked()).toBe(false);
    expect(await openCached(payload)).toBeNull();
    const opened = await unlock(PASS, payload);
    expect(opened?.text).toBe('Bank PIN: 4242 ✓\nsecond line');
    expect(saltId(opened!.write.salt)).toBe(saltId(payload.salt));
    expect((await openCached(payload))?.text).toBe(opened?.text);
  });

  it('saves v1 text as v2 with a new salt from the same passphrase', async () => {
    const payload = decodePayload(V1, 1);
    const opened = await unlock(PASS, payload);
    expect(opened?.text).toBe('old secret');
    const again = decodePayload(await encryptText('upgraded', opened!.write), 2);
    expect(await decryptPayload(again, await deriveKey(PASS, again.salt, 2))).toBe('upgraded');
    expect((await openCached(payload))?.text).toBe('old secret');
  });

  it('opens the note’s other sections with the same passphrase', async () => {
    const other = await newWriteKey(PASS);
    const second = decodePayload(await encryptText('second', other), 2);
    await unlock(PASS, decodePayload(V2, 2), [second]);
    expect((await openCached(second))?.text).toBe('second');
  });

  it('forgets every key on lock, after telling the views', async () => {
    const write = await createKey(PASS);
    const payload = decodePayload(await encryptText('x', write), 2);
    expect(await openCached(payload)).not.toBeNull();
    const calls: boolean[] = [];
    onLock(() => calls.push(isUnlocked()));
    lock();
    expect(calls).toEqual([true]);
    expect(isUnlocked()).toBe(false);
    expect(await openCached(payload)).toBeNull();
  });
});

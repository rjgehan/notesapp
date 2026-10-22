// This device's Web Push subscription (DESIGN §6.32, ROADMAP item 9). Subscribing asks for
// notification permission, fetches the server's VAPID key, subscribes the service worker's push
// manager and registers the subscription; the device's id is remembered here so Settings can mark
// "this device" and unsubscribe it. iOS allows Web Push only in the app added to the Home Screen
// (16.4 and later); a Safari tab has no PushManager.
import { remindersApi } from './client';

const DEVICE_KEY = 'notesapp.push.device';

export type PushSupport = 'supported' | 'ios-needs-install' | 'insecure' | 'no-service-worker' | 'unsupported';

export function isIos(ua: string = navigator.userAgent, touchPoints: number = navigator.maxTouchPoints ?? 0): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

function isStandalone(): boolean {
  return (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator)) return isIos() ? 'ios-needs-install' : 'unsupported';
  if (!('PushManager' in window) || typeof Notification === 'undefined') return isIos() && !isStandalone() ? 'ios-needs-install' : 'unsupported';
  return 'supported';
}

/** A name for the device list, from the user agent: "iPhone · Safari", "Windows · Edge". */
export function defaultDeviceName(ua: string = navigator.userAgent, touchPoints: number = navigator.maxTouchPoints ?? 0): string {
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  return browser ? `${device} · ${browser}` : device;
}

/** The base64url VAPID key as the bytes PushManager.subscribe wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function thisDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

function rememberDevice(id: string | null): void {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // Private mode: the list just does not mark this device.
  }
}

async function registration(timeoutMs = 5000): Promise<ServiceWorkerRegistration> {
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The app’s service worker is not running here (it runs in the built app, not the development server).')), timeoutMs));
  return Promise.race([ready, timeout]);
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Subscribes this device and registers it with the server. Throws with a message to show. */
export async function subscribeThisDevice(name: string = defaultDeviceName()): Promise<string> {
  const support = pushSupport();
  if (support === 'ios-needs-install') throw new Error('On iPhone and iPad, add NotesApp to the Home Screen (Share › Add to Home Screen), open it from there, then turn this on.');
  if (support !== 'supported') throw new Error('This browser cannot receive Web Push.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for NotesApp in this browser’s settings.');
  const reg = await registration();
  const { publicKey } = await remindersApi.pushKey();
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser returned an incomplete push subscription.');
  const device = await remindersApi.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, name });
  rememberDevice(device.id);
  return device.id;
}

/** Removes this device's subscription, in the browser and on the server. */
export async function unsubscribeThisDevice(): Promise<void> {
  const id = thisDeviceId();
  try {
    const reg = await registration(2000);
    const sub = await reg.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // No worker: the server side is still removed below.
  }
  if (id) await remindersApi.unsubscribe(id).catch(() => undefined);
  rememberDevice(null);
}

/** Removes another device (it stops receiving reminders; its browser keeps a dead subscription). */
export async function removeDevice(id: string): Promise<void> {
  if (id === thisDeviceId()) return unsubscribeThisDevice();
  await remindersApi.unsubscribe(id);
}

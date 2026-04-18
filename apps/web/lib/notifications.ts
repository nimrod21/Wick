'use client';

/**
 * Thin wrapper around the browser Notifications API.
 *
 * Safe to import from any client component; every function degrades
 * gracefully in non-browser environments (SSR, notifications unsupported,
 * permission denied).
 */

function supported(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

export function getPermission(): NotificationPermission {
  if (!supported()) return 'denied';
  return Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!supported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function notify(title: string, body: string, icon?: string): void {
  if (!supported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    // `tag` collapses rapid-fire alerts into a single surfaced notification
    // so the OS tray doesn't stack up during a market storm.
    new Notification(title, {
      body,
      icon,
      tag: 'cockpit-alert',
      silent: false,
    });
  } catch {
    /* ignore: some browsers throw on new Notification under focus constraints */
  }
}

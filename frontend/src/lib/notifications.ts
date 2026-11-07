/**
 * Desktop notifications — fired when a turn completes or an approval is
 * requested while the window doesn't have focus. Permission is requested
 * lazily on the first user gesture (sending a message); in the Electron shell
 * it is granted by default, in Chrome it may be denied — both are fine.
 */

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

const ENABLED_KEY = "vibedeck.notifications";

/** Master switch for desktop notifications (default on). */
export function notificationsEnabled(): boolean {
  try {
    const v = localStorage.getItem(ENABLED_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch { /* storage unavailable */ }
}

/** Ask for permission (no-op when already granted/denied/unsupported). */
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (Notification.permission === "granted") return "granted";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Fire a notification if enabled + permission is granted; never throws. */
export function notify(title: string, body?: string): void {
  if (!notificationsEnabled()) return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* notifications are best-effort */
  }
}

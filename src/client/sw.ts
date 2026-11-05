/// <reference lib="webworker" />
import type { PushPayload } from '../shared/types';

declare const self: ServiceWorkerGlobalScope;

const CACHE = 'call9me-v2';
const PRECACHE = ['/css/styles.css', '/js/app.js', '/js/landing.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {}),
  );
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/** Network first (the app is real-time and needs the server anyway); cache only as offline fallback. */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) return;

  const isStatic = /^\/(css|js|icons)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest';
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        if (isStatic && response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then(async (cache) => {
            // Keep one copy per file: drop the ones from older builds ("?v=" differs).
            for (const old of await cache.keys(event.request, { ignoreSearch: true })) {
              if (old.url !== event.request.url) await cache.delete(old);
            }
            await cache.put(event.request, copy);
          });
        }
        return response;
      } catch {
        // Asset URLs carry "?v=<build>"; offline, any cached build of the file beats none.
        const cached = await caches.match(event.request, { ignoreSearch: isStatic });
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return new Response(
            '<!doctype html><meta name="viewport" content="width=device-width"><title>Offline</title>' +
              '<body style="font-family:system-ui;background:#0f1220;color:#e7e9f3;display:grid;place-items:center;height:100vh;margin:0">' +
              '<p>You are offline. Call9me needs a connection.</p></body>',
            { headers: { 'Content-Type': 'text/html' } },
          );
        }
        return Response.error();
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let parsed: PushPayload | null = null;
  try {
    parsed = event.data?.json() as PushPayload;
  } catch {
    /* fall back below */
  }
  // Even an unreadable push must show something (see the iOS note below).
  const payload: PushPayload = parsed?.title
    ? parsed
    : { type: 'chat', title: 'Call9me', body: 'You have new activity.', tag: 'generic', url: '/app' };

  // Always show a notification. Skipping one ("silent push") makes iOS revoke the
  // subscription after a few times; the server already avoids pushing while the app
  // is on screen (the page reports its visibility).
  event.waitUntil(
    (async () => {
      const isCall = payload.type === 'call';
      const options: NotificationOptions & {
        renotify?: boolean;
        vibrate?: number[];
        actions?: { action: string; title: string }[];
      } = {
        body: payload.body,
        tag: payload.tag,
        icon: payload.icon ?? '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        data: { url: payload.url, callId: payload.callId, type: payload.type },
        renotify: payload.type !== 'chat',
        requireInteraction: isCall,
        vibrate: isCall ? [600, 300, 600, 300, 600, 300, 600] : [100],
        // Android/desktop show these buttons; iOS just opens the app on tap (which answers).
        actions: isCall && payload.callId
          ? [
              { action: 'answer', title: 'Answer' },
              { action: 'decline', title: 'Decline' },
            ]
          : undefined,
      };
      await self.registration.showNotification(payload.title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string; callId?: string; type?: string } | null;

  // Decline straight from the notification, without opening the app.
  if (event.action === 'decline' && data?.callId) {
    event.waitUntil(
      fetch(`/api/calls/${encodeURIComponent(data.callId)}/decline`, { method: 'POST', credentials: 'same-origin' })
        .then(() => undefined)
        .catch(() => undefined),
    );
    return;
  }

  // Tapping the notification or "Answer" opens the app, which answers via `?answer=<callId>`.
  const url = data?.url ?? '/app';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const appWindow = windows.find((c) => new URL(c.url).pathname === '/app') ?? windows[0];
      if (appWindow) {
        // Don't navigate (that would drop an active call); let the page handle it.
        appWindow.postMessage({ type: 'open-url', url });
        await appWindow.focus();
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

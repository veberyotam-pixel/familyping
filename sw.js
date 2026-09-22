// FamilyPing service worker.
// Its only job is turning a push into a notification, and a tap into an
// open app. iOS only runs this when the app has been added to the Home Screen.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }

  if (data.kind !== 'ping') return;

  // A push that arrives late is a missed call, not a ring. 30 s: a little over the
  // 20 s call, so a phone clock a few seconds off still rings.
  if (data.sent_at) {
    const age = (Date.now() - new Date(data.sent_at).getTime()) / 1000;
    if (age > 30) {
      event.waitUntil(self.registration.showNotification('Missed call', {
        body: (data.sender_name || 'Someone') + ' called you',
        icon: './icons/icon-192.png',
        tag: 'familyping-missed',
        silent: true,
      }));
      return;
    }
  }

  // Who is calling, with their face - the same as the Android call screen.
  const who = (data.sender_emoji ? data.sender_emoji + ' ' : '') + (data.sender_name || 'Someone');
  const title = who + ' is calling you';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.family_name || 'Family',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'familyping-call',
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 600],
      data: { ping_id: data.ping_id },
      actions: [
        { action: 'coming', title: 'Coming' },
        { action: 'busy', title: 'Busy' },
      ],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  const answer = event.action;
  const pingId = (event.notification.data || {}).ping_id;
  event.notification.close();

  const url = answer
    ? './index.html?answer=' + encodeURIComponent(answer) + '&ping=' + encodeURIComponent(pingId || '')
    : './index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ kind: 'answer', answer, ping_id: pingId });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

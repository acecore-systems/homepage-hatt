self.addEventListener('push', (event) => {
  let payload = {
    title: '無料体験申し込み',
    body: '新しい無料体験申し込みがあります。',
    url: '/course-admin/',
  }

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() }
    } catch {
      payload.body = event.data.text() || payload.body
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/uploads/hatt/course-admin-icon-192.png',
      badge: '/uploads/hatt/course-admin-icon-192.png',
      tag: 'course-trial-signup',
      data: { url: payload.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const targetUrl = new URL(
    event.notification.data?.url || '/course-admin/',
    self.location.origin,
  ).href

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus()
          }
        }

        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl)
        }

        return undefined
      }),
  )
})

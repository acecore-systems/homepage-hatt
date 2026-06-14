self.addEventListener('push', (event) => {
  const notification = {
    title: '無料体験申し込み',
    body: '新しい無料体験申し込みがあります。',
    url: '/course-admin/',
  }

  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body,
      icon: '/uploads/hatt/course-admin-icon-192.png',
      badge: '/uploads/hatt/course-admin-icon-192.png',
      tag: 'course-trial-signup',
      data: { url: notification.url },
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

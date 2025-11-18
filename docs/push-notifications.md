# Push Notifications: VAPID keys and resubscribe guide

This project uses Web Push with VAPID. Both client and server must use the same VAPID key pair:

- Server: signs notifications with PRIVATE + PUBLIC key
- Client: subscribes using the PUBLIC key

If these differ, FCM/Chrome returns 403: “the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.”

## Health checks

- GET /push/health → shows whether keys are loaded and a short fingerprint of the public key
- GET /push/public-key → returns the public key and its fingerprint

Use the fingerprint to quickly confirm the client fetched the same public key as the server is configured with.

## Set the keys

1) Choose one VAPID pair. If you need to generate:

- Using Node web-push in a script:
  ```js
  import webpush from 'web-push';
  console.log(webpush.generateVAPIDKeys());
  ```

2) Configure backend environment:

- VAPID_PUBLIC_KEY=...
- VAPID_PRIVATE_KEY=...

3) Restart the backend.

## Resubscribe clients after key changes

Browsers cache push subscriptions and they are bound to the public key used at creation.
If you rotate keys or fix a mismatch, existing subscriptions must be recreated.

Steps:

- Visit the app; the frontend fetches the server public key.
- If it detects the key changed, it unsubscribes the old subscription and re-subscribes with the new key (handled automatically by `src/utils/push-notification.js`).
- Alternatively, manually clear site data and notification permission in the browser, then enable notifications again.

## Sending a test notification

- POST /push/notify with JSON body:
  ```json
  { "title": "Hello", "body": "Test push", "url": "/" }
  ```
- Response includes counts: sent, removed (stale subs 404/410), mismatched (403), total (remaining subs).

## Common pitfalls

- Backend public/private mismatch: ensure the env public key matches the private key.
- Frontend using a different env/public key: the frontend now fetches the backend key first; ensure API_URL points to the correct backend instance.
- Service worker cache: after changes, reload the page; clearing site data can help.


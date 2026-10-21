# Reminders (ROADMAP item 9 + 4c): implementation plan

Not built yet. Written 2026-10-21 so the next session can start directly.

## Facts in the current code

- Tasks already store `reminders: {at}[]` (`TaskReminder(String at)`, local `YYYY-MM-DDTHH:mm`); recurring tasks shift reminders on roll-forward.
- `TaskCatalog` is package-private: add a small public `TaskService` method returning open, non-archived tasks in non-archived lists that have reminders (`catalog.tasks()`, `catalog.list(id).archived()`).
- `TaskService.complete(id, CompleteTaskRequest(tz, date, base{due,start}), identity, origin)` cannot double-roll. A notification "Done" passes the task's current due/start and is a no-op if the reminder's `at` is no longer on the task.
- Reuse `NtfyClient.publish(config, topic, Message(title, body, priority, tags, click))` and `NtfyConfigFile.load()`; add a `"reminders": {topic?, ...}` section to `ntfy.json` (unknown members are already ignored).
- `NotesProperties.secretsDir` defaults to `/data/secrets`.
- iOS web push has no notification action buttons: Snooze/Done from the notification work on desktop Chrome/Edge only; on iPhone a tap opens the task.
- ROADMAP also asks for daily-note nudges; the desktop route waits for item 41.

## Design

**Web Push, JDK crypto only (no new dependency).**
- VAPID: an ES256 JWT signed with `SHA256withECDSAinP1363Format`.
- Payload: RFC 8291 aes128gcm (ECDH P-256, HKDF-SHA256, AES-128-GCM). Test it against the RFC 8291 Appendix A vector.
- Keys and per-device subscriptions live in `/data/secrets/push.json`. A subscription is dropped on a 404 or 410 from the push service.

**Scheduler state** is in `.notesapp/reminders.json`, added to the managed `info/exclude` like `trash.json`. It holds:
- a baseline time;
- the device-reported IANA zone (the latest report wins);
- a ledger of delivered reminders keyed `task:<id>:<at>`, pruned after about 48 h;
- snoozes.

**Scheduler loop** ticks every 15 s.
- A reminder is due when its time is in `(now - 24h, now]`, after the baseline, and not in the ledger.
- It is delivered once at least one route accepts it.
- With every route off, the baseline advances to now, so enabling a route later doesn't flood.
- Delivery is at least once: a crash between send and state write may repeat one reminder.
- Local times resolve with `ZonedDateTime.ofLocal`, which keeps DST changes predictable.

**Routes** are each off by default, as switches in a new `reminders` settings group:
- Web Push.
- ntfy, with "title only" on by default, because with ntfy.sh the text leaves the tailnet.
- In-app: an SSE event `reminder.due`, shown as a toast and a Notification API popup.

**Endpoints:**
- `PUT /api/reminders/zone`
- `GET /api/reminders/status`
- `POST` and `DELETE /api/push/subscriptions`
- `POST /api/reminders/test`
- `POST /api/reminders/snooze`
- `POST /api/reminders/done`

**Frontend:**
- The service worker gets `push` and `notificationclick` handlers.
- Settings gets a Reminders section: subscribe this device, the device list, test buttons, ntfy status and the zone.
- The task detail sheet gets reminder presets and a custom time.

**Docs to update:** API.md (keep §17 identical to `types.ts`), DESIGN.md (next free sections), ROADMAP items 9 and 4, CASAOS.md, DEPLOY.md.

**Needs a real iPhone:** iOS 16.4+ Home Screen web push. Check subscribing, delivery while the app is closed, and that a tap opens the task.

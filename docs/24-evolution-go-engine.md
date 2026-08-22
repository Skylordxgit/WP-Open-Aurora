# Evolution Go Engine

AuroraWA uses Evolution Go 0.7.2 as its primary WhatsApp transport. The React dashboard and public
Aurora API remain unchanged. Evolution owns WhatsApp authentication and the live whatsmeow socket;
Aurora owns application data, authorization, retries, WebSocket fan-out, PostgreSQL history, and media.

```text
WhatsApp -> Evolution Go -> AuroraWA -> PostgreSQL + local/S3 media -> existing React UI
```

## Source Of Truth

- Every live message and every HistorySync backfill is idempotently upserted by session and WhatsApp message ID.
- Contacts and chat summaries are persisted independently of the live WhatsApp connection.
- Media bytes are copied into Aurora's configured `STORAGE_TYPE`; PostgreSQL stores the object key and MIME type.
- Profile pictures fetched through the existing contact endpoint are archived for offline access.
- The dashboard loads PostgreSQL first. Archived media is hydrated through the authenticated Aurora API.
- Disconnecting or restarting Evolution does not delete Aurora history. It only disables live send/receive.
- Delivery state advances from sent to delivered/read without accepting out-of-order status regressions.
- Reactions, revocations, and supported text edits update PostgreSQL before real-time consumers are notified.

Evolution's `DATABASE_SAVE_MESSAGES=true` journal is a secondary transport diagnostic store, not the UI data source.

## First Start

1. Run `npm run env:generate` to create an ignored `.env` with three independent 256-bit secrets.
2. For a VPS-specific environment, run `npm run env:generate -- .env .env.vps.example`.
3. Keep `DATABASE_PASSWORD`, `EVOLUTION_GO_API_KEY`, and `EVOLUTION_GO_INSTANCE_TOKEN_SECRET` private and preserve them across restarts.
4. Register the Evolution license once, then set the registered `EVOLUTION_OPERATOR_EMAIL` for headless activation.
5. Run `docker compose up -d` and inspect `docker compose logs -f evolution-go openwa-api`.

Fresh PostgreSQL volumes create `openwa`, `evogo_auth`, and `evogo_users` automatically. For an existing PostgreSQL
volume, create the two Evolution databases once before starting the sidecar:

```sql
CREATE DATABASE evogo_auth;
CREATE DATABASE evogo_users;
```

## Recovery Behavior

Aurora reconnects the remote Evolution instance on boot and reattaches its event WebSocket with capped exponential
backoff. A remote logout is treated as terminal and requires QR or pairing-code authentication; a network or process
disconnect keeps credentials and retries indefinitely by default.

Failed transient sends are stored with their payload and retried from PostgreSQL. Every attempt reuses a deterministic
WhatsApp message ID, preventing duplicate delivery when the sidecar sent successfully but the HTTP response was lost.
Invalid-recipient and blocked/unsafe-media failures are permanent and are not retried.

## History And Media Backfill

Evolution HistorySync events are persisted in batches. When a history item contains an encrypted media descriptor but
no bytes, Aurora calls Evolution's `/message/downloadmedia`, archives the result, and then serves it from Aurora storage.
If WhatsApp has already expired the media object, the message remains visible and the existing unavailable-media state
is shown.

## Compatibility

`whatsapp-web.js` and Baileys adapters remain available as explicit `ENGINE_TYPE` alternatives. Aurora never silently
falls back from Evolution Go to a browser engine because two engines controlling one account can destabilize a session.

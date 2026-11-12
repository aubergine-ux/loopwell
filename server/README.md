# Loopwell server

The optional backend for Loopwell. The app works fully without it; running this adds accounts, cloud saves with version history, a public gallery of published beats with likes, play counts and remix credit, shareable sample packs, and moderation tools.

It is a Node + TypeScript HTTP API (Fastify) on Postgres, with files in any S3-compatible object store (MinIO in the bundled setup) or a plain directory.

- Full API reference: `openapi.yaml`, served by a running server at `/api/openapi.json` and as a page at `/api/docs`.
- Every setting: `../.env.example`.

## Run it with Docker

From the repository root:

```sh
cp .env.example .env      # then edit it, see below
docker compose up -d --build
curl http://localhost:8787/api/health
```

That starts Postgres, MinIO, a one-shot job that creates the bucket, and the API on port 8787 (change the host port with `API_PORT`). Data lives in the named volumes `pgdata` and `miniodata`. Database migrations run on every start.

Before exposing it to anyone, set in `.env`:

| Variable | Why |
| --- | --- |
| `PUBLIC_URL` | The URL the API is reachable at. OAuth callbacks are built from it. |
| `APP_ORIGINS` | Origins of the Loopwell app allowed to call the API and to receive sign-in redirects, comma-separated. For the hosted app: `https://aubergine-ux.github.io`. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | At least one provider, or nobody can sign in. |
| `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD` | Change the defaults. |
| `IP_HASH_SECRET` | A long random string, so play-count hashes survive restarts. |
| `ADMIN_HANDLES` | Who gets the moderation tools. |
| `TRUST_PROXY=1` | Only if the API is behind a reverse proxy that sets `X-Forwarded-For`. |

`.env` holds secrets: keep it out of version control.

Put TLS in front of it (Caddy, nginx, a tunnel) for anything beyond local use; browsers will not let an `https` app call an `http` API.

The compose file uses the Chainguard build of MinIO. The server only speaks the S3 API, so any S3-compatible store works: point `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` at it.

## Registering the OAuth apps

A provider is switched on by setting its client id and secret. `GET /api/config` tells the app which ones are on.

### GitHub

1. Open GitHub, then Settings, Developer settings, OAuth Apps, New OAuth App. (For an organisation: the organisation's Settings, Developer settings.)
2. Application name: anything, for example "Loopwell". Homepage URL: where your Loopwell app lives.
3. Authorization callback URL: `<PUBLIC_URL>/api/auth/github/callback`, for example `https://api.example.com/api/auth/github/callback`.
4. Register the application. Copy the Client ID into `GITHUB_CLIENT_ID`.
5. Click "Generate a new client secret" and copy it into `GITHUB_CLIENT_SECRET`.

Only the `read:user` scope is requested: public profile, no email, no repositories.

### Discord

1. Open <https://discord.com/developers/applications> and click New Application.
2. In the application, go to OAuth2.
3. Under Redirects, add `<PUBLIC_URL>/api/auth/discord/callback` and save.
4. Copy the Client ID into `DISCORD_CLIENT_ID`. Click Reset Secret and copy the result into `DISCORD_CLIENT_SECRET`.

Only the `identify` scope is requested.

Restart the API after changing `.env` (`docker compose up -d`).

## How sign-in works

The app is on another origin, so there are no cookies.

1. The app navigates to `GET /api/auth/github/start?redirect=<app url>` (or `discord`). The redirect must be on an origin in `APP_ORIGINS`.
2. The provider sends the browser back to `/api/auth/<provider>/callback`. The server creates the account on first sign-in and redirects to `<app url>#auth=<code>`. The code lasts 60 seconds and works once. On failure the fragment is `#auth_error=access_denied`, `provider_error` or `banned`.
3. The app calls `POST /api/auth/exchange` with `{"code": "..."}` and gets `{"token", "user"}`.
4. Every later request carries `Authorization: Bearer <token>`. Tokens last `SESSION_TTL_DAYS` and are stored only as hashes.

The handle is the provider login, lowercased, with a number appended if it is taken. It never changes; the display name and bio can be edited.

## Endpoints

All under `/api`. "Token" means a bearer token is required; "optional" means it works signed out and returns more when signed in. Errors are always `{"error": {"code", "message"}}`. Paged lists return `{"items", "nextCursor"}`; pass `nextCursor` back as `?cursor=`.

Files (project files, beats, samples) are uploaded as the raw request body with `Content-Type: application/octet-stream`; their metadata goes in the query string.

### Service

| | |
| --- | --- |
| `GET /health` | Liveness and database check. |
| `GET /config` | Enabled providers and upload limits. |
| `GET /openapi.json`, `GET /docs` | The API description and a page rendering it. |

### Auth and account

| | | |
| --- | --- | --- |
| `GET /auth/:provider/start?redirect=` | | Begin sign-in (`github` or `discord`). |
| `GET /auth/:provider/callback` | | The provider returns here. |
| `POST /auth/exchange` | | `{code}` to `{token, user}`. |
| `POST /auth/dev-login` | | Development only, see below. |
| `POST /auth/logout` | token | End this session. |
| `GET /me` | token | The account, with storage used and quota. |
| `PATCH /me` | token | `{displayName, bio}`. |
| `DELETE /me` | token | Delete the account and everything it owns. |
| `GET /users/:handle` | optional | Public profile with beat count, total plays and likes. |

### Cloud saves

A project is a name and a run of numbered versions. Each is an opaque `.loopwell` file; the server only checks that it is a zip within `MAX_PROJECT_MB`. The newest `MAX_PROJECT_VERSIONS` are kept. Other people's projects answer 404.

| | | |
| --- | --- | --- |
| `GET /projects` | token | My projects. |
| `POST /projects?name=` | token | Save a new project (body: file). |
| `GET /projects/:id` | token | Details. |
| `GET /projects/:id/data` | token | Download the current version. |
| `PUT /projects/:id?name=` | token | Save a new version (body: file). |
| `DELETE /projects/:id` | token | Delete it and its history. |
| `GET /projects/:id/versions` | token | Version history. |
| `GET /projects/:id/versions/:n/data` | token | Download one version. |
| `POST /projects/:id/versions/:n/restore` | token | Copy an old version forward as the new current one. |

### Gallery

| | | |
| --- | --- | --- |
| `POST /beats?title=&description=&tags=&genre=&bpm=&key=&remixOf=` | token | Publish (body: file). `tags` is comma-separated, at most 8, normalised to lowercase with dashes. |
| `GET /beats?sort=new\|top\|plays&tag=&genre=&key=&bpmMin=&bpmMax=&q=&user=&cursor=&limit=` | optional | Browse. |
| `GET /beats/:id` | optional | Details: author, likes, plays, `likedByMe`, `remixOf`, `remixRoot`, `remixCount`. |
| `GET /beats/:id/data` | optional | Download the project file. |
| `GET /beats/:id/remixes` | optional | Beats published as a remix of this one. |
| `POST /beats/:id/play` | optional | Count a play: at most one per beat per client per hour. |
| `PUT /beats/:id/like`, `DELETE /beats/:id/like` | token | Like, unlike. |
| `PATCH /beats/:id` | token | Edit metadata (author or admin). |
| `DELETE /beats/:id` | token | Delete (author or admin). |
| `GET /tags` | | Popular tags. |

A remix records both the beat it was made from (`remixOf`) and the original at the start of the chain (`remixRoot`), so credit reaches the first author however long the chain gets. Play counting recognises a client by a keyed hash of its address; the address itself is never stored or logged.

### Sample packs

A pack starts as a draft only its owner sees, takes samples one upload at a time, and becomes public when published.

| | | |
| --- | --- | --- |
| `POST /packs` | token | `{name, description, license, licenseUrl, attribution, tags}`. License is `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0` or `custom`; `custom` needs `licenseUrl`. |
| `POST /packs/:id/samples?name=` | token | Add a sample (body: audio file). Owner only. |
| `DELETE /packs/:id/samples/:sid` | token | Remove a sample. Owner only. |
| `POST /packs/:id/publish` | token | Make it public. Needs at least one sample. |
| `GET /packs?q=&tag=&user=&mine=&cursor=&limit=` | optional | Browse published packs; `mine=1` lists your own, drafts included. |
| `GET /packs/:id` | optional | Details with the sample list. |
| `GET /packs/:id/samples/:sid/data` | optional | Download a sample. |
| `DELETE /packs/:id` | token | Delete (owner or admin). |

Every uploaded sample is checked before it is stored:

- It must be WAV, AIFF, MP3, OGG, FLAC or M4A, judged by its first bytes rather than its name (`415 unsupported_audio`).
- At most `MAX_SAMPLE_MB` per file (`413 payload_too_large`).
- WAV, AIFF and FLAC headers are read: no longer than `MAX_SAMPLE_SECONDS` (`422 audio_too_long`), 1 to 8 channels and 4000 to 192000 Hz (`422 invalid_audio`). MP3, OGG and M4A are identified but their length is not measured.
- At most `MAX_PACK_FILES` samples (`409 pack_full`) and `MAX_PACK_MB` (`413 pack_too_large`) per pack.
- The account's storage quota, shared with cloud saves and published beats (`413 quota_exceeded`).

### Moderation

| | | |
| --- | --- | --- |
| `POST /reports` | token | `{targetType: beat\|pack\|user, targetId, reason: spam\|abuse\|copyright\|explicit\|other, details}`. For a user, `targetId` is the handle. One open report per user per target; rate limited. |
| `GET /admin/reports?status=open\|resolved` | admin | The queue. |
| `POST /admin/reports/:id/resolve` | admin | `{action: dismiss\|hide\|remove\|ban, note}`. |
| `POST /admin/beats/:id/unhide`, `POST /admin/packs/:id/unhide` | admin | Undo a hide. |
| `POST /admin/users/:handle/unban` | admin | Lift a ban. |
| `GET /admin/audit` | admin | Log of admin actions. |

- **hide** takes a beat or pack out of public view. Its owner and admins still see it, marked `hidden`.
- **remove** deletes it.
- **ban** bans the reported user, or the owner of the reported beat or pack. They are signed out, cannot sign in or publish, and their uploads and profile leave public view until the ban is lifted. Admins cannot be banned.
- Resolving a report settles every other open report about the same target the same way.

Admins are the handles in `ADMIN_HANDLES`, plus any user with `is_admin` set in the database:

```sh
docker compose exec postgres psql -U loopwell -c "update users set is_admin = true where handle = 'somebody'"
```

`ADMIN_HANDLES` matches Loopwell handles, which are claimed by whoever signs in first with that login. Sign in yourself before announcing the server, or use `is_admin`.

## Development

Node 22 or newer.

```sh
cd server
npm install
npm test          # the whole suite; needs no Docker, database or network
npm run check     # type-check
```

The tests run the real server against an in-process Postgres (PGlite), the filesystem storage driver in a temp directory and a fake OAuth provider. One test compares the registered routes with `openapi.yaml` in both directions, so a route cannot be added, removed or have its auth changed without the document following.

To run the server itself you need a Postgres. Without `S3_BUCKET` files go to `STORAGE_DIR` (default `./data/storage`).

```sh
docker run -d --name loopwell-pg -e POSTGRES_USER=loopwell -e POSTGRES_PASSWORD=loopwell -e POSTGRES_DB=loopwell -p 5432:5432 postgres:17-alpine
DEV_LOGIN=1 npm run dev     # reads ../.env if it exists
```

### Dev login

With `DEV_LOGIN=1`, `POST /api/auth/dev-login` with `{"handle": "ann"}` returns a token without any OAuth app:

```sh
TOKEN=$(curl -s -X POST localhost:8787/api/auth/dev-login -H 'content-type: application/json' -d '{"handle":"ann"}' | jq -r .token)
curl -s localhost:8787/api/me -H "authorization: Bearer $TOKEN"
```

It lets anyone be anyone, so it is off by default and the route does not exist when `NODE_ENV=production`, whatever the flag says. Under docker compose (production by default): `NODE_ENV=development DEV_LOGIN=1 docker compose up -d`.

### Layout

```
migrations/     plain SQL, applied in name order at startup, tracked in schema_migrations
openapi.yaml    the API description
src/index.ts    entry point: config, database, migrations, storage, listen
src/server.ts   buildServer(): auth, rate limits, CORS, errors, shared helpers
src/routes/     auth, projects, beats, packs, moderation, docs
src/audio.ts    sample scanning
src/storage.ts  S3 and filesystem drivers
test/           vitest suites and the test rig
```

To change the schema, add the next numbered `.sql` file to `migrations/`; never edit one that has shipped.

### Attaching to the server

`buildServer({config, db, storage})` returns the Fastify instance without listening. `app.server` is the underlying `node:http` server, so a WebSocket (or any upgrade) handler can be attached to it, and `app.loopwell` exposes the database, storage and clock:

```ts
const app = await buildServer({ config, db, storage });
app.server.on('upgrade', (req, socket, head) => { /* hand off to a WebSocket server */ });
await app.listen({ host: config.host, port: config.port });
```

## Limits of this design

- Rate limits are counted in memory, per process. Run one API process, or put a shared limiter in front of several.
- Uploads are buffered in memory before they are stored (up to `MAX_PROJECT_MB` each).
- Deleting a row and deleting its file are not one transaction. If the object store is down at that moment the file is left behind and the failure is logged.

## Live sessions

`src/realtime.ts` adds a WebSocket endpoint, `GET /api/live/{room}`, that relays live sessions: several people editing one beat at once. It needs no account and stores nothing in the database; rooms live in memory and are forgotten ten minutes after the last person leaves.

| Query parameter | Meaning |
| :-- | :-- |
| `name` | Display name, up to 24 characters |
| `client` | A stable id for this browser, so a removed guest stays removed |
| `create=1` and `key` | Create the room. `key` (16+ characters) is the host's secret; reconnecting with it gives the host seat back |

Text frames are JSON messages with a `t` field (`welcome`, `joined`, `left`, `aw` for presence, `chat`, `log`, `transport`, `room`, `denied`, `ping`/`pong`). Binary frames start with a type byte: `1` is a [Yjs](https://yjs.dev) update to merge, `2` is the room's whole document, sent to a client whose edit was refused. The host can lock tracks, make the session view-only, remove people and end the session; the server enforces all four. Only origins listed in `APP_ORIGINS` may connect.

If the API sits behind a reverse proxy, the proxy has to pass WebSocket upgrades through for `/api/live/`.

# CIGSPOT

The Next.js home page serves the supplied mobile UI from `public/cigspot_mobile_app.html`. The original layout and CSS remain in place; the former hard-coded demo spots are replaced with a MapLibre client and a Fastify API backed by PostGIS and Redis.

## Start locally

Requirements: Node.js 20.9 or newer and Docker Compose.

```powershell
Copy-Item .env.example .env.local
docker compose up -d
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The API applies `server/db/001_init.sql` on startup. PostGIS stores spots and the geography index; Redis caches MVT tiles for 10 minutes and nearby results for 60 seconds.

The starter map is centered around Kochi and nearby search begins with a 1 km radius. Use **find near me** to request browser location access. A new spot starts unverified, and the map contains no seeded example locations.

## Optional services

- `MAPBOX_ACCESS_TOKEN` selects the Mapbox Light style. Leave it blank to use the OpenFreeMap light style. The browser map token is public; use a rotated, URL-restricted token for a deployed site.
- Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` to store uploaded photos in Cloudflare R2. Without these, uploads are stored in the local `uploads/` directory. R2 S3 credentials are used by the API; the Cloudflare dashboard API token is not used.
- `COMMENT_HASH_SECRET` should be replaced with a private random value before deployment.
- `CIGSPOT_API_ORIGIN` points Next.js rewrites at Fastify. `API_HOST` can be set to `0.0.0.0` when the API runs in a container or on a separate host.

## Host it

Recommended split: **Vercel for Next.js**, with **Fastify + Postgres/PostGIS + Redis on Render**. Vercel's rewrite keeps browser requests on your site domain while forwarding `/api/*` and `/tiles/*` to Fastify.

1. Push this repository to GitHub. Create a Render Postgres database and a Redis-compatible Key Value instance in the same region as the API. Render supports PostGIS and Redis-compatible connections.
2. Create a Render **Web Service** from this repository. Use build command `npm ci && npm run build:api` and start command `npm run start:api`.
3. Add these environment variables to the Render API service:
   - `DATABASE_URL`: Render Postgres **internal** URL
   - `REDIS_URL`: Render Key Value **internal** URL
   - `NEXT_APP_ORIGIN`: your Vercel site URL
   - `COMMENT_HASH_SECRET`: a newly generated private random value
   - Optional: `MAPBOX_ACCESS_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
4. Import the same GitHub repository into Vercel as a Next.js project. Set `CIGSPOT_API_ORIGIN` to the Render API URL, with no trailing slash, then deploy. Keep database, Redis, and R2 secrets on the API service; they are not `NEXT_PUBLIC_*` variables.

The API listens on the host-provided `PORT` and binds to `0.0.0.0` when `PORT` is set. The startup migration enables PostGIS. [Render Postgres extensions](https://render.com/docs/postgresql-extensions), [Render web services](https://render.com/docs/web-services), [Vercel external rewrites](https://vercel.com/docs/routing/rewrites).

## App behavior

- `/tiles/spots/:z/:x/:y.pbf` generates Mapbox Vector Tiles from `ST_TileEnvelope` and `ST_AsMVT`, caches the binary tile in Redis, and invalidates tile caches after spot changes.
- `/api/spots/nearby` uses `ST_DWithin` on the indexed `GEOGRAPHY(Point, 4326)` location, rounded-coordinate Redis keys, and a 60-second TTL.
- The MapLibre client displays minimal square category markers and clusters loaded map features below zoom 9.
- Unique device IDs in local storage let the community vote once per spot. Upvotes score +1, downvotes -2, and reports -5. Scores of 5 verify a spot; scores of -3 hide it.
- Anonymous comments are limited to 300 characters and 3 posts per IP/user-agent hash every 15 minutes.
- Spot edits are proposals. Three different device IDs must support a proposal before it is applied.

## Commands

```powershell
npm run dev       # Fastify API and Next.js dev server
npm run build     # Type-check/compile API and build Next.js
npm start         # Start the compiled API and Next.js production server
```

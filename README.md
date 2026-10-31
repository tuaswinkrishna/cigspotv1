# CIGSPOT


Requirements: Node.js 20.9 or newer and Docker Compose.

```powershell
Copy-Item .env.example .env.local
docker compose up -d
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The API applies `server/db/001_init.sql` on startup. PostGIS stores spots and the geography index; Redis caches MVT tiles for 10 minutes and nearby results for 60 seconds.


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

import dotenv from "dotenv";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { Redis } from "ioredis";
import { Pool, type PoolClient } from "pg";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

dotenv.config({ path: ".env.local" });
dotenv.config();

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://cigspot:cigspot_dev_only@127.0.0.1:5433/cigspot";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const hashSecret = process.env.COMMENT_HASH_SECRET ?? "local-development-change-me";
const uploadDirectory = path.resolve(process.cwd(), "uploads");
const allowedTypes = new Set(["chai kada", "scenic pause", "shop"]);
const allowedAvailability = new Set(["imported only", "local only", "idk"]);
const commentDisplayNames = [
  "Anu", "Amal", "Anagha", "Arjun", "Athira", "Akhil", "Devika", "Diya", "Fathima", "Gopika",
  "Hari", "Irfan", "Jishnu", "Kannan", "Lakshmi", "Manu", "Meera", "Nikhil", "Nila", "Neeraj",
  "Rahul", "Riya", "Sreya", "Sreehari", "Vivek", "Aswathy", "Midhun", "Parvathy", "Abhinav", "Nandana",
];

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 5000 });

const bucket = process.env.R2_BUCKET ?? "cigspot";
const accountId = process.env.R2_ACCOUNT_ID;
const r2Client = accountId && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  ? new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 9 * 1024 * 1024 });

await app.register(cors, {
  origin: process.env.NEXT_APP_ORIGIN ?? "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "OPTIONS"],
});
await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 300): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function numeric(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function validClientId(value: unknown): string | null {
  const id = text(value, 40);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function commentDisplayName(clientId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < clientId.length; index += 1) {
    hash = Math.imul(hash ^ clientId.charCodeAt(index), 16777619);
  }
  return commentDisplayNames[(hash >>> 0) % commentDisplayNames.length];
}

function spotId(request: FastifyRequest): number | null {
  const params = request.params as { id?: string };
  const value = Number(params.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function userIpHash(request: FastifyRequest): string {
  const userAgent = text(request.headers["user-agent"], 400);
  return createHmac("sha256", hashSecret).update(`${request.ip}|${userAgent}`).digest("hex");
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteRedisPattern(pattern: string) {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 250);
    if (keys.length) await redis.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}

async function invalidateSpotCaches() {
  await Promise.all([
    deleteRedisPattern("tile:spots:*").catch((error) => app.log.error(error, "tile cache invalidation failed")),
    deleteRedisPattern("nearby:*").catch((error) => app.log.error(error, "nearby cache invalidation failed")),
    redis.del("stats:spot-count").catch((error) => app.log.error(error, "spot count cache invalidation failed")),
  ]);
}

async function applyInteraction(spotIdValue: number, clientId: string, action: "upvote" | "downvote" | "flag") {
  return inTransaction(async (client) => {
    const spot = await client.query("SELECT id FROM spots WHERE id = $1 AND status <> 'hidden' FOR UPDATE", [spotIdValue]);
    if (!spot.rowCount) return null;

    const current = await client.query(
      "SELECT action FROM spot_interactions WHERE spot_id = $1 AND client_id = $2 FOR UPDATE",
      [spotIdValue, clientId],
    );
    const existingAction = current.rows[0]?.action as string | undefined;
    if (existingAction === action) {
      await client.query("DELETE FROM spot_interactions WHERE spot_id = $1 AND client_id = $2", [spotIdValue, clientId]);
    } else {
      await client.query(
        `INSERT INTO spot_interactions (spot_id, client_id, action)
         VALUES ($1, $2, $3)
         ON CONFLICT (spot_id, client_id) DO UPDATE SET action = EXCLUDED.action, created_at = NOW()`,
        [spotIdValue, clientId, action],
      );
    }

    const tally = await client.query(
      `SELECT
         COALESCE(SUM(CASE action WHEN 'upvote' THEN 1 WHEN 'downvote' THEN -2 WHEN 'flag' THEN -5 END), 0)::int AS score,
         COUNT(*) FILTER (WHERE action = 'upvote')::int AS upvotes,
         COUNT(*) FILTER (WHERE action = 'downvote')::int AS downvotes
       FROM spot_interactions WHERE spot_id = $1`,
      [spotIdValue],
    );
    const score = Number(tally.rows[0].score);
    const status = score >= 5 ? "verified" : score <= -3 ? "hidden" : "unverified";
    const updated = await client.query(
      `UPDATE spots
       SET trust_score = $2, upvote_count = $3, downvote_count = $4, status = $5, updated_at = NOW()
       WHERE id = $1
       RETURNING id, trust_score, upvote_count, downvote_count, status`,
      [spotIdValue, score, tally.rows[0].upvotes, tally.rows[0].downvotes, status],
    );
    return { ...updated.rows[0], viewer_vote: existingAction === action ? null : action };
  });
}

async function migrateDatabase() {
  const migration = await readFile(path.resolve(process.cwd(), "server/db/001_init.sql"), "utf8");
  await pool.query(migration);
}

app.get("/health", async () => {
  await Promise.all([pool.query("SELECT 1"), redis.ping()]);
  return { status: "ok", database: "ok", redis: "ok" };
});

app.get("/api/config", async () => ({
  mapboxToken: process.env.MAPBOX_ACCESS_TOKEN ?? "",
  mapStyle: process.env.MAPBOX_ACCESS_TOKEN
    ? `https://api.mapbox.com/styles/v1/mapbox/light-v11?access_token=${encodeURIComponent(process.env.MAPBOX_ACCESS_TOKEN)}`
    : "https://tiles.openfreemap.org/styles/positron",
}));

app.get("/api/stats", async () => {
  const cacheKey = "stats:spot-count";
  const cached = await redis.get(cacheKey);
  if (cached !== null) return { totalSpots: Number(cached) };

  const result = await pool.query("SELECT COUNT(*)::int AS total FROM spots WHERE status <> 'hidden'");
  const totalSpots = Number(result.rows[0]?.total ?? 0);
  await redis.set(cacheKey, String(totalSpots), "EX", 60);
  return { totalSpots };
});

app.get("/tiles/spots/:z/:x/:y.pbf", async (request, reply) => {
  const params = request.params as { z: string; x: string; y: string };
  const z = Number(params.z);
  const x = Number(params.x);
  const y = Number(params.y);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return reply.code(400).send({ error: "Invalid tile coordinates" });
  }

  const cacheKey = `tile:spots:${z}:${x}:${y}`;
  const cached = await redis.getBuffer(cacheKey);
  if (cached) {
    return reply.header("Content-Type", "application/vnd.mapbox-vector-tile")
      .header("Cache-Control", "public, max-age=600")
      .send(cached);
  }

  const result = await pool.query(
    `WITH tile_bounds AS (
       SELECT ST_TileEnvelope($1, $2, $3) AS geom,
              ST_TileEnvelope($1, $2, $3, margin => 64.0 / 4096.0) AS search_geom
     ), mvt_rows AS (
       SELECT s.id AS feature_id, s.id, s.name, s.type, s.availability, s.hours,
              s.description, s.photo_url, s.trust_score, s.upvote_count, s.downvote_count, s.status,
              (SELECT COUNT(*)::int FROM comments c WHERE c.spot_id = s.id) AS comment_count,
              ST_AsMVTGeom(
                ST_Transform(s.location::geometry, 3857),
                tile_bounds.geom, 4096, 64, true
              ) AS geom
       FROM spots AS s CROSS JOIN tile_bounds
       WHERE s.status <> 'hidden'
         AND s.location && ST_Transform(tile_bounds.search_geom, 4326)::geography
     )
     SELECT ST_AsMVT(mvt_rows, 'spots', 4096, 'geom', 'feature_id') AS tile
     FROM mvt_rows WHERE geom IS NOT NULL`,
    [z, x, y],
  );
  const tile = result.rows[0]?.tile ? Buffer.from(result.rows[0].tile) : Buffer.alloc(0);
  await redis.set(cacheKey, tile, "EX", 600);
  return reply.header("Content-Type", "application/vnd.mapbox-vector-tile")
    .header("Cache-Control", "public, max-age=600")
    .send(tile);
});

app.get("/api/spots/nearby", async (request, reply) => {
  const query = request.query as { lat?: string; lng?: string; radius?: string; filter?: string };
  const lat = numeric(query.lat);
  const lng = numeric(query.lng);
  const radius = numeric(query.radius);
  const filter = query.filter ?? "all";
  if (lat === null || lng === null || radius === null || lat < -90 || lat > 90 || lng < -180 || lng > 180 || radius < 50 || radius > 50000) {
    return reply.code(400).send({ error: "Provide valid lat, lng, and radius in meters (50–50000)." });
  }
  if (!["all", "verified", "unverified", "not-verified"].includes(filter)) {
    return reply.code(400).send({ error: "Invalid filter." });
  }
  const normalizedFilter = filter === "not-verified" ? "unverified" : filter;
  const cacheKey = `nearby:${lat.toFixed(3)}:${lng.toFixed(3)}:${Math.round(radius)}:${normalizedFilter}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const result = await pool.query(
    `SELECT s.id, s.name, s.type, s.availability, s.hours, s.description, s.photo_url, s.photo_urls,
            s.trust_score, s.upvote_count, s.downvote_count, s.status,
            ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
            ST_Distance(s.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters,
            (SELECT COUNT(*)::int FROM comments c WHERE c.spot_id = s.id) AS comment_count,
            s.created_at
     FROM spots s
     WHERE s.status <> 'hidden'
       AND ($4 = 'all' OR s.status = $4)
       AND ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
     ORDER BY distance_meters ASC
     LIMIT 200`,
    [lat, lng, radius, normalizedFilter],
  );
  const response = { spots: result.rows };
  await redis.set(cacheKey, JSON.stringify(response), "EX", 60);
  return response;
});

app.get("/api/spots/:id", async (request, reply) => {
  const id = spotId(request);
  if (!id) return reply.code(400).send({ error: "Invalid spot id" });
  const query = request.query as { clientId?: string };
  const clientId = validClientId(query.clientId);
  const result = await pool.query(
    `SELECT s.id, s.name, s.type, s.availability, s.hours, s.description, s.photo_url, s.photo_urls,
            s.trust_score, s.upvote_count, s.downvote_count, s.status,
            ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
            (SELECT COUNT(*)::int FROM comments c WHERE c.spot_id = s.id) AS comment_count,
            (SELECT i.action FROM spot_interactions i WHERE i.spot_id = s.id AND i.client_id = $2::uuid) AS viewer_vote,
            s.created_at
     FROM spots s WHERE s.id = $1 AND s.status <> 'hidden'`,
    [id, clientId],
  );
  if (!result.rowCount) return reply.code(404).send({ error: "Spot not found" });
  return result.rows[0];
});

app.post("/api/spots", async (request, reply) => {
  const body = record(request.body);
  const type = text(body.type, 40).toLowerCase();
  const name = text(body.name, 100) || type;
  const availability = text(body.availability, 40).toLowerCase() || "idk";
  const hours = text(body.hours, 100) || "Not specified";
  const description = text(body.description, 300);
  const lat = numeric(body.lat);
  const lng = numeric(body.lng);
  if (!name || !allowedTypes.has(type) || !allowedAvailability.has(availability) || lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return reply.code(400).send({ error: "Name, category, availability, and valid coordinates are required." });
  }

  if (body.photoUrls !== undefined && !Array.isArray(body.photoUrls)) {
    return reply.code(400).send({ error: "Upload up to five photos." });
  }
  const submittedPhotoUrls = Array.isArray(body.photoUrls) ? body.photoUrls : body.photoUrl ? [body.photoUrl] : [];
  if (submittedPhotoUrls.length > 5) return reply.code(400).send({ error: "You can add up to five photos per spot." });
  const photoUrls = submittedPhotoUrls.map((url) => text(url, 500)).filter(Boolean);
  if (photoUrls.some((url) => !/^\/api\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/i.test(url))) {
    return reply.code(400).send({ error: "Choose photos uploaded by this app." });
  }
  const photoUrl = photoUrls[0] || "";
  const result = await pool.query(
    `INSERT INTO spots (name, type, availability, hours, description, location, photo_url, photo_urls)
     VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography, $8, $9::jsonb)
     RETURNING id, name, type, availability, hours, description, photo_url, photo_urls,
               trust_score, upvote_count, downvote_count, status, created_at,
               ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng`,
    [name, type, availability, hours, description, lng, lat, photoUrl || null, JSON.stringify(photoUrls)],
  );
  await invalidateSpotCaches();
  return reply.code(201).send(result.rows[0]);
});

app.post("/api/spots/:id/interactions", async (request, reply) => {
  const id = spotId(request);
  const body = record(request.body);
  const clientId = validClientId(body.clientId);
  const action = body.action;
  if (!id || !clientId || !["upvote", "downvote", "flag"].includes(String(action))) {
    return reply.code(400).send({ error: "A spot, device id, and valid action are required." });
  }
  const outcome = await applyInteraction(id, clientId, action as "upvote" | "downvote" | "flag");
  if (!outcome) return reply.code(404).send({ error: "Spot not found" });
  await invalidateSpotCaches();
  return outcome;
});

app.get("/api/spots/:id/comments", async (request, reply) => {
  const id = spotId(request);
  if (!id) return reply.code(400).send({ error: "Invalid spot id" });
  const result = await pool.query(
    "SELECT id, spot_id, content, client_id, created_at FROM comments WHERE spot_id = $1 ORDER BY created_at DESC LIMIT 100",
    [id],
  );
  return {
    comments: result.rows.map(({ client_id: clientId, ...comment }) => ({
      ...comment,
      display_name: commentDisplayName(String(clientId)),
    })),
  };
});

app.post("/api/spots/:id/comments", async (request, reply) => {
  const id = spotId(request);
  const body = record(request.body);
  const clientId = validClientId(body.clientId);
  const content = text(body.content, 300);
  if (!id || !clientId || content.length < 2) return reply.code(400).send({ error: "Comment must be 2–300 characters." });
  if (/\b(fuck|shit|bitch|asshole)\b/i.test(content)) return reply.code(400).send({ error: "Please revise the comment before posting." });
  if ((content.match(/https?:\/\//gi) ?? []).length > 1) return reply.code(400).send({ error: "Comments may contain at most one link." });

  const hash = userIpHash(request);
  const now = Date.now();
  const allowed = await redis.eval(
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
     local count = redis.call('ZCARD', KEYS[1])
     if count >= 3 then return 0 end
     redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
     redis.call('PEXPIRE', KEYS[1], ARGV[4])
     return 1`,
    1,
    `comments:rate:${hash}`,
    String(now - 15 * 60 * 1000),
    String(now),
    randomUUID(),
    String(15 * 60 * 1000),
  );
  if (Number(allowed) !== 1) return reply.code(429).send({ error: "You can post up to 3 comments every 15 minutes." });

  const result = await pool.query(
    `INSERT INTO comments (spot_id, content, user_ip_hash, client_id)
     SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM spots WHERE id = $1 AND status <> 'hidden')
     RETURNING id, spot_id, content, created_at`,
    [id, content, hash, clientId],
  );
  if (!result.rowCount) return reply.code(404).send({ error: "Spot not found" });
  await invalidateSpotCaches();
  return reply.code(201).send(result.rows[0]);
});

app.get("/api/spots/:id/edit-proposals", async (request, reply) => {
  const id = spotId(request);
  if (!id) return reply.code(400).send({ error: "Invalid spot id" });
  const result = await pool.query(
    `SELECT id, spot_id, proposed_data, vote_count, status, created_at, merged_at
     FROM edit_proposals WHERE spot_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [id],
  );
  return { proposals: result.rows };
});

app.post("/api/spots/:id/edit-proposals", async (request, reply) => {
  const id = spotId(request);
  const body = record(request.body);
  const clientId = validClientId(body.clientId);
  if (!id || !clientId) return reply.code(400).send({ error: "Valid spot and device ids are required." });
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && text(body.name, 100)) data.name = text(body.name, 100);
  if (typeof body.type === "string" && allowedTypes.has(text(body.type, 40).toLowerCase())) data.type = text(body.type, 40).toLowerCase();
  if (typeof body.availability === "string" && allowedAvailability.has(text(body.availability, 40).toLowerCase())) data.availability = text(body.availability, 40).toLowerCase();
  if (typeof body.hours === "string") data.hours = text(body.hours, 100);
  if (typeof body.description === "string") data.description = text(body.description, 300);
  const lat = numeric(body.lat);
  const lng = numeric(body.lng);
  if ((lat !== null && (lat < -90 || lat > 90)) || (lng !== null && (lng < -180 || lng > 180)) || ((lat === null) !== (lng === null))) {
    return reply.code(400).send({ error: "Provide both valid coordinates for a location proposal." });
  }
  if (lat !== null && lng !== null) { data.lat = lat; data.lng = lng; }
  if (!Object.keys(data).length) return reply.code(400).send({ error: "Include at least one proposed change." });

  const spot = await pool.query("SELECT id FROM spots WHERE id = $1 AND status <> 'hidden'", [id]);
  if (!spot.rowCount) return reply.code(404).send({ error: "Spot not found" });
  const result = await pool.query(
    `INSERT INTO edit_proposals (spot_id, proposer_id, proposed_data)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, spot_id, proposed_data, vote_count, status, created_at`,
    [id, clientId, JSON.stringify(data)],
  );
  return reply.code(201).send(result.rows[0]);
});

app.post("/api/edit-proposals/:id/votes", async (request, reply) => {
  const params = request.params as { id?: string };
  const proposalId = Number(params.id);
  const body = record(request.body);
  const clientId = validClientId(body.clientId);
  if (!Number.isSafeInteger(proposalId) || proposalId < 1 || !clientId) return reply.code(400).send({ error: "Valid proposal and device ids are required." });

  const outcome = await inTransaction(async (client) => {
    const proposalResult = await client.query(
      "SELECT id, spot_id, proposer_id, proposed_data, status FROM edit_proposals WHERE id = $1 FOR UPDATE",
      [proposalId],
    );
    if (!proposalResult.rowCount) return { missing: true as const };
    const proposal = proposalResult.rows[0];
    if (proposal.status !== "pending") return { proposal };
    if (proposal.proposer_id === clientId) return { ownProposal: true as const };

    await client.query(
      "INSERT INTO edit_proposal_votes (proposal_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [proposalId, clientId],
    );
    const countResult = await client.query("SELECT COUNT(*)::int AS count FROM edit_proposal_votes WHERE proposal_id = $1", [proposalId]);
    const voteCount = Number(countResult.rows[0].count);
    let status = "pending";
    if (voteCount >= 3) {
      const data = proposal.proposed_data as Record<string, unknown>;
      const proposedLat = typeof data.lat === "number" ? data.lat : null;
      const proposedLng = typeof data.lng === "number" ? data.lng : null;
      await client.query(
        `UPDATE spots SET
           name = COALESCE($2, name), type = COALESCE($3, type),
           availability = COALESCE($4, availability), hours = COALESCE($5, hours),
           description = COALESCE($6, description),
           location = CASE WHEN $7::double precision IS NOT NULL AND $8::double precision IS NOT NULL
             THEN ST_SetSRID(ST_MakePoint($8, $7), 4326)::geography ELSE location END,
           updated_at = NOW()
         WHERE id = $1`,
        [proposal.spot_id, data.name ?? null, data.type ?? null, data.availability ?? null, data.hours ?? null, data.description ?? null, proposedLat, proposedLng],
      );
      await client.query("UPDATE edit_proposals SET vote_count = $2, status = 'merged', merged_at = NOW() WHERE id = $1", [proposalId, voteCount]);
      status = "merged";
    } else {
      await client.query("UPDATE edit_proposals SET vote_count = $2 WHERE id = $1", [proposalId, voteCount]);
    }
    return { id: proposalId, spot_id: proposal.spot_id, vote_count: voteCount, status };
  });

  if ("missing" in outcome) return reply.code(404).send({ error: "Proposal not found" });
  if ("ownProposal" in outcome) return reply.code(400).send({ error: "Proposal authors cannot vote on their own suggestion." });
  if (outcome.status === "merged") await invalidateSpotCaches();
  return outcome;
});

app.post("/api/uploads", async (request, reply) => {
  const upload = await request.file();
  if (!upload) return reply.code(400).send({ error: "Choose an image to upload." });
  const typeMap: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  };
  const extension = typeMap[upload.mimetype];
  if (!extension) return reply.code(415).send({ error: "Upload a JPG, PNG, WebP, or GIF image." });
  const bytes = await upload.toBuffer();
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return reply.code(413).send({ error: "Images must be under 8 MB." });
  const key = `${randomUUID()}.${extension}`;
  if (r2Client) {
    await r2Client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: upload.mimetype }));
  } else {
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(path.join(uploadDirectory, key), bytes);
  }
  return reply.code(201).send({ photoUrl: `/api/uploads/${key}` });
});

app.get("/api/uploads/:key", async (request, reply) => {
  const params = request.params as { key: string };
  const key = params.key;
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/i.test(key)) return reply.code(400).send({ error: "Invalid image key" });
  const contentType = ({ jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[key.split(".").at(-1)!];
  if (r2Client) {
    const object = await r2Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await object.Body?.transformToByteArray();
    if (!bytes) return reply.code(404).send({ error: "Image not found" });
    return reply.header("Content-Type", object.ContentType ?? contentType)
      .header("Cache-Control", "public, max-age=86400")
      .send(Buffer.from(bytes));
  }
  try {
    const bytes = await readFile(path.join(uploadDirectory, key));
    return reply.header("Content-Type", contentType).header("Cache-Control", "public, max-age=86400").send(bytes);
  } catch {
    return reply.code(404).send({ error: "Image not found" });
  }
});

await migrateDatabase();
await redis.ping();
await app.listen({ port, host });

const shutdown = async () => {
  await app.close();
  await pool.end();
  await redis.quit();
  if (r2Client) r2Client.destroy();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

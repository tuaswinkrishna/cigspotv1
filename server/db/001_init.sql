CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS spots (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(40) NOT NULL CHECK (type IN ('chai kada', 'scenic pause', 'shop')),
    availability VARCHAR(40) NOT NULL DEFAULT 'idk',
    hours VARCHAR(100) NOT NULL DEFAULT 'Not specified',
    description VARCHAR(300) NOT NULL DEFAULT '',
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    photo_url TEXT,
    trust_score INTEGER NOT NULL DEFAULT 0,
    upvote_count INTEGER NOT NULL DEFAULT 0,
    downvote_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'unverified'
        CHECK (status IN ('unverified', 'verified', 'hidden')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS spots_location_gix ON spots USING GIST (location);
CREATE INDEX IF NOT EXISTS spots_status_idx ON spots (status);
CREATE INDEX IF NOT EXISTS spots_created_at_idx ON spots (created_at DESC);

CREATE TABLE IF NOT EXISTS spot_interactions (
    spot_id BIGINT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
    client_id UUID NOT NULL,
    action VARCHAR(12) NOT NULL CHECK (action IN ('upvote', 'downvote', 'flag')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (spot_id, client_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id BIGSERIAL PRIMARY KEY,
    spot_id BIGINT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
    content VARCHAR(300) NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 300),
    user_ip_hash VARCHAR(64) NOT NULL,
    client_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS comments_spot_created_idx ON comments (spot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS comments_ip_created_idx ON comments (user_ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS edit_proposals (
    id BIGSERIAL PRIMARY KEY,
    spot_id BIGINT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
    proposer_id UUID NOT NULL,
    proposed_data JSONB NOT NULL,
    vote_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(12) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'merged', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    merged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS edit_proposals_spot_created_idx ON edit_proposals (spot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS edit_proposal_votes (
    proposal_id BIGINT NOT NULL REFERENCES edit_proposals(id) ON DELETE CASCADE,
    client_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (proposal_id, client_id)
);

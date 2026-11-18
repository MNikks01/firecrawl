-- Teams own keys, credits and jobs. Credits are counted per calendar month (UTC).
create table teams (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  monthly_credits  bigint check (monthly_credits >= 0),       -- null = unlimited
  rate_multiplier  numeric not null default 1 check (rate_multiplier > 0),
  created_at       timestamptz not null default now()
);

-- A key is `fcgw_<id>_<secret>`. Only sha256(secret) is stored.
create table api_keys (
  id            text primary key,
  team_id       uuid not null references teams(id) on delete cascade,
  name          text not null,
  secret_hash   bytea not null,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);
create index api_keys_team on api_keys(team_id);

-- One row per team per month. `reserved` holds credits for requests in flight.
create table credit_periods (
  team_id       uuid not null references teams(id) on delete cascade,
  period_start  date not null,
  used          bigint not null default 0,
  reserved      bigint not null default 0 check (reserved >= 0),
  primary key (team_id, period_start)
);

-- In-flight holds. The sweeper releases rows past expires_at (gateway crashed mid-request).
create table reservations (
  id            uuid primary key,
  team_id       uuid not null references teams(id) on delete cascade,
  period_start  date not null,
  credits       bigint not null,
  expires_at    timestamptz not null
);
create index reservations_expiry on reservations(expires_at);

-- Append-only usage ledger. idempotency_key makes every charge apply at most once.
create table usage_events (
  id               bigserial primary key,
  idempotency_key  text not null unique,
  team_id          uuid not null references teams(id) on delete cascade,
  key_id           text,
  endpoint         text not null,
  credits          bigint not null,
  upstream_status  int,
  job_id           text,
  created_at       timestamptz not null default now()
);
create index usage_events_team_time on usage_events(team_id, created_at);

-- Async jobs created through the gateway: who owns them, and how far billing has read.
-- Billing reads the job's completed documents in Firecrawl's order (finished_at, created_at, id)
-- with a skip cursor, and charges each document's own creditsUsed once (keyed by scrapeId).
create table jobs (
  id                text primary key,
  kind              text not null check (kind in ('crawl', 'batch_scrape')),
  team_id           uuid not null references teams(id) on delete cascade,
  key_id            text,
  per_page_credits  int not null,            -- fallback when a document carries no creditsUsed
  doc_cursor        int not null default 0,  -- documents read so far (?skip=)
  billed_docs       int not null default 0,  -- distinct documents charged
  billed_credits    bigint not null default 0,
  rescanned         boolean not null default false,
  status            text not null default 'open' check (status in ('open', 'closed')),
  close_reason      text,
  next_check_at     timestamptz not null default now(),
  failures          int not null default 0,
  created_at        timestamptz not null default now(),
  closed_at         timestamptz
);
create index jobs_due on jobs(next_check_at) where status = 'open';
create index jobs_team on jobs(team_id);

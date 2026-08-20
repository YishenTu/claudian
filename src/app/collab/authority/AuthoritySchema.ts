import { COLLAB_LIMITS } from '@claudian/collab-protocol';
import type { Database, SqlValue } from 'sql.js';

import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

const AUTHORITY_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS members (
    member_id TEXT PRIMARY KEY CHECK(
      length(member_id) BETWEEN 1 AND 64
      AND substr(member_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND member_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
    personal_ref TEXT NOT NULL UNIQUE
      CHECK(personal_ref = 'refs/heads/members/' || member_id),
    role TEXT NOT NULL CHECK(role IN ('manager', 'member')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'revoked', 'left')),
    credential_hash BLOB NOT NULL CHECK(length(credential_hash) = 32),
    join_attempt_id TEXT UNIQUE,
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    activated_at TEXT,
    revoked_at TEXT,
    CHECK(role != 'manager' OR status = 'active'),
    CHECK(
      (status = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
      OR (status = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
      OR (status IN ('revoked', 'left') AND revoked_at IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS members_one_active_manager
    ON members(role)
    WHERE role = 'manager' AND status = 'active';

  CREATE TABLE IF NOT EXISTS project (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    project_id TEXT NOT NULL UNIQUE CHECK(
      length(project_id) BETWEEN 1 AND 64
      AND substr(project_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND project_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    state TEXT NOT NULL CHECK(state IN ('active', 'disabled')),
    host_member_id TEXT NOT NULL REFERENCES members(member_id)
      DEFERRABLE INITIALLY DEFERRED,
    manager_member_id TEXT NOT NULL REFERENCES members(member_id)
      DEFERRABLE INITIALLY DEFERRED,
    manager_generation INTEGER NOT NULL DEFAULT 0 CHECK(
      typeof(manager_generation) = 'integer' AND manager_generation >= 0
    ),
    main_ref TEXT NOT NULL CHECK(main_ref = 'refs/heads/main'),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    snapshot_generation INTEGER NOT NULL DEFAULT 0
      CHECK(snapshot_generation >= 0)
  );

  CREATE TABLE IF NOT EXISTS invitations (
    invitation_id TEXT PRIMARY KEY,
    token_hash BLOB NOT NULL CHECK(length(token_hash) = 32),
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_by_member_id TEXT NOT NULL REFERENCES members(member_id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS change_requests (
    request_id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(member_id),
    status TEXT NOT NULL CHECK(status IN ('open', 'merged', 'discarded')),
    first_base_oid TEXT NOT NULL CHECK(
      length(first_base_oid) IN (40, 64)
      AND first_base_oid NOT GLOB '*[^0-9a-f]*'
    ),
    latest_head_oid TEXT NOT NULL CHECK(
      length(latest_head_oid) IN (40, 64)
      AND latest_head_oid NOT GLOB '*[^0-9a-f]*'
    ),
    merged_oid TEXT CHECK(
      merged_oid IS NULL
      OR (
        length(merged_oid) IN (40, 64)
        AND merged_oid NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(
      (status = 'merged' AND merged_oid IS NOT NULL)
      OR (status IN ('open', 'discarded') AND merged_oid IS NULL)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS change_requests_one_open_per_member
    ON change_requests(member_id)
    WHERE status = 'open';

  CREATE TRIGGER IF NOT EXISTS change_requests_terminal_update
    BEFORE UPDATE ON change_requests
    WHEN OLD.status IN ('merged', 'discarded')
    BEGIN
      SELECT RAISE(ABORT, 'terminal change request is immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS change_requests_terminal_delete
    BEFORE DELETE ON change_requests
    WHEN OLD.status IN ('merged', 'discarded')
    BEGIN
      SELECT RAISE(ABORT, 'terminal change request is immutable');
    END;

  CREATE TABLE IF NOT EXISTS comments (
    comment_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES change_requests(request_id),
    author_member_id TEXT NOT NULL REFERENCES members(member_id),
    body TEXT NOT NULL CHECK(length(body) > 0),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accept_operations (
    operation_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES change_requests(request_id),
    expected_main_oid TEXT NOT NULL CHECK(length(expected_main_oid) IN (40, 64)),
    expected_head_oid TEXT NOT NULL CHECK(length(expected_head_oid) IN (40, 64)),
    result_commit_oid TEXT CHECK(
      result_commit_oid IS NULL OR length(result_commit_oid) IN (40, 64)
    ),
    state TEXT NOT NULL CHECK(state IN ('prepared', 'ref_updated', 'completed')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(
      (state = 'prepared' AND result_commit_oid IS NULL)
      OR (state IN ('ref_updated', 'completed') AND result_commit_oid IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS idempotency_results (
    actor_member_id TEXT NOT NULL REFERENCES members(member_id),
    operation_kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK(
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    response_json TEXT NOT NULL CHECK(json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(actor_member_id, operation_kind, idempotency_key)
  );

  CREATE TRIGGER IF NOT EXISTS idempotency_results_immutable_update
    BEFORE UPDATE ON idempotency_results
    BEGIN
      SELECT RAISE(ABORT, 'idempotency result is immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS idempotency_results_immutable_delete
    BEFORE DELETE ON idempotency_results
    BEGIN
      SELECT RAISE(ABORT, 'idempotency result is immutable');
    END;

  CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 100),
    actor_member_id TEXT REFERENCES members(member_id),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS events_immutable_update
    BEFORE UPDATE ON events
    BEGIN
      SELECT RAISE(ABORT, 'authority event is immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS events_immutable_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'authority event is immutable');
    END;
`;

const AUTHORITY_SCHEMA_V3_REQUEST_COLUMNS = [
  'description',
  'revision',
] as const;

const AUTHORITY_SCHEMA_V3_ACCEPT_COLUMNS = [
  'expected_request_revision',
  'expected_resolving_tickets_json',
] as const;

const AUTHORITY_SCHEMA_V3_TABLES = [
  'tickets',
  'ticket_comments',
  'request_ticket_relations',
] as const;

const AUTHORITY_SCHEMA_V3_COLUMNS = `
  ALTER TABLE change_requests ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE change_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision) = 'integer' AND revision >= 0);
  ALTER TABLE accept_operations ADD COLUMN expected_request_revision INTEGER
    NOT NULL DEFAULT 0 CHECK(
      typeof(expected_request_revision) = 'integer'
      AND expected_request_revision >= 0
    );
  ALTER TABLE accept_operations ADD COLUMN expected_resolving_tickets_json TEXT
    NOT NULL DEFAULT '[]' CHECK(json_valid(expected_resolving_tickets_json));
`;

const AUTHORITY_SCHEMA_V3_TABLES_SQL = `
  CREATE TABLE tickets (
    ticket_number INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL UNIQUE CHECK(
      length(ticket_id) BETWEEN 1 AND 128
      AND substr(ticket_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND ticket_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND ${CLAUDIAN_COLLAB_LIMITS.maxTicketTitleUtf16}),
    body TEXT NOT NULL CHECK(length(body) > 0),
    status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
    author_member_id TEXT NOT NULL REFERENCES members(member_id),
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
    comment_count INTEGER NOT NULL DEFAULT 0 CHECK(
      typeof(comment_count) = 'integer' AND comment_count >= 0
    ),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK(length(updated_at) > 0),
    closed_at TEXT,
    closed_by_member_id TEXT REFERENCES members(member_id),
    CHECK(
      (status = 'open' AND closed_at IS NULL AND closed_by_member_id IS NULL)
      OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by_member_id IS NOT NULL)
    )
  );

  CREATE INDEX tickets_status_updated
    ON tickets(status, updated_at DESC, ticket_number DESC);

  CREATE TABLE ticket_comments (
    comment_id TEXT PRIMARY KEY CHECK(
      length(comment_id) BETWEEN 1 AND 128
      AND substr(comment_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND comment_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
    author_member_id TEXT NOT NULL REFERENCES members(member_id),
    body TEXT NOT NULL CHECK(length(body) > 0),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0)
  );

  CREATE INDEX ticket_comments_ticket_created
    ON ticket_comments(ticket_id, created_at, comment_id);

  CREATE TRIGGER ticket_comments_immutable_update
    BEFORE UPDATE ON ticket_comments
    BEGIN
      SELECT RAISE(ABORT, 'ticket comment is immutable');
    END;

  CREATE TRIGGER ticket_comments_immutable_delete
    BEFORE DELETE ON ticket_comments
    BEGIN
      SELECT RAISE(ABORT, 'ticket comment is immutable');
    END;

  CREATE TABLE request_ticket_relations (
    relation_id TEXT PRIMARY KEY CHECK(
      length(relation_id) BETWEEN 1 AND 128
      AND substr(relation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND relation_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    request_id TEXT NOT NULL REFERENCES change_requests(request_id),
    ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
    commit_oid TEXT NOT NULL CHECK(
      length(commit_oid) IN (40, 64)
      AND commit_oid NOT GLOB '*[^0-9a-f]*'
    ),
    kind TEXT NOT NULL CHECK(kind IN ('references', 'resolves')),
    state TEXT NOT NULL CHECK(state IN ('pending', 'accepted')),
    created_by_member_id TEXT NOT NULL REFERENCES members(member_id),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK(length(updated_at) > 0),
    accepted_at TEXT,
    accepted_merge_oid TEXT CHECK(
      accepted_merge_oid IS NULL
      OR (
        length(accepted_merge_oid) IN (40, 64)
        AND accepted_merge_oid NOT GLOB '*[^0-9a-f]*'
      )
    ),
    UNIQUE(request_id, ticket_id),
    CHECK(
      (state = 'pending' AND accepted_at IS NULL AND accepted_merge_oid IS NULL)
      OR (state = 'accepted' AND accepted_at IS NOT NULL AND accepted_merge_oid IS NOT NULL)
    )
  );

  CREATE INDEX request_ticket_relations_ticket_state
    ON request_ticket_relations(ticket_id, state, updated_at DESC);

  CREATE TRIGGER request_ticket_relations_accepted_update
    BEFORE UPDATE ON request_ticket_relations
    WHEN OLD.state = 'accepted'
    BEGIN
      SELECT RAISE(ABORT, 'accepted ticket relation is immutable');
    END;

  CREATE TRIGGER request_ticket_relations_accepted_delete
    BEFORE DELETE ON request_ticket_relations
    WHEN OLD.state = 'accepted'
    BEGIN
      SELECT RAISE(ABORT, 'accepted ticket relation is immutable');
    END;

  CREATE TRIGGER request_ticket_relations_terminal_update
    BEFORE UPDATE ON request_ticket_relations
    WHEN (
      SELECT status FROM change_requests WHERE request_id = OLD.request_id
    ) != 'open'
    BEGIN
      SELECT RAISE(ABORT, 'terminal request ticket relation is immutable');
    END;

  CREATE TRIGGER request_ticket_relations_terminal_delete
    BEFORE DELETE ON request_ticket_relations
    WHEN (
      SELECT status FROM change_requests WHERE request_id = OLD.request_id
    ) != 'open'
    BEGIN
      SELECT RAISE(ABORT, 'terminal request ticket relation is immutable');
    END;
`;

const AUTHORITY_SCHEMA_V4_TABLE_SQL = `
  CREATE TABLE ticket_mentions (
    ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
    mentioned_member_id TEXT NOT NULL REFERENCES members(member_id),
    source_kind TEXT NOT NULL CHECK(source_kind IN ('description', 'comment')),
    source_id TEXT NOT NULL CHECK(
      length(source_id) BETWEEN 1 AND 128
      AND substr(source_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND source_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    PRIMARY KEY(ticket_id, source_kind, source_id, mentioned_member_id),
    CHECK(source_kind != 'description' OR source_id = ticket_id)
  );

  CREATE INDEX ticket_mentions_member_created
    ON ticket_mentions(mentioned_member_id, created_at, ticket_id);
`;

const AUTHORITY_SCHEMA_V7_COMMENTS = `
  CREATE TABLE comments_v7 (
    comment_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES change_requests(request_id),
    author_member_id TEXT NOT NULL REFERENCES members(member_id),
    body TEXT NOT NULL CHECK(length(body) > 0),
    created_at TEXT NOT NULL
  );
`;

const AUTHORITY_SCHEMA_V8_TABLES = [
  'manager_responsibility_offers',
  'host_transfer_operations',
  'host_transition_proofs',
  'project_terminal_transitions',
] as const;

const AUTHORITY_SCHEMA_V8_SQL = `
  CREATE TABLE manager_responsibility_offers (
    offer_id TEXT PRIMARY KEY CHECK(
      length(offer_id) BETWEEN 1 AND 128
      AND substr(offer_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND offer_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    purpose TEXT NOT NULL CHECK(purpose IN ('manager-transfer', 'manager-leave')),
    source_manager_member_id TEXT NOT NULL REFERENCES members(member_id),
    source_manager_generation INTEGER NOT NULL CHECK(
      typeof(source_manager_generation) = 'integer'
      AND source_manager_generation >= 0
    ),
    target_member_id TEXT NOT NULL REFERENCES members(member_id),
    status TEXT NOT NULL CHECK(status IN (
      'offered', 'acknowledged', 'consumed', 'declined', 'cancelled', 'expired'
    )),
    offered_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    acknowledged_at TEXT,
    consumed_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(source_manager_member_id != target_member_id),
    CHECK(expires_at > offered_at),
    CHECK(
      (status = 'offered' AND acknowledged_at IS NULL AND consumed_at IS NULL)
      OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND consumed_at IS NULL)
      OR (status = 'consumed' AND acknowledged_at IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status IN ('declined', 'cancelled', 'expired') AND consumed_at IS NULL)
    )
  );

  CREATE UNIQUE INDEX manager_responsibility_one_nonterminal
    ON manager_responsibility_offers((1))
    WHERE status IN ('offered', 'acknowledged');

  CREATE TABLE host_transfer_operations (
    transfer_id TEXT PRIMARY KEY CHECK(
      length(transfer_id) BETWEEN 1 AND 128
      AND substr(transfer_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND transfer_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    source_host_member_id TEXT NOT NULL REFERENCES members(member_id),
    target_host_member_id TEXT NOT NULL REFERENCES members(member_id),
    phase TEXT NOT NULL CHECK(phase IN (
      'offered', 'accepted', 'quiescing', 'staged', 'authority-relinquished',
      'target-active', 'completed', 'cancelled', 'declined', 'expired'
    )),
    offered_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    target_endpoint TEXT,
    target_ca_certificate_pem TEXT CHECK(
      target_ca_certificate_pem IS NULL
      OR (length(target_ca_certificate_pem) BETWEEN 1 AND 65536
        AND instr(target_ca_certificate_pem, 'PRIVATE KEY') = 0)
    ),
    target_ca_fingerprint TEXT CHECK(
      target_ca_fingerprint IS NULL
      OR (length(target_ca_fingerprint) = 64
        AND target_ca_fingerprint NOT GLOB '*[^0-9a-f]*')
    ),
    receiver_credential TEXT CHECK(
      receiver_credential IS NULL
      OR (length(receiver_credential) = 43
        AND receiver_credential NOT GLOB '*[^A-Za-z0-9_-]*')
    ),
    manifest_digest TEXT CHECK(
      manifest_digest IS NULL
      OR (length(manifest_digest) = 64
        AND manifest_digest NOT GLOB '*[^0-9a-f]*')
    ),
    activation_certificate TEXT CHECK(
      activation_certificate IS NULL OR length(activation_certificate) BETWEEN 1 AND 65536
    ),
    updated_at TEXT NOT NULL,
    CHECK(source_host_member_id != target_host_member_id),
    CHECK(expires_at > offered_at)
  );

  CREATE UNIQUE INDEX host_transfer_one_nonterminal
    ON host_transfer_operations((1))
    WHERE phase IN (
      'offered', 'accepted', 'quiescing', 'staged',
      'authority-relinquished', 'target-active'
    );

  CREATE TABLE host_transition_proofs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id TEXT NOT NULL UNIQUE REFERENCES host_transfer_operations(transfer_id),
    source_host_member_id TEXT NOT NULL REFERENCES members(member_id),
    target_host_member_id TEXT NOT NULL REFERENCES members(member_id),
    previous_ca_fingerprint TEXT NOT NULL CHECK(
      length(previous_ca_fingerprint) = 64
      AND previous_ca_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    next_ca_certificate_pem TEXT NOT NULL CHECK(
      length(next_ca_certificate_pem) BETWEEN 1 AND 65536
      AND instr(next_ca_certificate_pem, 'PRIVATE KEY') = 0
    ),
    next_ca_fingerprint TEXT NOT NULL CHECK(
      length(next_ca_fingerprint) = 64
      AND next_ca_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    issued_at TEXT NOT NULL,
    signature_algorithm TEXT NOT NULL CHECK(signature_algorithm = 'rsa-pss-sha256'),
    signature TEXT NOT NULL CHECK(
      length(signature) BETWEEN 64 AND 2048
      AND signature NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    CHECK(source_host_member_id != target_host_member_id),
    CHECK(previous_ca_fingerprint != next_ca_fingerprint)
  );

  CREATE TABLE project_terminal_transitions (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    operation_id TEXT NOT NULL UNIQUE CHECK(
      length(operation_id) BETWEEN 1 AND 128
      AND substr(operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND operation_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    kind TEXT NOT NULL CHECK(kind = 'retire'),
    actor_member_id TEXT NOT NULL REFERENCES members(member_id),
    idempotency_key TEXT NOT NULL CHECK(
      length(idempotency_key) BETWEEN 1 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    request_fingerprint TEXT NOT NULL CHECK(
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    phase TEXT NOT NULL CHECK(phase IN ('quiescing', 'tombstone-committed')),
    retired_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(
      (phase = 'quiescing' AND retired_at IS NULL)
      OR (phase = 'tombstone-committed' AND retired_at IS NOT NULL)
    )
  );
`;

const AUTHORITY_SCHEMA_V9_PROJECT_SQL = `
  CREATE TABLE project_v9 (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    project_id TEXT NOT NULL UNIQUE CHECK(
      length(project_id) BETWEEN 1 AND 64
      AND substr(project_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND project_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    state TEXT NOT NULL CHECK(state IN ('active', 'disabled')),
    host_member_id TEXT NOT NULL REFERENCES members(member_id)
      DEFERRABLE INITIALLY DEFERRED,
    manager_set_generation INTEGER NOT NULL DEFAULT 0 CHECK(
      typeof(manager_set_generation) = 'integer' AND manager_set_generation >= 0
    ),
    main_ref TEXT NOT NULL CHECK(main_ref = 'refs/heads/main'),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    snapshot_generation INTEGER NOT NULL DEFAULT 0
      CHECK(snapshot_generation >= 0)
  );
`;

const AUTHORITY_SCHEMA_V9_ACCEPT_SQL = `
  CREATE TABLE accept_operations_v9 (
    operation_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES change_requests(request_id),
    expected_main_oid TEXT NOT NULL CHECK(length(expected_main_oid) IN (40, 64)),
    expected_head_oid TEXT NOT NULL CHECK(length(expected_head_oid) IN (40, 64)),
    result_commit_oid TEXT CHECK(
      result_commit_oid IS NULL OR length(result_commit_oid) IN (40, 64)
    ),
    state TEXT NOT NULL CHECK(state IN ('prepared', 'ref_updated', 'completed')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expected_request_revision INTEGER NOT NULL DEFAULT 0 CHECK(
      typeof(expected_request_revision) = 'integer'
      AND expected_request_revision >= 0
    ),
    expected_resolving_tickets_json TEXT NOT NULL DEFAULT '[]'
      CHECK(json_valid(expected_resolving_tickets_json)),
    completion_actor_member_id TEXT REFERENCES members(member_id),
    CHECK(
      (state = 'prepared' AND result_commit_oid IS NULL)
      OR (state IN ('ref_updated', 'completed') AND result_commit_oid IS NOT NULL)
    ),
    CHECK(state = 'completed' OR completion_actor_member_id IS NOT NULL)
  );
`;

const AUTHORITY_SCHEMA_V9_MANAGER_RESPONSIBILITY_SQL = `
  CREATE TABLE manager_responsibility_offers_v9 (
    offer_id TEXT PRIMARY KEY CHECK(
      length(offer_id) BETWEEN 1 AND 128
      AND substr(offer_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND offer_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    purpose TEXT NOT NULL CHECK(purpose IN ('manager-promotion', 'manager-leave')),
    source_manager_member_id TEXT NOT NULL REFERENCES members(member_id),
    source_manager_generation INTEGER NOT NULL CHECK(
      typeof(source_manager_generation) = 'integer'
      AND source_manager_generation >= 0
    ),
    target_member_id TEXT NOT NULL REFERENCES members(member_id),
    status TEXT NOT NULL CHECK(status IN (
      'offered', 'acknowledged', 'consumed', 'declined', 'cancelled', 'expired'
    )),
    offered_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    acknowledged_at TEXT,
    consumed_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(source_manager_member_id != target_member_id),
    CHECK(expires_at > offered_at),
    CHECK(
      (status = 'offered' AND acknowledged_at IS NULL AND consumed_at IS NULL)
      OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND consumed_at IS NULL)
      OR (status = 'consumed' AND acknowledged_at IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status IN ('declined', 'cancelled', 'expired') AND consumed_at IS NULL)
    )
  );
`;

const AUTHORITY_SCHEMA_V10_MANAGER_RESPONSIBILITY_SQL = `
  CREATE TABLE manager_responsibility_offers_v10 (
    offer_id TEXT PRIMARY KEY CHECK(
      length(offer_id) BETWEEN 1 AND 128
      AND substr(offer_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND offer_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    purpose TEXT NOT NULL CHECK(purpose IN ('manager-promotion', 'manager-leave')),
    source_manager_member_id TEXT NOT NULL REFERENCES members(member_id),
    target_member_id TEXT NOT NULL REFERENCES members(member_id),
    status TEXT NOT NULL CHECK(status IN (
      'offered', 'acknowledged', 'consumed', 'declined', 'cancelled', 'expired'
    )),
    offered_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    acknowledged_at TEXT,
    consumed_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK(source_manager_member_id != target_member_id),
    CHECK(expires_at > offered_at),
    CHECK(
      (status = 'offered' AND acknowledged_at IS NULL AND consumed_at IS NULL)
      OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND consumed_at IS NULL)
      OR (status = 'consumed' AND acknowledged_at IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status IN ('declined', 'cancelled', 'expired') AND consumed_at IS NULL)
    )
  );
`;

const AUTHORITY_SCHEMA_V11_FINITE_COLLECTION_TRIGGERS = `
  CREATE TRIGGER comments_request_capacity_insert
    BEFORE INSERT ON comments
    WHEN (
      SELECT COUNT(*) FROM comments WHERE request_id = NEW.request_id
    ) >= ${COLLAB_LIMITS.maxRequestComments}
    BEGIN
      SELECT RAISE(ABORT, 'request comment capacity exceeded');
    END;

  CREATE TRIGGER request_ticket_relations_accepted_capacity_insert
    BEFORE INSERT ON request_ticket_relations
    WHEN NEW.state = 'accepted' AND (
      SELECT COUNT(*) FROM request_ticket_relations
      WHERE ticket_id = NEW.ticket_id AND state = 'accepted'
    ) >= ${COLLAB_LIMITS.maxTicketAcceptedRelations}
    BEGIN
      SELECT RAISE(ABORT, 'accepted ticket relation capacity exceeded');
    END;

  CREATE TRIGGER request_ticket_relations_accepted_capacity_update
    BEFORE UPDATE OF state ON request_ticket_relations
    WHEN OLD.state = 'pending' AND NEW.state = 'accepted' AND (
      SELECT COUNT(*) FROM request_ticket_relations
      WHERE ticket_id = NEW.ticket_id AND state = 'accepted'
    ) >= ${COLLAB_LIMITS.maxTicketAcceptedRelations}
    BEGIN
      SELECT RAISE(ABORT, 'accepted ticket relation capacity exceeded');
    END;
`;

function pragmaNumber(database: Database, pragma: string): number {
  const result = database.exec(pragma);
  const value = result[0]?.values[0]?.[0];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('Authority pragma did not return an integer');
  }
  return value;
}

function firstColumn(database: Database, sql: string): readonly SqlValue[] {
  const result = database.exec(sql);
  return result.flatMap(entry => entry.values.map(row => row[0] ?? null));
}

function tableColumns(database: Database, table: string): ReadonlySet<SqlValue> {
  const result = database.exec(`PRAGMA table_info(${table})`);
  return new Set(result.flatMap(entry => entry.values.map(row => row[1] ?? null)));
}

function tableExists(database: Database, table: string): boolean {
  return firstColumn(database, `
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'
  `).length === 1;
}

function indexExists(database: Database, index: string): boolean {
  return firstColumn(database, `
    SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${index}'
  `).length === 1;
}

function schemaSql(
  database: Database,
  type: 'index' | 'table' | 'trigger',
  name: string,
): string | null {
  const value = firstColumn(database, `
    SELECT sql FROM sqlite_master WHERE type = '${type}' AND name = '${name}'
  `)[0];
  return typeof value === 'string' ? value : null;
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/["`[\]]/g, '')
    .replace(/[\s;]/g, '');
}

function hasExactSchemaSql(
  database: Database,
  type: 'index' | 'table' | 'trigger',
  name: string,
  expected: string,
): boolean {
  const actual = schemaSql(database, type, name);
  return actual !== null && normalizeSchemaSql(actual) === normalizeSchemaSql(expected);
}

function hasExactMemberUniqueIndexes(database: Database): boolean {
  const expected = new Set([
    'pk:0:member_id',
    'u:0:join_attempt_id',
    'u:0:personal_ref',
  ]);
  const actual = new Set<string>();
  const indexes = database.exec('PRAGMA index_list(members)');
  for (const result of indexes) {
    for (const row of result.values) {
      const name = row[1];
      const unique = row[2];
      const origin = row[3];
      const partial = row[4];
      if (unique !== 1) continue;
      if (
        typeof name !== 'string'
        || typeof origin !== 'string'
        || (partial !== 0 && partial !== 1)
      ) return false;
      const escapedName = name.replaceAll("'", "''");
      const columns = database.exec(`PRAGMA index_info('${escapedName}')`)
        .flatMap(entry => entry.values.map(column => column[2] ?? null));
      if (columns.length !== 1 || typeof columns[0] !== 'string') return false;
      actual.add(`${origin}:${partial}:${columns[0]}`);
    }
  }
  return actual.size === expected.size && [...expected].every(index => actual.has(index));
}

function hasExactColumns(
  database: Database,
  table: string,
  expected: readonly string[],
): boolean {
  const actual = tableColumns(database, table);
  return actual.size === expected.length && expected.every(column => actual.has(column));
}

function authorityV9SchemaIsComplete(database: Database): boolean {
  return hasExactColumns(database, 'project', [
    'singleton',
    'project_id',
    'name',
    'state',
    'host_member_id',
    'manager_set_generation',
    'main_ref',
    'created_at',
    'snapshot_generation',
  ])
    && hasExactColumns(database, 'accept_operations', [
      'operation_id',
      'request_id',
      'expected_main_oid',
      'expected_head_oid',
      'result_commit_oid',
      'state',
      'idempotency_key',
      'created_at',
      'updated_at',
      'expected_request_revision',
      'expected_resolving_tickets_json',
      'completion_actor_member_id',
    ])
    && hasExactColumns(database, 'manager_responsibility_offers', [
      'offer_id',
      'purpose',
      'source_manager_member_id',
      'source_manager_generation',
      'target_member_id',
      'status',
      'offered_at',
      'expires_at',
      'acknowledged_at',
      'consumed_at',
      'updated_at',
    ])
    && hasExactSchemaSql(
      database,
      'table',
      'project',
      AUTHORITY_SCHEMA_V9_PROJECT_SQL.replace('project_v9', 'project'),
    )
    && hasExactSchemaSql(
      database,
      'table',
      'accept_operations',
      AUTHORITY_SCHEMA_V9_ACCEPT_SQL.replace('accept_operations_v9', 'accept_operations'),
    )
    && hasExactSchemaSql(
      database,
      'table',
      'manager_responsibility_offers',
      AUTHORITY_SCHEMA_V9_MANAGER_RESPONSIBILITY_SQL.replace(
        'manager_responsibility_offers_v9',
        'manager_responsibility_offers',
      ),
    )
    && hasExactSchemaSql(
      database,
      'index',
      'manager_responsibility_one_nonterminal',
      `
        CREATE UNIQUE INDEX manager_responsibility_one_nonterminal
        ON manager_responsibility_offers((1))
        WHERE status IN ('offered', 'acknowledged')
      `,
    )
    && hasExactMemberUniqueIndexes(database);
}

function repairAndAssertAuthorityV9Schema(database: Database): boolean {
  const repaired = indexExists(database, 'members_one_active_manager');
  if (repaired) database.run('DROP INDEX members_one_active_manager');
  if (!authorityV9SchemaIsComplete(database)) {
    throw new Error('Authority V9 Manager schema is incomplete');
  }
  return repaired;
}

function authorityV10SchemaIsComplete(database: Database): boolean {
  return hasExactColumns(database, 'manager_responsibility_offers', [
    'offer_id',
    'purpose',
    'source_manager_member_id',
    'target_member_id',
    'status',
    'offered_at',
    'expires_at',
    'acknowledged_at',
    'consumed_at',
    'updated_at',
  ])
    && hasExactSchemaSql(
      database,
      'table',
      'manager_responsibility_offers',
      AUTHORITY_SCHEMA_V10_MANAGER_RESPONSIBILITY_SQL.replace(
        'manager_responsibility_offers_v10',
        'manager_responsibility_offers',
      ),
    )
    && hasExactSchemaSql(
      database,
      'index',
      'manager_responsibility_one_nonterminal_source',
      `
        CREATE UNIQUE INDEX manager_responsibility_one_nonterminal_source
        ON manager_responsibility_offers(source_manager_member_id)
        WHERE status IN ('offered', 'acknowledged')
      `,
    )
    && hasExactSchemaSql(
      database,
      'index',
      'manager_responsibility_one_nonterminal_target',
      `
        CREATE UNIQUE INDEX manager_responsibility_one_nonterminal_target
        ON manager_responsibility_offers(target_member_id)
        WHERE status IN ('offered', 'acknowledged')
      `,
    )
    && !indexExists(database, 'manager_responsibility_one_nonterminal')
    && authorityV9SchemaIsCompleteExceptManagerResponsibilities(database);
}

function authorityV9SchemaIsCompleteExceptManagerResponsibilities(database: Database): boolean {
  return hasExactColumns(database, 'project', [
    'singleton',
    'project_id',
    'name',
    'state',
    'host_member_id',
    'manager_set_generation',
    'main_ref',
    'created_at',
    'snapshot_generation',
  ])
    && hasExactColumns(database, 'accept_operations', [
      'operation_id',
      'request_id',
      'expected_main_oid',
      'expected_head_oid',
      'result_commit_oid',
      'state',
      'idempotency_key',
      'created_at',
      'updated_at',
      'expected_request_revision',
      'expected_resolving_tickets_json',
      'completion_actor_member_id',
    ])
    && hasExactSchemaSql(
      database,
      'table',
      'project',
      AUTHORITY_SCHEMA_V9_PROJECT_SQL.replace('project_v9', 'project'),
    )
    && hasExactSchemaSql(
      database,
      'table',
      'accept_operations',
      AUTHORITY_SCHEMA_V9_ACCEPT_SQL.replace('accept_operations_v9', 'accept_operations'),
    )
    && hasExactMemberUniqueIndexes(database);
}

function repairAndAssertAuthorityV10Schema(database: Database): boolean {
  const repaired = indexExists(database, 'members_one_active_manager');
  if (repaired) database.run('DROP INDEX members_one_active_manager');
  if (!authorityV10SchemaIsComplete(database)) {
    throw new Error('Authority V10 Manager schema is incomplete');
  }
  return repaired;
}

function finiteCollectionCapacityIsValid(database: Database): boolean {
  return firstColumn(database, `
    SELECT request_id
    FROM comments
    GROUP BY request_id
    HAVING COUNT(*) > ${COLLAB_LIMITS.maxRequestComments}
    LIMIT 1
  `).length === 0
    && firstColumn(database, `
      SELECT ticket_id
      FROM request_ticket_relations
      WHERE state = 'accepted'
      GROUP BY ticket_id
      HAVING COUNT(*) > ${COLLAB_LIMITS.maxTicketAcceptedRelations}
      LIMIT 1
    `).length === 0;
}

function authorityV11SchemaIsComplete(database: Database): boolean {
  return authorityV10SchemaIsComplete(database)
    && hasExactSchemaSql(
      database,
      'trigger',
      'comments_request_capacity_insert',
      `
        CREATE TRIGGER comments_request_capacity_insert
        BEFORE INSERT ON comments
        WHEN (
          SELECT COUNT(*) FROM comments WHERE request_id = NEW.request_id
        ) >= ${COLLAB_LIMITS.maxRequestComments}
        BEGIN
          SELECT RAISE(ABORT, 'request comment capacity exceeded');
        END
      `,
    )
    && hasExactSchemaSql(
      database,
      'trigger',
      'request_ticket_relations_accepted_capacity_insert',
      `
        CREATE TRIGGER request_ticket_relations_accepted_capacity_insert
        BEFORE INSERT ON request_ticket_relations
        WHEN NEW.state = 'accepted' AND (
          SELECT COUNT(*) FROM request_ticket_relations
          WHERE ticket_id = NEW.ticket_id AND state = 'accepted'
        ) >= ${COLLAB_LIMITS.maxTicketAcceptedRelations}
        BEGIN
          SELECT RAISE(ABORT, 'accepted ticket relation capacity exceeded');
        END
      `,
    )
    && hasExactSchemaSql(
      database,
      'trigger',
      'request_ticket_relations_accepted_capacity_update',
      `
        CREATE TRIGGER request_ticket_relations_accepted_capacity_update
        BEFORE UPDATE OF state ON request_ticket_relations
        WHEN OLD.state = 'pending' AND NEW.state = 'accepted' AND (
          SELECT COUNT(*) FROM request_ticket_relations
          WHERE ticket_id = NEW.ticket_id AND state = 'accepted'
        ) >= ${COLLAB_LIMITS.maxTicketAcceptedRelations}
        BEGIN
          SELECT RAISE(ABORT, 'accepted ticket relation capacity exceeded');
        END
      `,
    )
    && finiteCollectionCapacityIsValid(database);
}

function repairAndAssertAuthorityV11Schema(database: Database): boolean {
  const repaired = repairAndAssertAuthorityV10Schema(database);
  if (!authorityV11SchemaIsComplete(database)) {
    throw new Error('Authority V11 finite collection schema is incomplete');
  }
  return repaired;
}

function applyAuthoritySchemaV3(database: Database): void {
  const requestColumns = tableColumns(database, 'change_requests');
  const presentRequestColumns = AUTHORITY_SCHEMA_V3_REQUEST_COLUMNS.filter(column => (
    requestColumns.has(column)
  ));
  const acceptColumns = tableColumns(database, 'accept_operations');
  const presentAcceptColumns = AUTHORITY_SCHEMA_V3_ACCEPT_COLUMNS.filter(column => (
    acceptColumns.has(column)
  ));
  const presentTables = AUTHORITY_SCHEMA_V3_TABLES.filter(table => tableExists(database, table));

  const noColumns = presentRequestColumns.length === 0 && presentAcceptColumns.length === 0;
  const allColumns =
    presentRequestColumns.length === AUTHORITY_SCHEMA_V3_REQUEST_COLUMNS.length
    && presentAcceptColumns.length === AUTHORITY_SCHEMA_V3_ACCEPT_COLUMNS.length;
  if (!noColumns && !allColumns) {
    throw new Error('Authority V3 column schema is incomplete');
  }
  if (presentTables.length !== 0 && presentTables.length !== AUTHORITY_SCHEMA_V3_TABLES.length) {
    throw new Error('Authority V3 table schema is incomplete');
  }
  if (noColumns) database.run(AUTHORITY_SCHEMA_V3_COLUMNS);
  if (presentTables.length === 0) database.run(AUTHORITY_SCHEMA_V3_TABLES_SQL);
}

function applyAuthoritySchemaV4(database: Database): void {
  if (!tableExists(database, 'ticket_mentions')) {
    database.run(AUTHORITY_SCHEMA_V4_TABLE_SQL);
  }
}

function applyAuthoritySchemaV7(database: Database): void {
  const columns = tableColumns(database, 'comments');
  database.run(AUTHORITY_SCHEMA_V7_COMMENTS);
  database.run(`
    INSERT INTO comments_v7 (
      comment_id, request_id, author_member_id, body, created_at
    )
    SELECT comment_id, request_id, author_member_id, body, created_at
    FROM comments
    ${columns.has('anchor_path') ? 'WHERE anchor_path IS NULL' : ''};
    DROP TABLE comments;
    ALTER TABLE comments_v7 RENAME TO comments;
  `);
}

function applyAuthoritySchemaV8(database: Database): void {
  const projectColumns = tableColumns(database, 'project');
  if (
    !projectColumns.has('manager_generation')
    && !projectColumns.has('manager_set_generation')
  ) {
    database.run(`
      ALTER TABLE project ADD COLUMN manager_generation INTEGER NOT NULL DEFAULT 0
        CHECK(typeof(manager_generation) = 'integer' AND manager_generation >= 0)
    `);
  }
  const present = AUTHORITY_SCHEMA_V8_TABLES.filter(table => tableExists(database, table));
  if (present.length === 0) {
    database.run(AUTHORITY_SCHEMA_V8_SQL);
    return;
  }
  if (present.length !== AUTHORITY_SCHEMA_V8_TABLES.length) {
    throw new Error('Authority V8 lifecycle schema is incomplete');
  }
}

function applyAuthoritySchemaV9(database: Database): void {
  const projectColumns = tableColumns(database, 'project');
  const acceptColumns = tableColumns(database, 'accept_operations');
  const responsibilityColumns = tableColumns(database, 'manager_responsibility_offers');
  const hasMultiManagerProjectSchema = (
    projectColumns.has('manager_set_generation')
    && !projectColumns.has('manager_member_id')
    && !projectColumns.has('manager_generation')
    && acceptColumns.has('completion_actor_member_id')
  );
  if (
    hasMultiManagerProjectSchema
    && !responsibilityColumns.has('source_manager_generation')
  ) {
    repairAndAssertAuthorityV10Schema(database);
    return;
  }
  if (hasMultiManagerProjectSchema) {
    repairAndAssertAuthorityV9Schema(database);
    return;
  }
  if (
    !projectColumns.has('manager_member_id')
    || !projectColumns.has('manager_generation')
    || projectColumns.has('manager_set_generation')
    || acceptColumns.has('completion_actor_member_id')
  ) {
    throw new Error('Authority V8 Manager schema is incomplete');
  }

  const legacyManager = database.exec(`
    SELECT p.manager_member_id
    FROM project p
    JOIN members m
      ON m.member_id = p.manager_member_id
      AND m.role = 'manager'
      AND m.status = 'active'
    WHERE p.singleton = 1
      AND (SELECT COUNT(*) FROM members WHERE role = 'manager' AND status = 'active') = 1
  `)[0]?.values[0]?.[0];
  const hasProject = firstColumn(database, 'SELECT singleton FROM project').length > 0;
  if (hasProject && typeof legacyManager !== 'string') {
    throw new Error('Authority V8 Manager pointer invariant failed');
  }

  database.run('DROP INDEX IF EXISTS members_one_active_manager');

  database.run(AUTHORITY_SCHEMA_V9_ACCEPT_SQL);
  database.run(`
    INSERT INTO accept_operations_v9 (
      operation_id, request_id, expected_main_oid, expected_head_oid,
      result_commit_oid, state, idempotency_key, created_at, updated_at,
      expected_request_revision, expected_resolving_tickets_json,
      completion_actor_member_id
    )
    SELECT
      operation_id, request_id, expected_main_oid, expected_head_oid,
      result_commit_oid, state, idempotency_key, created_at, updated_at,
      expected_request_revision, expected_resolving_tickets_json,
      CASE WHEN state = 'completed' THEN NULL ELSE ? END
    FROM accept_operations
  `, [hasProject ? legacyManager : null]);
  database.run('DROP TABLE accept_operations');
  database.run('ALTER TABLE accept_operations_v9 RENAME TO accept_operations');

  database.run(AUTHORITY_SCHEMA_V9_MANAGER_RESPONSIBILITY_SQL);
  database.run(`
    INSERT INTO manager_responsibility_offers_v9 (
      offer_id, purpose, source_manager_member_id, source_manager_generation,
      target_member_id, status, offered_at, expires_at, acknowledged_at,
      consumed_at, updated_at
    )
    SELECT
      offer_id,
      CASE purpose
        WHEN 'manager-transfer' THEN 'manager-promotion'
        ELSE purpose
      END,
      source_manager_member_id,
      source_manager_generation,
      target_member_id,
      CASE
        WHEN status IN ('offered', 'acknowledged') THEN 'cancelled'
        ELSE status
      END,
      offered_at,
      expires_at,
      acknowledged_at,
      consumed_at,
      updated_at
    FROM manager_responsibility_offers
  `);
  database.run('DROP TABLE manager_responsibility_offers');
  database.run(
    'ALTER TABLE manager_responsibility_offers_v9 RENAME TO manager_responsibility_offers',
  );
  database.run(`
    CREATE UNIQUE INDEX manager_responsibility_one_nonterminal
    ON manager_responsibility_offers((1))
    WHERE status IN ('offered', 'acknowledged')
  `);

  database.run(AUTHORITY_SCHEMA_V9_PROJECT_SQL);
  database.run(`
    INSERT INTO project_v9 (
      singleton, project_id, name, state, host_member_id,
      manager_set_generation, main_ref, created_at, snapshot_generation
    )
    SELECT
      singleton, project_id, name, state, host_member_id,
      manager_generation, main_ref, created_at, snapshot_generation
    FROM project
  `);
  database.run('DROP TABLE project');
  database.run('ALTER TABLE project_v9 RENAME TO project');
}

function applyAuthoritySchemaV10(database: Database): void {
  const columns = tableColumns(database, 'manager_responsibility_offers');
  if (!columns.has('source_manager_generation')) {
    repairAndAssertAuthorityV10Schema(database);
    return;
  }
  if (!authorityV9SchemaIsComplete(database)) {
    throw new Error('Authority V9 Manager schema is incomplete');
  }
  database.run(AUTHORITY_SCHEMA_V10_MANAGER_RESPONSIBILITY_SQL);
  database.run(`
    INSERT INTO manager_responsibility_offers_v10 (
      offer_id, purpose, source_manager_member_id, target_member_id, status,
      offered_at, expires_at, acknowledged_at, consumed_at, updated_at
    )
    SELECT
      offer_id, purpose, source_manager_member_id, target_member_id, status,
      offered_at, expires_at, acknowledged_at, consumed_at, updated_at
    FROM manager_responsibility_offers
  `);
  database.run('DROP TABLE manager_responsibility_offers');
  database.run(
    'ALTER TABLE manager_responsibility_offers_v10 RENAME TO manager_responsibility_offers',
  );
  database.run(`
    CREATE UNIQUE INDEX manager_responsibility_one_nonterminal_source
    ON manager_responsibility_offers(source_manager_member_id)
    WHERE status IN ('offered', 'acknowledged')
  `);
  database.run(`
    CREATE UNIQUE INDEX manager_responsibility_one_nonterminal_target
    ON manager_responsibility_offers(target_member_id)
    WHERE status IN ('offered', 'acknowledged')
  `);
}

function applyAuthoritySchemaV11(database: Database): void {
  repairAndAssertAuthorityV10Schema(database);
  if (!finiteCollectionCapacityIsValid(database)) {
    throw new Error('Authority V11 finite collection invariant failed');
  }
  if (authorityV11SchemaIsComplete(database)) return;
  if (
    schemaSql(database, 'trigger', 'comments_request_capacity_insert') !== null
    || schemaSql(
      database,
      'trigger',
      'request_ticket_relations_accepted_capacity_insert',
    ) !== null
    || schemaSql(
      database,
      'trigger',
      'request_ticket_relations_accepted_capacity_update',
    ) !== null
  ) {
    throw new Error('Authority V11 finite collection schema is incomplete');
  }
  database.run(AUTHORITY_SCHEMA_V11_FINITE_COLLECTION_TRIGGERS);
}

export function applyAuthorityMigrations(database: Database): boolean {
  const version = pragmaNumber(database, 'PRAGMA user_version');
  if (version > COLLAB_AUTHORITY_SCHEMA_VERSION) {
    throw new RangeError('Authority schema version is newer than supported');
  }
  if (version === COLLAB_AUTHORITY_SCHEMA_VERSION) {
    database.run('BEGIN IMMEDIATE');
    try {
      const repaired = repairAndAssertAuthorityV11Schema(database);
      database.run('COMMIT');
      return repaired;
    } catch (error) {
      database.run('ROLLBACK');
      throw error;
    }
  }

  database.run('BEGIN IMMEDIATE');
  try {
    if (version < 1) database.run(AUTHORITY_SCHEMA_V1);
    if (version < 3) applyAuthoritySchemaV3(database);
    if (version < 4) applyAuthoritySchemaV4(database);
    if (version < 7) applyAuthoritySchemaV7(database);
    if (version < 8) applyAuthoritySchemaV8(database);
    if (version < 9) applyAuthoritySchemaV9(database);
    if (version < 10) applyAuthoritySchemaV10(database);
    if (version < 11) applyAuthoritySchemaV11(database);
    repairAndAssertAuthorityV11Schema(database);
    database.run(`PRAGMA user_version = ${COLLAB_AUTHORITY_SCHEMA_VERSION}`);
    database.run('COMMIT');
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }
  return true;
}

/**
 * Migrates one already-authenticated in-memory Host-transfer authority image.
 * The caller remains responsible for artifact identity and digest validation.
 */
export function migrateLegacyAuthorityDatabaseToCurrent(database: Database): number {
  const version = pragmaNumber(database, 'PRAGMA user_version');
  if (version !== 8 && version !== 9 && version !== 10) {
    throw new RangeError('Host transfer authority schema is not a supported legacy version');
  }
  applyAuthorityMigrations(database);
  return assertAuthorityDatabaseIntegrity(database, {
    full: true,
    requireProject: true,
  });
}

export function assertAuthorityDatabaseIntegrity(
  database: Database,
  options: { readonly full: boolean; readonly requireProject: boolean },
): number {
  if (options.full) {
    const integrityResults = firstColumn(database, 'PRAGMA integrity_check');
    if (integrityResults.length !== 1 || integrityResults[0] !== 'ok') {
      throw new Error('Authority integrity check failed');
    }
  }
  if (firstColumn(database, 'PRAGMA foreign_key_check').length > 0) {
    throw new Error('Authority foreign key check failed');
  }

  if (!finiteCollectionCapacityIsValid(database)) {
    throw new Error('Authority finite collection invariant failed');
  }

  if (firstColumn(database, `
    SELECT request_id FROM change_requests
    WHERE typeof(revision) != 'integer' OR revision < 0
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority request revision invariant failed');
  }
  if (firstColumn(database, `
    SELECT offer_id FROM manager_responsibility_offers
    WHERE
      expires_at <= offered_at
      OR (status = 'offered' AND acknowledged_at IS NOT NULL)
      OR (status = 'acknowledged' AND acknowledged_at IS NULL)
      OR (status = 'consumed' AND (acknowledged_at IS NULL OR consumed_at IS NULL))
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority Manager responsibility invariant failed');
  }
  if (firstColumn(database, `
    SELECT participant_id
    FROM (
      SELECT source_manager_member_id AS participant_id
      FROM manager_responsibility_offers
      WHERE status IN ('offered', 'acknowledged')
      UNION ALL
      SELECT target_member_id AS participant_id
      FROM manager_responsibility_offers
      WHERE status IN ('offered', 'acknowledged')
    )
    GROUP BY participant_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority Manager responsibility participant invariant failed');
  }
  if (firstColumn(database, `
    SELECT transfer_id FROM host_transition_proofs
    WHERE previous_ca_fingerprint = next_ca_fingerprint
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority Host transition invariant failed');
  }
  if (firstColumn(database, `
    SELECT ticket_id FROM tickets
    WHERE
      typeof(revision) != 'integer'
      OR revision < 1
      OR typeof(comment_count) != 'integer'
      OR comment_count < 0
      OR (status = 'open' AND (closed_at IS NOT NULL OR closed_by_member_id IS NOT NULL))
      OR (status = 'closed' AND (closed_at IS NULL OR closed_by_member_id IS NULL))
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority Ticket invariant failed');
  }
  if (firstColumn(database, `
    SELECT relation_id FROM request_ticket_relations r
    JOIN change_requests q ON q.request_id = r.request_id
    WHERE
      (r.state = 'pending' AND q.status != 'open')
      OR (r.state = 'accepted' AND (
        r.accepted_at IS NULL OR r.accepted_merge_oid IS NULL
      ))
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority Ticket relation invariant failed');
  }
  if (firstColumn(database, `
    SELECT m.source_id FROM ticket_mentions m
    JOIN members target ON target.member_id = m.mentioned_member_id
    WHERE
      target.status != 'active'
      OR (m.source_kind = 'description' AND m.source_id != m.ticket_id)
      OR (m.source_kind = 'comment' AND NOT EXISTS (
        SELECT 1 FROM ticket_comments c
        WHERE c.comment_id = m.source_id AND c.ticket_id = m.ticket_id
      ))
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority Ticket mention invariant failed');
  }

  const projectRows = database.exec(`
    SELECT
      p.snapshot_generation,
      p.manager_set_generation,
      (
        SELECT COUNT(*) FROM members
        WHERE role = 'manager' AND status = 'active'
      ) AS active_manager_count
    FROM project p
    WHERE p.singleton = 1
  `);
  const rows = projectRows[0]?.values ?? [];
  if (rows.length === 0 && !options.requireProject) return 0;
  if (rows.length !== 1) throw new Error('Authority project row is invalid');
  const [
    generation,
    managerGeneration,
    activeManagerCount,
  ] = rows[0];
  if (
    typeof generation !== 'number'
    || !Number.isSafeInteger(generation)
    || generation < 0
    || typeof managerGeneration !== 'number'
    || !Number.isSafeInteger(managerGeneration)
    || managerGeneration < 0
    || typeof activeManagerCount !== 'number'
    || !Number.isSafeInteger(activeManagerCount)
    || activeManagerCount < 1
  ) {
    throw new Error('Authority manager or generation invariant failed');
  }
  return generation;
}

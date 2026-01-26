# Architecture

## Core objects

- `records`: immutable domain entities.
- `relations`: directed links between records.
- `kv`: arbitrary mutable key values.

### Records

Records are immutable.

Required fields:

- `id`
- `type`
- `createdAt`
- `updatedAt`
- `payload`

Optional fields:

- `deletedAt`

Numeric timestamps like `createdAt` are all epoch milliseconds. Payloads also include a `localTimestamp` string in the local timezone where the corresponding record was created.

### Relations

Relations encode edges between records. They are also immutable.

Fields:

- `id`
- `fromId`
- `toId`
- `type`
- `createdAt`

Relation types:

- `contains`: `fromId = collection`, `toId = message`
- `parent`: `fromId = child`, `toId = parent`

### KV

Ad-hoc key value pairs. Keys are strings, values are JSON values.

The sync strategy for the KV pairs is not defined yet, but it likely will be bespoke since many of these are per-device state that wouldn't make sense being synced.

## Sync model

### Append-only invariants

- No destructive updates to canonical data (records and relations)
- Deletes are tombstones (`deletedAt` on a new record).
- Derived state can be rebuilt

### Network

- Sync operates on immutable segments of records/relations to avoid the problem of too many small objects.

- Payloads are encrypted for transport and decrypted locally.

## Local-only derived data

Local indexes and caches are derived from canonical data. These are not synced.

Examples:
- `relation_index`: a local index for ordered traversal of `contains`
  relations by `(fromId, type, createdAt)`.

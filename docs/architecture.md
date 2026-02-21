# Architecture

## Core objects

- `records`: domain entities.
- `relations`: directed links between records.
- `kv`: arbitrary key values.

### Records

Records are domain entities keyed by an unchanging id. Edits and deletes overwrite the existing record in place. The canonical state is whatever has the latest `updatedAt` for that id.

There are two record shapes:

- **Live records**: carry `payload` and omit `deletedAt`.
- **Tombstones**: carry `deletedAt` and omit `payload`.

Common fields (both shapes):

- `id`
- `type`
- `createdAt`
- `updatedAt`

Live-only fields:

- `payload`

Tombstone-only fields:

- `deletedAt`

Numeric timestamps like `createdAt` are epoch milliseconds.

When present, payloads include a `localTimestamp` string in the local timezone where the record was created.

#### Collections

A container of blocks.

The title of a collection may be mutated in place.

#### Blocks

A single immutable "interaction". Blocks are chained together to form the context when generating and linear flow when reading.

### Relations

Relations encode edges between records. They are immutable.

> Note: Relations are deleted (pruned) if either of the records it connects are deleted (tombstoned).

Fields:

- `id`
- `fromId`
- `toId`
- `type`
- `createdAt`

Relation types:

- `contains`: `fromId = collection`, `toId = block` (grouping)
- `parent`: `fromId = child`, `toId = parent` (lineage)
- `source`: `fromId = derived block`, `toId = source block` (derivation)

### KV

Ad-hoc key value pairs. Keys are strings, values are JSON values.

The sync strategy for the KV pairs is not defined yet, but it likely will be bespoke since many of these are per-device state that shouldn't be synced.

## Sync model

### Local

- Locally, records are overwritten in place; the latest `updatedAt` wins.
- Deletes are tombstones (`deletedAt` on the latest record).
- Derived state can be rebuilt.

### Network

- Sync operates on immutable segments of records/relations to avoid the problem of too many small objects.

- Payloads are encrypted for transport and decrypted locally.

## Local-only derived data

Local indexes and caches are derived from canonical data. These are not synced.

Examples:
- `relation_index`: a local index for traversal of relations by
  `(fromId, type, createdAt)`.
- `block_text_index` / `block_term_index`: local full-text search indexes for
  block retrieval.

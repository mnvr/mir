import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  Relation,
  RelationType,
  CollectionPayload,
  CollectionRecord,
  MessagePayload,
  MessageRecord,
  KvEntry,
  MirRecord,
  RecordType,
} from 'mir-core'
import { createId } from 'mir-core'

const DB_NAME = 'mir'
const DB_VERSION = 1

// Local-only derived indexes; safe to drop and rebuild.
const INDEX_DB_NAME = 'mir-index'
const INDEX_DB_VERSION = 1
const RELATION_INDEX_READY_KEY = 'relation_index_ready'

type MirDbSchema = DBSchema & {
  records: {
    key: string
    value: MirRecord
  }
  relations: {
    key: string
    value: Relation
  }
  kv: {
    key: string
    value: KvEntry
  }
}

type RelationIndexEntry = {
  fromId: string
  type: RelationType
  createdAt: number
  relationId: string
  toId: string
}

type MirIndexSchema = DBSchema & {
  relation_index: {
    key: [string, RelationType, number, string]
    value: RelationIndexEntry
  }
  meta: {
    key: string
    value: number
  }
}

let dbPromise: Promise<IDBPDatabase<MirDbSchema>> | null = null
let indexDbPromise: Promise<IDBPDatabase<MirIndexSchema>> | null = null

const getDb = () => {
  if (!dbPromise) {
    dbPromise = openDB<MirDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('records', { keyPath: 'id' })

        db.createObjectStore('relations', { keyPath: 'id' })

        db.createObjectStore('kv')
      },
    })
  }

  return dbPromise
}

const getIndexDb = () => {
  if (!indexDbPromise) {
    indexDbPromise = openDB<MirIndexSchema>(INDEX_DB_NAME, INDEX_DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('relation_index', {
          keyPath: ['fromId', 'type', 'createdAt', 'relationId'],
        })
        db.createObjectStore('meta')
      },
    })
  }

  return indexDbPromise
}

const buildRecord = <TType extends RecordType, TPayload>(
  type: TType,
  payload: TPayload,
): MirRecord & { type: TType; payload: TPayload } => {
  const now = Date.now()
  return {
    id: createId(type),
    type,
    createdAt: now,
    updatedAt: now,
    payload,
  }
}

const buildRelation = (
  fromId: string,
  toId: string,
  type: RelationType,
): Relation => {
  const now = Date.now()
  return {
    id: createId(type),
    fromId,
    toId,
    type,
    createdAt: now,
  }
}

const buildRelationIndexEntry = (relation: Relation): RelationIndexEntry => ({
  fromId: relation.fromId,
  type: relation.type,
  createdAt: relation.createdAt,
  relationId: relation.id,
  toId: relation.toId,
})

const rebuildRelationIndex = async (
  db: IDBPDatabase<MirDbSchema>,
  indexDb: IDBPDatabase<MirIndexSchema>,
) => {
  const relations = await db.getAll('relations')
  const tx = indexDb.transaction(['relation_index', 'meta'], 'readwrite')
  const store = tx.objectStore('relation_index')
  await store.clear()
  relations.forEach((relation) => {
    store.put(buildRelationIndexEntry(relation))
  })
  await tx.objectStore('meta').put(Date.now(), RELATION_INDEX_READY_KEY)
  await tx.done
}

const ensureRelationIndexReady = async () => {
  const [db, indexDb] = await Promise.all([getDb(), getIndexDb()])
  const ready = await indexDb.get('meta', RELATION_INDEX_READY_KEY)
  if (ready) {
    return
  }
  await rebuildRelationIndex(db, indexDb)
}

const getRelationIndexRange = (fromId: string, type: RelationType) =>
  IDBKeyRange.bound(
    [fromId, type, 0, ''],
    [fromId, type, Number.MAX_SAFE_INTEGER, '\uffff'],
  )

const listRelationTargetsByFromType = async (
  fromId: string,
  type: RelationType,
) => {
  const indexDb = await getIndexDb()
  await ensureRelationIndexReady()
  const entries = await indexDb.getAll(
    'relation_index',
    getRelationIndexRange(fromId, type),
  )
  return entries.map((entry) => entry.toId)
}

const indexRelation = async (relation: Relation) => {
  try {
    const indexDb = await getIndexDb()
    await indexDb.put('relation_index', buildRelationIndexEntry(relation))
  } catch {
    try {
      const indexDb = await getIndexDb()
      await indexDb.delete('meta', RELATION_INDEX_READY_KEY)
    } catch {
      // Ignore index failures; it can be rebuilt on demand.
    }
  }
}

export const getActiveCollection = async () => {
  const db = await getDb()
  const tx = db.transaction(['kv', 'records'], 'readonly')
  const kvStore = tx.objectStore('kv')
  const recordStore = tx.objectStore('records')
  const existingId = await kvStore.get('activeCollectionId')
  if (typeof existingId === 'string') {
    const existing = await recordStore.get(existingId)
    if (existing && existing.type === 'collection' && !existing.deletedAt) {
      await tx.done
      return existing as CollectionRecord
    }
  }
  await tx.done
  return null
}

export const createCollection = async (payload: CollectionPayload) => {
  const db = await getDb()
  const tx = db.transaction(['kv', 'records'], 'readwrite')
  const kvStore = tx.objectStore('kv')
  const recordStore = tx.objectStore('records')
  const collection = buildRecord<
    CollectionRecord['type'],
    CollectionPayload
  >('collection', payload)
  await recordStore.put(collection)
  await kvStore.put(collection.id, 'activeCollectionId')
  await tx.done
  return collection
}

export const listCollectionMessages = async (
  collectionId: string,
): Promise<MessageRecord[]> => {
  const db = await getDb()
  const toIds = await listRelationTargetsByFromType(collectionId, 'contains')
  const records = await Promise.all(
    toIds.map((toId) => db.get('records', toId)),
  )

  return records.filter((record): record is MessageRecord => {
    if (!record || record.type !== 'message') {
      return false
    }
    return !record.deletedAt
  })
}

export const appendMessage = async (
  collectionId: string,
  payload: MessagePayload,
) => {
  const db = await getDb()
  const record = buildRecord<MessageRecord['type'], MessagePayload>(
    'message',
    payload,
  )
  const relation = buildRelation(
    collectionId,
    record.id,
    'contains',
  )

  const tx = db.transaction(['records', 'relations'], 'readwrite')
  await tx.objectStore('records').put(record)
  await tx.objectStore('relations').put(relation)
  await tx.done
  void indexRelation(relation)

  return record as MessageRecord
}

export const getKvValue = async <T>(key: string): Promise<T | undefined> => {
  const db = await getDb()
  const entry = await db.get('kv', key)
  return entry as T | undefined
}

export const setKvValue = async (key: string, value: unknown) => {
  const db = await getDb()
  await db.put('kv', value, key)
}

export const deleteKvValue = async (key: string) => {
  const db = await getDb()
  await db.delete('kv', key)
}

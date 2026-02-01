import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  Relation,
  RelationType,
  CollectionPayload,
  CollectionRecord,
  BlockPayload,
  BlockRecord,
  KvEntry,
  MirRecord,
  RecordType,
} from 'mir-core'
import { createId } from 'mir-core'

const DB_NAME = 'mir'
const DB_VERSION = 1

// Local-only derived indexes; safe to drop and rebuild.
const INDEX_DB_NAME = 'mir-index'
const INDEX_DB_VERSION = 2
const RELATION_INDEX_READY_KEY = 'relation_index_ready'
const COLLECTION_INDEX_READY_KEY = 'collection_index_ready'

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

type CollectionIndexEntry = {
  createdAt: number
  collectionId: string
}

type MirIndexSchema = DBSchema & {
  relation_index: {
    key: [string, RelationType, number, string]
    value: RelationIndexEntry
  }
  collection_index: {
    key: [number, string]
    value: CollectionIndexEntry
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
        if (!db.objectStoreNames.contains('relation_index')) {
          db.createObjectStore('relation_index', {
            keyPath: ['fromId', 'type', 'createdAt', 'relationId'],
          })
        }
        if (!db.objectStoreNames.contains('collection_index')) {
          db.createObjectStore('collection_index', {
            keyPath: ['createdAt', 'collectionId'],
          })
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta')
        }
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

const buildCollectionIndexEntry = (
  collection: CollectionRecord,
): CollectionIndexEntry => ({
  createdAt: collection.createdAt,
  collectionId: collection.id,
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

const rebuildCollectionIndex = async (
  db: IDBPDatabase<MirDbSchema>,
  indexDb: IDBPDatabase<MirIndexSchema>,
) => {
  const records = await db.getAll('records')
  const collections = records.filter(
    (record): record is CollectionRecord =>
      Boolean(record) && record.type === 'collection' && !record.deletedAt,
  )
  const tx = indexDb.transaction(['collection_index', 'meta'], 'readwrite')
  const store = tx.objectStore('collection_index')
  await store.clear()
  collections.forEach((collection) => {
    store.put(buildCollectionIndexEntry(collection))
  })
  await tx.objectStore('meta').put(Date.now(), COLLECTION_INDEX_READY_KEY)
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

const ensureCollectionIndexReady = async () => {
  const [db, indexDb] = await Promise.all([getDb(), getIndexDb()])
  const ready = await indexDb.get('meta', COLLECTION_INDEX_READY_KEY)
  if (ready) {
    return
  }
  await rebuildCollectionIndex(db, indexDb)
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

const indexCollection = async (collection: CollectionRecord) => {
  try {
    const indexDb = await getIndexDb()
    await indexDb.put('collection_index', buildCollectionIndexEntry(collection))
  } catch {
    try {
      const indexDb = await getIndexDb()
      await indexDb.delete('meta', COLLECTION_INDEX_READY_KEY)
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
  void indexCollection(collection)
  return collection
}

export const setActiveCollectionId = async (
  collectionId: string | null,
) => {
  const db = await getDb()
  if (!collectionId) {
    await db.delete('kv', 'activeCollectionId')
    return
  }
  await db.put('kv', collectionId, 'activeCollectionId')
}

export const updateCollectionTitle = async (
  collectionId: string,
  title: string,
): Promise<CollectionRecord | null> => {
  const db = await getDb()
  const tx = db.transaction(['records'], 'readwrite')
  const recordStore = tx.objectStore('records')
  const record = await recordStore.get(collectionId)
  if (!record || record.type !== 'collection' || record.deletedAt) {
    await tx.done
    return null
  }
  const collection = record as CollectionRecord
  const updated: CollectionRecord = {
    ...collection,
    updatedAt: Date.now(),
    payload: {
      ...collection.payload,
      title,
    },
  }
  await recordStore.put(updated)
  await tx.done
  return updated
}

export const listCollections = async (): Promise<CollectionRecord[]> => {
  const [db, indexDb] = await Promise.all([getDb(), getIndexDb()])
  await ensureCollectionIndexReady()
  const entries = await indexDb.getAll('collection_index')
  const records = await Promise.all(
    entries.map((entry) => db.get('records', entry.collectionId)),
  )
  return records.filter((record): record is CollectionRecord => {
    if (!record || record.type !== 'collection') {
      return false
    }
    return !record.deletedAt
  })
}

const sortBlocksByParent = async (
  blocks: BlockRecord[],
): Promise<BlockRecord[]> => {
  if (blocks.length <= 1) {
    return blocks
  }

  const blockById = new Map(blocks.map((block) => [block.id, block]))
  const parentIdsByBlockId = new Map<string, string[]>()

  await Promise.all(
    blocks.map(async (block) => {
      const parentIds = await listRelationTargetsByFromType(block.id, 'parent')
      parentIdsByBlockId.set(
        block.id,
        parentIds.filter((parentId) => blockById.has(parentId)),
      )
    }),
  )

  const childrenByParent = new Map<string, string[]>()
  const indegreeById = new Map<string, number>()

  blocks.forEach((block) => {
    const parentIds = parentIdsByBlockId.get(block.id) ?? []
    indegreeById.set(block.id, parentIds.length)
    parentIds.forEach((parentId) => {
      const siblings = childrenByParent.get(parentId) ?? []
      siblings.push(block.id)
      childrenByParent.set(parentId, siblings)
    })
  })

  const compareIds = (a: string, b: string) => {
    const blockA = blockById.get(a)
    const blockB = blockById.get(b)
    if (!blockA || !blockB) {
      return a.localeCompare(b)
    }
    if (blockA.createdAt !== blockB.createdAt) {
      return blockA.createdAt - blockB.createdAt
    }
    return blockA.id.localeCompare(blockB.id)
  }

  const ready = Array.from(indegreeById.entries())
    .filter(([, indegree]) => indegree === 0)
    .map(([id]) => id)
    .sort(compareIds)

  const ordered: BlockRecord[] = []
  const visited = new Set<string>()

  while (ready.length > 0) {
    const nextId = ready.shift()
    if (!nextId) {
      break
    }
    const block = blockById.get(nextId)
    if (!block) {
      continue
    }
    ordered.push(block)
    visited.add(nextId)
    const children = childrenByParent.get(nextId) ?? []
    children.forEach((childId) => {
      const indegree = indegreeById.get(childId)
      if (typeof indegree !== 'number') {
        return
      }
      const nextIndegree = indegree - 1
      indegreeById.set(childId, nextIndegree)
      if (nextIndegree === 0) {
        ready.push(childId)
        ready.sort(compareIds)
      }
    })
  }

  if (ordered.length === blocks.length) {
    return ordered
  }

  const remaining = blocks
    .filter((block) => !visited.has(block.id))
    .slice()
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt
      }
      return a.id.localeCompare(b.id)
    })

  return [...ordered, ...remaining]
}

export const listCollectionBlocks = async (
  collectionId: string,
): Promise<BlockRecord[]> => {
  const db = await getDb()
  const toIds = await listRelationTargetsByFromType(collectionId, 'contains')
  const records = await Promise.all(
    toIds.map((toId) => db.get('records', toId)),
  )

  const blocks = records.filter((record): record is BlockRecord => {
    if (!record || record.type !== 'block') {
      return false
    }
    return !record.deletedAt
  })

  return sortBlocksByParent(blocks)
}

export const appendBlock = async (
  collectionId: string,
  payload: BlockPayload,
  options?: {
    parentIds?: string[]
  },
) => {
  const db = await getDb()
  const record = buildRecord<BlockRecord['type'], BlockPayload>(
    'block',
    payload,
  )
  const relations: Relation[] = [
    buildRelation(collectionId, record.id, 'contains'),
  ]
  const parentIds = options?.parentIds?.filter(Boolean) ?? []
  parentIds.forEach((parentId) => {
    relations.push(buildRelation(record.id, parentId, 'parent'))
  })

  const tx = db.transaction(['records', 'relations'], 'readwrite')
  await tx.objectStore('records').put(record)
  await Promise.all(
    relations.map((relation) => tx.objectStore('relations').put(relation)),
  )
  await tx.done
  relations.forEach((relation) => {
    void indexRelation(relation)
  })

  return record as BlockRecord
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

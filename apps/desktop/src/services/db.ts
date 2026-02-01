import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  Relation,
  RelationType,
  CollectionPayload,
  CollectionRecord,
  CollectionTombstone,
  BlockPayload,
  BlockRecord,
  BlockTombstone,
  KvEntry,
  MirRecord,
  LiveRecord,
  RecordType,
} from 'mir-core'
import { createDerivedId, createId } from 'mir-core'

const DB_NAME = 'mir'
const DB_VERSION = 1

// Local-only derived indexes; safe to drop and rebuild.
const INDEX_DB_NAME = 'mir-index'
const INDEX_DB_VERSION = 2
const RELATION_INDEX_READY_KEY = 'relation_index_ready'
const COLLECTION_INDEX_READY_KEY = 'collection_index_ready'

const isCollectionRecord = (
  record: MirRecord | undefined | null,
): record is CollectionRecord => {
  if (!record) {
    return false
  }
  return record.type === 'collection' && !record.deletedAt
}

const isBlockRecord = (
  record: MirRecord | undefined | null,
): record is BlockRecord => {
  if (!record) {
    return false
  }
  return record.type === 'block' && !record.deletedAt
}

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

export type MirExport = {
  version: 1
  exportedAt: string
  records: MirRecord[]
  relations: Relation[]
}

export type MirImportSummary = {
  records: {
    incoming: number
    imported: number
    skipped: number
    conflicts: number
    duplicates: number
  }
  relations: {
    incoming: number
    imported: number
    skipped: number
    conflicts: number
    duplicates: number
    missingEndpoints: number
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
  options?: {
    id?: string
  },
): LiveRecord<TPayload> & { type: TType } => {
  const now = Date.now()
  return {
    id: options?.id ?? createId(type),
    type,
    createdAt: now,
    updatedAt: now,
    payload,
  }
}

const isSameBlockPayload = (left: BlockPayload, right: BlockPayload) =>
  JSON.stringify(left) === JSON.stringify(right)

const buildRelation = (
  fromId: string,
  toId: string,
  type: RelationType,
): Relation => {
  const now = Date.now()
  return {
    id: createDerivedId(type, `${fromId}:${toId}`),
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
  const collections = records.filter(isCollectionRecord)
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
    if (isCollectionRecord(existing)) {
      await tx.done
      return existing
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
  if (!isCollectionRecord(record)) {
    await tx.done
    return null
  }
  const collection = record
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

export const deleteCollection = async (collectionId: string) => {
  const db = await getDb()
  const indexDb = await getIndexDb()
  const tx = db.transaction(['records', 'relations', 'kv'], 'readwrite')
  const recordStore = tx.objectStore('records')
  const relationStore = tx.objectStore('relations')
  const kvStore = tx.objectStore('kv')

  const record = await recordStore.get(collectionId)
  if (!isCollectionRecord(record)) {
    await tx.done
    return
  }

  const tombstoneTime = Date.now()
  const { payload: _collectionPayload, ...collectionBase } = record
  const updated: CollectionTombstone = {
    ...collectionBase,
    updatedAt: tombstoneTime,
    deletedAt: tombstoneTime,
  }
  await recordStore.put(updated)

  const activeCollectionId = await kvStore.get('activeCollectionId')
  if (activeCollectionId === collectionId) {
    await kvStore.delete('activeCollectionId')
  }

  const relations = await relationStore.getAll()
  const blockIds = new Set<string>()
  const sharedBlockIds = new Set<string>()
  relations.forEach((relation) => {
    if (relation.type === 'contains' && relation.fromId === collectionId) {
      blockIds.add(relation.toId)
    }
  })
  relations.forEach((relation) => {
    if (
      relation.type === 'contains' &&
      relation.fromId !== collectionId &&
      blockIds.has(relation.toId)
    ) {
      sharedBlockIds.add(relation.toId)
    }
  })
  const deletableBlockIds = new Set(
    Array.from(blockIds).filter((id) => !sharedBlockIds.has(id)),
  )

  for (const blockId of deletableBlockIds) {
    const blockRecord = await recordStore.get(blockId)
    if (!isBlockRecord(blockRecord)) {
      continue
    }
    const { payload: _blockPayload, ...blockBase } = blockRecord
    const updatedBlock: BlockTombstone = {
      ...blockBase,
      updatedAt: tombstoneTime,
      deletedAt: tombstoneTime,
    }
    await recordStore.put(updatedBlock)
  }

  relations.forEach((relation) => {
    if (
      relation.fromId === collectionId ||
      relation.toId === collectionId ||
      deletableBlockIds.has(relation.fromId) ||
      deletableBlockIds.has(relation.toId)
    ) {
      relationStore.delete(relation.id)
    }
  })

  await tx.done

  await rebuildRelationIndex(db, indexDb)
  await rebuildCollectionIndex(db, indexDb)
}

export const listCollections = async (): Promise<CollectionRecord[]> => {
  const db = await getDb()
  const allRecords = await db.getAll('records')
  const collections = allRecords.filter(isCollectionRecord)
  void ensureCollectionIndexReady().catch(() => {})
  return collections
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

  const blocks = records.filter(isBlockRecord)

  return sortBlocksByParent(blocks)
}

export const appendBlock = async (
  collectionId: string,
  payload: BlockPayload,
  options?: {
    parentIds?: string[]
    recordId?: string
  },
) => {
  const db = await getDb()
  if (options?.recordId) {
    const existing = await db.get('records', options.recordId)
    if (existing) {
      if (!isBlockRecord(existing)) {
        throw new Error(
          `Record id collision: ${options.recordId} is not an active block.`,
        )
      }
      const existingBlock = existing
      if (!isSameBlockPayload(existingBlock.payload, payload)) {
        throw new Error(
          `Block payload mismatch for recordId ${options.recordId}.`,
        )
      }
      return existingBlock
    }
  }
  const record = buildRecord<BlockRecord['type'], BlockPayload>(
    'block',
    payload,
    options?.recordId ? { id: options.recordId } : undefined,
  )
  const parentIds = options?.parentIds?.filter(Boolean) ?? []
  const relations: Relation[] = [
    buildRelation(collectionId, record.id, 'contains'),
  ]
  const parentRelations = parentIds.map((parentId) =>
    buildRelation(record.id, parentId, 'parent'),
  )
  relations.push(...parentRelations)

  const tx = db.transaction(['records', 'relations'], 'readwrite')
  const recordStore = tx.objectStore('records')
  const relationStore = tx.objectStore('relations')
  await recordStore.put(record)
  const uniqueRelations: Relation[] = []
  for (const relation of relations) {
    // Keep deterministic relation IDs stable by avoiding overwrites.
    const existing = await relationStore.get(relation.id)
    if (!existing) {
      uniqueRelations.push(relation)
    }
  }
  await Promise.all(uniqueRelations.map((relation) => relationStore.put(relation)))
  await tx.done
  uniqueRelations.forEach((relation) => {
    void indexRelation(relation)
  })

  return record as BlockRecord
}

export const buildExportPayload = async (): Promise<MirExport> => {
  const db = await getDb()
  const [records, relations] = await Promise.all([
    db.getAll('records'),
    db.getAll('relations'),
  ])
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    records,
    relations,
  }
}

export const importMirData = async (
  payload: MirExport,
): Promise<MirImportSummary> => {
  const db = await getDb()
  const [existingRecords, existingRelations] = await Promise.all([
    db.getAll('records'),
    db.getAll('relations'),
  ])
  const existingRecordMap = new Map(
    existingRecords.map((record) => [record.id, record]),
  )
  const existingRelationMap = new Map(
    existingRelations.map((relation) => [relation.id, relation]),
  )
  const relationKeyFor = (relation: Relation) =>
    `${relation.type}::${relation.fromId}::${relation.toId}`
  const existingRelationKeys = new Set(
    existingRelations.map((relation) => relationKeyFor(relation)),
  )

  const seenRecordIds = new Set<string>()
  const seenRelationIds = new Set<string>()
  const newRecords: MirRecord[] = []
  const newCollections: CollectionRecord[] = []
  const recordConflicts: string[] = []
  let recordSkipped = 0
  let recordDuplicates = 0

  payload.records.forEach((record) => {
    if (!record || typeof record.id !== 'string') {
      return
    }
    if (seenRecordIds.has(record.id)) {
      recordDuplicates += 1
      return
    }
    seenRecordIds.add(record.id)
    const existing = existingRecordMap.get(record.id)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        recordConflicts.push(record.id)
      } else {
        recordSkipped += 1
      }
      return
    }
    newRecords.push(record)
    if (isCollectionRecord(record)) {
      newCollections.push(record)
    }
  })

  const availableRecordIds = new Set<string>([
    ...existingRecordMap.keys(),
    ...newRecords.map((record) => record.id),
  ])
  const deletedRecordIds = new Set<string>()
  existingRecords.forEach((record) => {
    if (record.deletedAt) {
      deletedRecordIds.add(record.id)
    }
  })
  newRecords.forEach((record) => {
    if (record.deletedAt) {
      deletedRecordIds.add(record.id)
    }
  })

  const newRelations: Relation[] = []
  const relationConflicts: string[] = []
  let relationSkipped = 0
  let relationDuplicates = 0
  let relationMissingEndpoints = 0

  payload.relations.forEach((relation) => {
    if (!relation || typeof relation.id !== 'string') {
      return
    }
    if (seenRelationIds.has(relation.id)) {
      relationDuplicates += 1
      return
    }
    seenRelationIds.add(relation.id)
    const relationKey = relationKeyFor(relation)
    if (existingRelationKeys.has(relationKey)) {
      relationDuplicates += 1
      return
    }
    if (
      !availableRecordIds.has(relation.fromId) ||
      !availableRecordIds.has(relation.toId)
    ) {
      relationMissingEndpoints += 1
      return
    }
    if (
      deletedRecordIds.has(relation.fromId) ||
      deletedRecordIds.has(relation.toId)
    ) {
      relationMissingEndpoints += 1
      return
    }
    const existing = existingRelationMap.get(relation.id)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(relation)) {
        relationConflicts.push(relation.id)
      } else {
        relationSkipped += 1
      }
      return
    }
    existingRelationKeys.add(relationKey)
    newRelations.push(relation)
  })

  const tx = db.transaction(['records', 'relations'], 'readwrite')
  const recordStore = tx.objectStore('records')
  const relationStore = tx.objectStore('relations')
  newRecords.forEach((record) => {
    recordStore.put(record)
  })
  newRelations.forEach((relation) => {
    relationStore.put(relation)
  })
  await tx.done

  await Promise.all(
    newCollections.map(async (collection) => {
      await indexCollection(collection)
    }),
  )
  newRelations.forEach((relation) => {
    void indexRelation(relation)
  })

  if (recordConflicts.length > 0) {
    console.warn('[import] record id conflicts', recordConflicts.slice(0, 20))
    if (recordConflicts.length > 20) {
      console.warn(
        `[import] ${recordConflicts.length - 20} more record conflicts`,
      )
    }
  }
  if (relationConflicts.length > 0) {
    console.warn(
      '[import] relation id conflicts',
      relationConflicts.slice(0, 20),
    )
    if (relationConflicts.length > 20) {
      console.warn(
        `[import] ${relationConflicts.length - 20} more relation conflicts`,
      )
    }
  }

  return {
    records: {
      incoming: payload.records.length,
      imported: newRecords.length,
      skipped: recordSkipped,
      conflicts: recordConflicts.length,
      duplicates: recordDuplicates,
    },
    relations: {
      incoming: payload.relations.length,
      imported: newRelations.length,
      skipped: relationSkipped,
      conflicts: relationConflicts.length,
      duplicates: relationDuplicates,
      missingEndpoints: relationMissingEndpoints,
    },
  }
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

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
const INDEX_DB_VERSION = 3
const RELATION_INDEX_READY_KEY = 'relation_index_ready'
const COLLECTION_INDEX_READY_KEY = 'collection_index_ready'
const SEARCH_INDEX_READY_KEY = 'search_index_ready'

const SEARCH_RESULT_DEFAULT_LIMIT = 40
const SEARCH_TERM_MAX_COUNT = 8
const SEARCH_TERM_MIN_LENGTH = 2
const SEARCH_SNIPPET_LENGTH = 220
const SEARCH_SNIPPET_CONTEXT = 80

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

export type SavedSystemPromptBlock = {
  promptBlock: BlockRecord
  sourceBlockId: string
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

type BlockTextIndexEntry = {
  collectionId: string
  blockId: string
  blockCreatedAt: number
  role?: string
  localTimestamp?: string
  content: string
  normalizedContent: string
}

type BlockTermIndexEntry = {
  term: string
  collectionId: string
  blockId: string
}

export type BlockSearchResult = {
  collectionId: string
  blockId: string
  blockCreatedAt: number
  role?: string
  localTimestamp?: string
  snippet: string
  score: number
}

export type CollectionBlockGraph = {
  blocks: BlockRecord[]
  parentIdsByBlockId: Record<string, string[]>
  childIdsByBlockId: Record<string, string[]>
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
  block_text_index: {
    key: [string, string]
    value: BlockTextIndexEntry
  }
  block_term_index: {
    key: [string, string, string]
    value: BlockTermIndexEntry
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
        if (!db.objectStoreNames.contains('block_text_index')) {
          db.createObjectStore('block_text_index', {
            keyPath: ['collectionId', 'blockId'],
          })
        }
        if (!db.objectStoreNames.contains('block_term_index')) {
          db.createObjectStore('block_term_index', {
            keyPath: ['term', 'collectionId', 'blockId'],
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

const normalizeSearchText = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const tokenizeSearchTerms = (value: string) =>
  Array.from(
    new Set(
      normalizeSearchText(value)
        .split(/[^a-z0-9_]+/g)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  )

const tokenizeCaseSensitiveSearchTerms = (value: string) =>
  Array.from(
    new Set(
      value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/[^A-Za-z0-9_]+/g)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  )

const buildSearchSnippet = (
  content: string,
  queryTerms: string[],
  fallbackLength = SEARCH_SNIPPET_LENGTH,
  caseSensitive = false,
) => {
  const foldedContent = caseSensitive ? content : content.toLowerCase()
  const foldedTerms = caseSensitive
    ? queryTerms
    : queryTerms.map((term) => term.toLowerCase())
  let firstMatch = -1

  foldedTerms.forEach((term) => {
    const matchIndex = foldedContent.indexOf(term)
    if (matchIndex === -1) {
      return
    }
    if (firstMatch === -1 || matchIndex < firstMatch) {
      firstMatch = matchIndex
    }
  })

  if (firstMatch === -1) {
    const compact = content.replace(/\s+/g, ' ').trim()
    if (compact.length <= fallbackLength) {
      return compact
    }
    return `${compact.slice(0, fallbackLength)}...`
  }

  const searchStart = Math.max(0, firstMatch - SEARCH_SNIPPET_CONTEXT)
  const searchEnd = Math.min(
    foldedContent.length,
    searchStart + SEARCH_SNIPPET_LENGTH,
  )
  const snippet = content.slice(searchStart, searchEnd).replace(/\s+/g, ' ').trim()
  const hasPrefix = searchStart > 0
  const hasSuffix = searchEnd < content.length
  return `${hasPrefix ? '...' : ''}${snippet}${hasSuffix ? '...' : ''}`
}

const buildBlockTextIndexEntry = (
  block: BlockRecord,
  collectionId: string,
): BlockTextIndexEntry => ({
  collectionId,
  blockId: block.id,
  blockCreatedAt: block.createdAt,
  role: block.payload.role,
  localTimestamp: block.payload.localTimestamp,
  content: block.payload.content,
  normalizedContent: normalizeSearchText(block.payload.content),
})

const buildBlockTermIndexEntries = (
  textEntry: BlockTextIndexEntry,
): BlockTermIndexEntry[] =>
  tokenizeSearchTerms(textEntry.normalizedContent).map((term) => ({
    term,
    collectionId: textEntry.collectionId,
    blockId: textEntry.blockId,
  }))

const invalidateSearchIndex = async () => {
  try {
    const indexDb = await getIndexDb()
    await indexDb.delete('meta', SEARCH_INDEX_READY_KEY)
  } catch {
    // Ignore index invalidation failures; a future rebuild can recover.
  }
}

const rebuildSearchIndex = async (
  db: IDBPDatabase<MirDbSchema>,
  indexDb: IDBPDatabase<MirIndexSchema>,
) => {
  const [records, relations] = await Promise.all([
    db.getAll('records'),
    db.getAll('relations'),
  ])
  const collectionsById = new Set(
    records
      .filter(isCollectionRecord)
      .map((collection) => collection.id),
  )
  const collectionIdsByBlockId = new Map<string, Set<string>>()
  relations.forEach((relation) => {
    if (relation.type !== 'contains') {
      return
    }
    if (!collectionsById.has(relation.fromId)) {
      return
    }
    const existing = collectionIdsByBlockId.get(relation.toId) ?? new Set<string>()
    existing.add(relation.fromId)
    collectionIdsByBlockId.set(relation.toId, existing)
  })

  const blocks = records.filter(isBlockRecord)
  const textEntries: BlockTextIndexEntry[] = []
  const termEntries: BlockTermIndexEntry[] = []

  blocks.forEach((block) => {
    const collectionIds = collectionIdsByBlockId.get(block.id)
    if (!collectionIds || collectionIds.size === 0) {
      return
    }
    collectionIds.forEach((collectionId) => {
      const textEntry = buildBlockTextIndexEntry(block, collectionId)
      textEntries.push(textEntry)
      termEntries.push(...buildBlockTermIndexEntries(textEntry))
    })
  })

  const tx = indexDb.transaction(
    ['block_text_index', 'block_term_index', 'meta'],
    'readwrite',
  )
  const textStore = tx.objectStore('block_text_index')
  const termStore = tx.objectStore('block_term_index')
  await Promise.all([textStore.clear(), termStore.clear()])
  textEntries.forEach((entry) => {
    textStore.put(entry)
  })
  termEntries.forEach((entry) => {
    termStore.put(entry)
  })
  await tx.objectStore('meta').put(Date.now(), SEARCH_INDEX_READY_KEY)
  await tx.done
}

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

const ensureSearchIndexReady = async () => {
  const [db, indexDb] = await Promise.all([getDb(), getIndexDb()])
  const ready = await indexDb.get('meta', SEARCH_INDEX_READY_KEY)
  if (ready) {
    return
  }
  await rebuildSearchIndex(db, indexDb)
}

const getRelationIndexRange = (fromId: string, type: RelationType) =>
  IDBKeyRange.bound(
    [fromId, type, 0, ''],
    [fromId, type, Number.MAX_SAFE_INTEGER, '\uffff'],
  )

const getSearchTermPrefixIndexRange = (termPrefix: string) =>
  IDBKeyRange.bound(
    [termPrefix, '', ''],
    [`${termPrefix}\uffff`, '\uffff', '\uffff'],
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

const indexBlockSearchEntry = async (block: BlockRecord, collectionId: string) => {
  try {
    const indexDb = await getIndexDb()
    const searchReady = await indexDb.get('meta', SEARCH_INDEX_READY_KEY)
    if (!searchReady) {
      return
    }

    const textEntry = buildBlockTextIndexEntry(block, collectionId)
    const termEntries = buildBlockTermIndexEntries(textEntry)
    const tx = indexDb.transaction(
      ['block_text_index', 'block_term_index'],
      'readwrite',
    )
    tx.objectStore('block_text_index').put(textEntry)
    termEntries.forEach((entry) => {
      tx.objectStore('block_term_index').put(entry)
    })
    await tx.done
  } catch {
    await invalidateSearchIndex()
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
    if (relation.type === 'source' && blockIds.has(relation.toId)) {
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
  await invalidateSearchIndex()
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
  options?: {
    parentIdsByBlockId?: Map<string, string[]>
  },
): Promise<BlockRecord[]> => {
  if (blocks.length <= 1) {
    return blocks
  }

  const blockById = new Map(blocks.map((block) => [block.id, block]))
  const parentIdsByBlockId =
    options?.parentIdsByBlockId ?? (await listParentIdsByBlockId(blocks))

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

const compareBlocksByCreatedAtThenId = (left: BlockRecord, right: BlockRecord) => {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt
  }
  return left.id.localeCompare(right.id)
}

const listParentIdsByBlockId = async (blocks: BlockRecord[]) => {
  const blockById = new Map(blocks.map((block) => [block.id, block]))
  const parentIdsByBlockId = new Map<string, string[]>()
  await Promise.all(
    blocks.map(async (block) => {
      const parentIds = await listRelationTargetsByFromType(block.id, 'parent')
      const normalized = parentIds
        .filter((parentId) => blockById.has(parentId))
        .slice()
        .sort((left, right) => {
          const leftBlock = blockById.get(left)
          const rightBlock = blockById.get(right)
          if (!leftBlock || !rightBlock) {
            return left.localeCompare(right)
          }
          return compareBlocksByCreatedAtThenId(leftBlock, rightBlock)
        })
      parentIdsByBlockId.set(block.id, normalized)
    }),
  )
  return parentIdsByBlockId
}

const buildChildIdsByParent = (
  parentIdsByBlockId: Map<string, string[]>,
  blockById: Map<string, BlockRecord>,
) => {
  const childIdsByBlockId = new Map<string, string[]>()

  parentIdsByBlockId.forEach((parentIds, childId) => {
    parentIds.forEach((parentId) => {
      const existing = childIdsByBlockId.get(parentId) ?? []
      if (existing.includes(childId)) {
        return
      }
      const next = [...existing, childId]
      next.sort((left, right) => {
        const leftBlock = blockById.get(left)
        const rightBlock = blockById.get(right)
        if (!leftBlock || !rightBlock) {
          return left.localeCompare(right)
        }
        return compareBlocksByCreatedAtThenId(leftBlock, rightBlock)
      })
      childIdsByBlockId.set(parentId, next)
    })
  })

  return childIdsByBlockId
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

export const listCollectionBlockGraph = async (
  collectionId: string,
): Promise<CollectionBlockGraph> => {
  const db = await getDb()
  const toIds = await listRelationTargetsByFromType(collectionId, 'contains')
  const records = await Promise.all(
    toIds.map((toId) => db.get('records', toId)),
  )

  const blocks = records.filter(isBlockRecord)
  const blockById = new Map(blocks.map((block) => [block.id, block]))
  const parentIdsByBlockId = await listParentIdsByBlockId(blocks)
  const orderedBlocks = await sortBlocksByParent(blocks, {
    parentIdsByBlockId,
  })
  const childIdsByBlockId = buildChildIdsByParent(parentIdsByBlockId, blockById)

  return {
    blocks: orderedBlocks,
    parentIdsByBlockId: Object.fromEntries(parentIdsByBlockId),
    childIdsByBlockId: Object.fromEntries(childIdsByBlockId),
  }
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
  void indexBlockSearchEntry(record as BlockRecord, collectionId)

  return record as BlockRecord
}

export const upsertStandaloneBlock = async (
  payload: BlockPayload,
  options?: {
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
  const dbTx = db.transaction(['records'], 'readwrite')
  await dbTx.objectStore('records').put(record)
  await dbTx.done

  return record as BlockRecord
}

export const ensureCollectionContainsBlock = async (
  collectionId: string,
  blockId: string,
) => {
  const db = await getDb()
  const tx = db.transaction(['records', 'relations'], 'readwrite')
  const recordStore = tx.objectStore('records')
  const relationStore = tx.objectStore('relations')

  const [collectionRecord, blockRecord] = await Promise.all([
    recordStore.get(collectionId),
    recordStore.get(blockId),
  ])
  if (!isCollectionRecord(collectionRecord) || !isBlockRecord(blockRecord)) {
    await tx.done
    return 'missing' as const
  }

  const relation = buildRelation(collectionId, blockId, 'contains')
  const existingRelation = await relationStore.get(relation.id)
  if (existingRelation) {
    await tx.done
    return 'already_linked' as const
  }

  await relationStore.put(relation)
  await tx.done
  void indexRelation(relation)
  void indexBlockSearchEntry(blockRecord, collectionId)
  return 'linked' as const
}

export const listCollectionIdsContainingBlock = async (blockId: string) => {
  const db = await getDb()
  const relations = await db.getAll('relations')
  const collectionIds = new Set<string>()
  relations.forEach((relation) => {
    if (relation.type === 'contains' && relation.toId === blockId) {
      collectionIds.add(relation.fromId)
    }
  })
  return Array.from(collectionIds).sort((left, right) =>
    left.localeCompare(right),
  )
}

export const ensureBlockHasSourceRelation = async (
  blockId: string,
  sourceBlockId: string,
) => {
  const db = await getDb()
  const tx = db.transaction(['records', 'relations'], 'readwrite')
  const recordStore = tx.objectStore('records')
  const relationStore = tx.objectStore('relations')

  const [blockRecord, sourceRecord] = await Promise.all([
    recordStore.get(blockId),
    recordStore.get(sourceBlockId),
  ])
  if (!isBlockRecord(blockRecord) || !isBlockRecord(sourceRecord)) {
    await tx.done
    return 'missing' as const
  }

  const relation = buildRelation(blockId, sourceBlockId, 'source')
  const existingRelation = await relationStore.get(relation.id)
  if (existingRelation) {
    await tx.done
    return 'already_linked' as const
  }

  await relationStore.put(relation)
  await tx.done
  void indexRelation(relation)
  return 'linked' as const
}

export const deleteSavedSystemPromptBlock = async (blockId: string) => {
  const db = await getDb()
  const indexDb = await getIndexDb()
  const tx = db.transaction(['records', 'relations'], 'readwrite')
  const recordStore = tx.objectStore('records')
  const relationStore = tx.objectStore('relations')

  const record = await recordStore.get(blockId)
  if (!isBlockRecord(record)) {
    await tx.done
    return false
  }
  if (record.payload.role !== 'system') {
    await tx.done
    return false
  }

  const relations = await relationStore.getAll()
  const hasBlockingRelation = relations.some(
    (relation) =>
      (relation.fromId === blockId || relation.toId === blockId) &&
      !(relation.type === 'source' && relation.fromId === blockId),
  )
  if (hasBlockingRelation) {
    await tx.done
    return false
  }
  relations.forEach((relation) => {
    if (relation.type === 'source' && relation.fromId === blockId) {
      relationStore.delete(relation.id)
    }
  })

  const tombstoneTime = Date.now()
  const { payload: _blockPayload, ...blockBase } = record
  const updated: BlockTombstone = {
    ...blockBase,
    updatedAt: tombstoneTime,
    deletedAt: tombstoneTime,
  }
  await recordStore.put(updated)

  await tx.done
  await rebuildRelationIndex(db, indexDb)
  await invalidateSearchIndex()
  return true
}

export const listSavedSystemPromptBlocks = async (): Promise<
  SavedSystemPromptBlock[]
> => {
  const db = await getDb()
  const [records, relations] = await Promise.all([
    db.getAll('records'),
    db.getAll('relations'),
  ])
  const blockById = new Map(
    records.filter(isBlockRecord).map((record) => [record.id, record]),
  )
  const promptsById = new Map<string, SavedSystemPromptBlock>()
  relations.forEach((relation) => {
    if (relation.type !== 'source') {
      return
    }
    const promptBlock = blockById.get(relation.fromId)
    const sourceBlock = blockById.get(relation.toId)
    if (!promptBlock || !sourceBlock || promptBlock.payload.role !== 'system') {
      return
    }
    const existing = promptsById.get(promptBlock.id)
    if (
      !existing ||
      sourceBlock.id.localeCompare(existing.sourceBlockId) < 0
    ) {
      promptsById.set(promptBlock.id, {
        promptBlock,
        sourceBlockId: sourceBlock.id,
      })
    }
  })
  const prompts = Array.from(promptsById.values())
  prompts.sort((left, right) => {
    if (left.promptBlock.createdAt !== right.promptBlock.createdAt) {
      return right.promptBlock.createdAt - left.promptBlock.createdAt
    }
    return left.promptBlock.id.localeCompare(right.promptBlock.id)
  })
  return prompts
}

export const searchBlocks = async (
  query: string,
  options?: {
    collectionId?: string
    limit?: number
  },
): Promise<BlockSearchResult[]> => {
  const rawQuery = query.trim()
  const normalizedQuery = normalizeSearchText(rawQuery)
  if (!normalizedQuery) {
    return []
  }
  const isSmartCaseSensitive = /[A-Z]/.test(rawQuery)

  const terms = tokenizeSearchTerms(normalizedQuery)
    .filter((term) => term.length >= SEARCH_TERM_MIN_LENGTH)
    .slice(0, SEARCH_TERM_MAX_COUNT)
  if (terms.length === 0) {
    return []
  }
  const caseSensitiveTerms = isSmartCaseSensitive
    ? tokenizeCaseSensitiveSearchTerms(rawQuery)
      .filter((term) => term.length >= SEARCH_TERM_MIN_LENGTH)
      .slice(0, SEARCH_TERM_MAX_COUNT)
    : []

  await ensureSearchIndexReady()
  const indexDb = await getIndexDb()
  const matchesByKey = new Map<
    string,
    {
      collectionId: string
      blockId: string
      matchedTerms: Set<string>
    }
  >()

  await Promise.all(
    terms.map(async (term) => {
      const entries = await indexDb.getAll(
        'block_term_index',
        getSearchTermPrefixIndexRange(term),
      )
      entries.forEach((entry) => {
        if (
          options?.collectionId &&
          entry.collectionId !== options.collectionId
        ) {
          return
        }
        const key = `${entry.collectionId}:${entry.blockId}`
        const existing = matchesByKey.get(key)
        if (existing) {
          existing.matchedTerms.add(term)
          return
        }
        matchesByKey.set(key, {
          collectionId: entry.collectionId,
          blockId: entry.blockId,
          matchedTerms: new Set([term]),
        })
      })
    }),
  )

  const candidates = Array.from(matchesByKey.values()).filter(
    (candidate) => candidate.matchedTerms.size === terms.length,
  )
  if (candidates.length === 0) {
    return []
  }

  const indexEntries = await Promise.all(
    candidates.map((candidate) =>
      indexDb.get('block_text_index', [candidate.collectionId, candidate.blockId]),
    ),
  )

  const results: BlockSearchResult[] = []
  indexEntries.forEach((entry, index) => {
    if (!entry) {
      return
    }
    const candidate = candidates[index]
    if (!candidate) {
      return
    }
    if (
      isSmartCaseSensitive &&
      !caseSensitiveTerms.every((term) => entry.content.includes(term))
    ) {
      return
    }
    const phraseMatched = isSmartCaseSensitive
      ? entry.content.includes(rawQuery)
      : entry.normalizedContent.includes(normalizedQuery)
    const matchedTermCount = isSmartCaseSensitive
      ? caseSensitiveTerms.length
      : candidate.matchedTerms.size
    const recencyDays = Math.max(
      0,
      (Date.now() - entry.blockCreatedAt) / (1000 * 60 * 60 * 24),
    )
    const recencyBoost = Math.max(0, 8 - Math.log10(recencyDays + 1) * 4)
    const score =
      matchedTermCount * 24 + (phraseMatched ? 30 : 0) + Math.round(recencyBoost)
    const snippet = buildSearchSnippet(
      entry.content,
      isSmartCaseSensitive ? caseSensitiveTerms : Array.from(candidate.matchedTerms),
      SEARCH_SNIPPET_LENGTH,
      isSmartCaseSensitive,
    )

    results.push({
      collectionId: entry.collectionId,
      blockId: entry.blockId,
      blockCreatedAt: entry.blockCreatedAt,
      role: entry.role,
      localTimestamp: entry.localTimestamp,
      snippet,
      score,
    })
  })

  const limit = Math.max(1, options?.limit ?? SEARCH_RESULT_DEFAULT_LIMIT)
  return results
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score
      }
      if (left.blockCreatedAt !== right.blockCreatedAt) {
        return right.blockCreatedAt - left.blockCreatedAt
      }
      if (left.collectionId !== right.collectionId) {
        return left.collectionId.localeCompare(right.collectionId)
      }
      return left.blockId.localeCompare(right.blockId)
    })
    .slice(0, limit)
}

export const listAllRecords = async () => {
  const db = await getDb()
  return db.getAll('records')
}

export const listAllRelations = async () => {
  const db = await getDb()
  return db.getAll('relations')
}

export const writeRecordsAndRelations = async (
  records: MirRecord[],
  relations: Relation[],
) => {
  const db = await getDb()
  const tx = db.transaction(['records', 'relations'], 'readwrite')
  const recordStore = tx.objectStore('records')
  const relationStore = tx.objectStore('relations')
  records.forEach((record) => {
    recordStore.put(record)
  })
  relations.forEach((relation) => {
    relationStore.put(relation)
  })
  await tx.done
  await invalidateSearchIndex()
}

export const indexCollectionsAndRelations = async (
  collections: CollectionRecord[],
  relations: Relation[],
) => {
  await Promise.all(collections.map((collection) => indexCollection(collection)))
  relations.forEach((relation) => {
    void indexRelation(relation)
  })
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

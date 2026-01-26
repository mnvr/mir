import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  Edge,
  EdgeRel,
  CollectionPayload,
  CollectionRecord,
  MessagePayload,
  MessageRecord,
  KvEntry,
  MirRecord,
  RecordKind,
} from 'mir-core'
import { createId, formatLocalTimestamp } from 'mir-core'

const DB_NAME = 'mir'
const DB_VERSION = 1

type MirDbSchema = DBSchema & {
  records: {
    key: string
    value: MirRecord
    indexes: { kind: RecordKind; updatedAt: number; deletedAt: number }
  }
  edges: {
    key: string
    value: Edge
    indexes: { fromId: string; toId: string; rel: EdgeRel; fromRel: [string, EdgeRel] }
  }
  kv: {
    key: string
    value: KvEntry
  }
}

let dbPromise: Promise<IDBPDatabase<MirDbSchema>> | null = null

const getDb = () => {
  if (!dbPromise) {
    dbPromise = openDB<MirDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const recordStore = db.createObjectStore('records', { keyPath: 'id' })
        recordStore.createIndex('kind', 'kind')
        recordStore.createIndex('updatedAt', 'updatedAt')
        recordStore.createIndex('deletedAt', 'deletedAt')

        const edgeStore = db.createObjectStore('edges', { keyPath: 'id' })
        edgeStore.createIndex('fromId', 'fromId')
        edgeStore.createIndex('toId', 'toId')
        edgeStore.createIndex('rel', 'rel')
        edgeStore.createIndex('fromRel', ['fromId', 'rel'])

        db.createObjectStore('kv')
      },
    })
  }

  return dbPromise
}

const buildRecord = <TKind extends RecordKind, TPayload>(
  kind: TKind,
  payload?: TPayload,
): MirRecord & { kind: TKind; payload?: TPayload } => {
  const now = Date.now()
  return {
    id: createId(kind),
    kind,
    createdAt: now,
    updatedAt: now,
    payload,
  }
}

const buildEdge = (
  fromId: string,
  toId: string,
  rel: EdgeRel,
  order?: number,
): Edge => {
  const now = Date.now()
  return {
    id: createId('edge'),
    fromId,
    toId,
    rel,
    order,
    createdAt: now,
  }
}

export const getOrCreateActiveCollection = async () => {
  const db = await getDb()
  const tx = db.transaction(['kv', 'records'], 'readwrite')
  const kvStore = tx.objectStore('kv')
  const recordStore = tx.objectStore('records')
  const existingId = await kvStore.get('activeCollectionId')
  if (typeof existingId === 'string') {
    const existing = await recordStore.get(existingId)
    if (existing && existing.kind === 'collection') {
      await tx.done
      return existing as CollectionRecord
    }
  }

  const collectionPayload: CollectionPayload = {
    localTimestamp: formatLocalTimestamp(new Date()),
  }
  const collection = buildRecord<
    CollectionRecord['kind'],
    CollectionPayload
  >('collection', collectionPayload)
  await recordStore.put(collection)
  await kvStore.put(collection.id, 'activeCollectionId')
  await tx.done
  return collection
}

export const listCollectionMessages = async (
  collectionId: string,
): Promise<MessageRecord[]> => {
  const db = await getDb()
  const edges = await db.getAllFromIndex('edges', 'fromRel', [
    collectionId,
    'contains',
  ])
  edges.sort((a, b) => {
    const left = a.order ?? a.createdAt
    const right = b.order ?? b.createdAt
    if (left !== right) {
      return left - right
    }
    return a.id.localeCompare(b.id)
  })

  const records = await Promise.all(
    edges.map((edge) => db.get('records', edge.toId)),
  )

  return records.filter((record): record is MessageRecord => {
    if (!record || record.kind !== 'message') {
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
  const record = buildRecord<MessageRecord['kind'], MessagePayload>(
    'message',
    payload,
  )
  const edge = buildEdge(
    collectionId,
    record.id,
    'contains',
    record.createdAt,
  )

  const tx = db.transaction(['records', 'edges'], 'readwrite')
  await tx.objectStore('records').put(record)
  await tx.objectStore('edges').put(edge)
  await tx.done

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

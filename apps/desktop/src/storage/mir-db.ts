import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  Edge,
  EdgeRel,
  InteractionPayload,
  InteractionRecord,
  MessagePayload,
  MessageRecord,
  MetaEntry,
  MirRecord,
  RecordKind,
  SearchDoc,
} from 'mir-core'

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
  search_docs: {
    key: string
    value: SearchDoc
    indexes: { recordId: string; scopeId: string; updatedAt: number }
  }
  meta: {
    key: string
    value: MetaEntry
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

        const searchStore = db.createObjectStore('search_docs', { keyPath: 'id' })
        searchStore.createIndex('recordId', 'recordId')
        searchStore.createIndex('scopeId', 'scopeId')
        searchStore.createIndex('updatedAt', 'updatedAt')

        db.createObjectStore('meta', { keyPath: 'key' })
      },
    })
  }

  return dbPromise
}

const createId = (prefix: string) => {
  const randomId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${randomId}`
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

export const getOrCreateActiveInteraction = async () => {
  const db = await getDb()
  const tx = db.transaction(['meta', 'records'], 'readwrite')
  const metaStore = tx.objectStore('meta')
  const recordStore = tx.objectStore('records')
  const metaEntry = await metaStore.get('activeInteractionId')
  const existingId = metaEntry?.value
  if (typeof existingId === 'string') {
    const existing = await recordStore.get(existingId)
    if (existing && existing.kind === 'interaction') {
      await tx.done
      return existing as InteractionRecord
    }
  }

  const interaction = buildRecord<InteractionRecord['kind'], InteractionPayload>(
    'interaction',
  )
  await recordStore.put(interaction)
  await metaStore.put({ key: 'activeInteractionId', value: interaction.id })
  await tx.done
  return interaction
}

export const listInteractionMessages = async (
  interactionId: string,
): Promise<MessageRecord[]> => {
  const db = await getDb()
  const edges = await db.getAllFromIndex('edges', 'fromRel', [
    interactionId,
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
  interactionId: string,
  payload: MessagePayload,
) => {
  const db = await getDb()
  const record = buildRecord<MessageRecord['kind'], MessagePayload>(
    'message',
    payload,
  )
  const edge = buildEdge(interactionId, record.id, 'contains', record.createdAt)

  const tx = db.transaction(['records', 'edges'], 'readwrite')
  await tx.objectStore('records').put(record)
  await tx.objectStore('edges').put(edge)
  await tx.done

  return record as MessageRecord
}

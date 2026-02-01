export type RecordType = 'collection' | 'block'

export type RelationType = 'contains' | 'parent'

export type BaseRecord = {
  id: string
  type: RecordType
  createdAt: number
  updatedAt: number
}

export type LiveRecord<TPayload> = BaseRecord & {
  deletedAt?: never
  payload: TPayload
}

export type TombstoneRecord = BaseRecord & {
  deletedAt: number
  payload?: never
}

export type CollectionPayload = {
  title?: string
  localTimestamp: string
}

export type CollectionRecord = LiveRecord<CollectionPayload> & {
  type: 'collection'
}

export type BlockBackend =
  | {
    kind: 'remote'
    baseUrl?: string
  }
  | {
    kind: 'local'
    engine?: string
  }

export type BlockRequest = {
  model?: string
  backend?: BlockBackend
  temperature?: number
}

export type BlockUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type BlockResponse = {
  id?: string
  model?: string
  usage?: BlockUsage
  latencyMs?: number
  finishReason?: string
}

export type BlockPayload = {
  role?: string
  content: string
  localTimestamp: string
  request?: BlockRequest
  response?: BlockResponse
}

export type BlockRecord = LiveRecord<BlockPayload> & {
  type: 'block'
}

export type CollectionTombstone = TombstoneRecord & {
  type: 'collection'
}

export type BlockTombstone = TombstoneRecord & {
  type: 'block'
}

export type MirRecord =
  | CollectionRecord
  | BlockRecord
  | CollectionTombstone
  | BlockTombstone

export type Relation = {
  id: string
  fromId: string
  toId: string
  type: RelationType
  createdAt: number
}

export type KvEntry = unknown /* JSON value */

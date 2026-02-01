export type RecordType = 'collection' | 'block'

export type RelationType = 'contains' | 'parent'

export type MirRecord = {
  id: string
  type: RecordType
  createdAt: number
  updatedAt: number
  payload: unknown
  deletedAt?: number
}

export type CollectionPayload = {
  title?: string
  localTimestamp: string
}

export type CollectionRecord = MirRecord & {
  type: 'collection'
  payload: CollectionPayload
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

export type BlockRecord = MirRecord & {
  type: 'block'
  payload: BlockPayload
}

export type Relation = {
  id: string
  fromId: string
  toId: string
  type: RelationType
  createdAt: number
}

export type KvEntry = unknown /* JSON value */

export type RecordType = 'collection' | 'message'

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

export type MessageBackend =
  | {
    kind: 'remote'
    baseUrl?: string
  }
  | {
    kind: 'local'
    engine?: string
  }

export type MessageRequest = {
  model?: string
  backend?: MessageBackend
  temperature?: number
}

export type MessageUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type MessageResponse = {
  id?: string
  model?: string
  usage?: MessageUsage
  latencyMs?: number
  finishReason?: string
}

export type MessagePayload = {
  role?: string
  content: string
  localTimestamp: string
  request?: MessageRequest
  response?: MessageResponse
}

export type MessageRecord = MirRecord & {
  type: 'message'
  payload: MessagePayload
}

export type Relation = {
  id: string
  fromId: string
  toId: string
  type: RelationType
  createdAt: number
}

export type KvEntry = unknown /* JSON value */

export type RecordKind = 'collection' | 'message'

export type EdgeRel = 'contains'

export type MirRecord = {
  id: string
  kind: RecordKind
  createdAt: number
  updatedAt: number
  payload?: unknown
  deletedAt?: number
}

export type CollectionPayload = {
  localTimestamp?: string
}

export type CollectionRecord = MirRecord & {
  kind: 'collection'
  payload?: CollectionPayload
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
}

export type MessagePayload = {
  role?: string
  content: string
  localTimestamp?: string
  request?: MessageRequest
  response?: MessageResponse
}

export type MessageRecord = MirRecord & {
  kind: 'message'
  payload: MessagePayload
}

export type Edge = {
  id: string
  fromId: string
  toId: string
  rel: EdgeRel
  order?: number
  createdAt: number
}

export type KvEntry = unknown

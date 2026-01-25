export type RecordKind = 'interaction' | 'message'

export type EdgeRel = 'contains'

export type MirRecord = {
  id: string
  kind: RecordKind
  createdAt: number
  updatedAt: number
  title?: string
  summary?: string
  payload?: unknown
  deletedAt?: number
}

export type InteractionPayload = {
  title?: string
  summary?: string
}

export type InteractionRecord = MirRecord & {
  kind: 'interaction'
  payload?: InteractionPayload
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
  id?: string
  model?: string
  backend?: MessageBackend
  params?: Record<string, unknown>
  n?: number
}

export type MessageUsage = {
  prompt: number
  completion: number
  total: number
}

export type MessageResponse = {
  id?: string
  model?: string
  usage?: MessageUsage
  latencyMs?: number
  choiceIndex?: number
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

export type SearchDoc = {
  id: string
  recordId: string
  scopeId?: string
  text: string
  updatedAt: number
}

export type MetaEntry = {
  key: string
  value: unknown
}

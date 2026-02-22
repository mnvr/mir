export type RecordType = 'collection' | 'block' | 'system_prompt_handle'

export type RelationType = 'contains' | 'parent' | 'source'

type BaseRecord = {
  id: string
  type: RecordType
  createdAt: number
  updatedAt: number
}

export type LiveRecord<TPayload> = BaseRecord & {
  deletedAt?: never
  payload: TPayload
}

type TombstoneRecord = BaseRecord & {
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

export type BlockRequest = {
  type?: 'remote' | 'local'
  baseUrl?: string
  engine?: string
  model?: string
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

export type SystemPromptHandlePayload = {
  promptBlockId: string
  inLibrary: boolean
}

export type SystemPromptHandleRecord = LiveRecord<SystemPromptHandlePayload> & {
  type: 'system_prompt_handle'
}

export type CollectionTombstone = TombstoneRecord & {
  type: 'collection'
}

export type BlockTombstone = TombstoneRecord & {
  type: 'block'
}

export type SystemPromptHandleTombstone = TombstoneRecord & {
  type: 'system_prompt_handle'
}

export type MirRecord =
  | CollectionRecord
  | BlockRecord
  | SystemPromptHandleRecord
  | CollectionTombstone
  | BlockTombstone
  | SystemPromptHandleTombstone

export type Relation = {
  id: string
  fromId: string
  toId: string
  type: RelationType
  createdAt: number
}

export type KvEntry = unknown /* JSON value */

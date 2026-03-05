import type { ReasoningEffort } from './storage'

export type ChatCompletionMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

type ChatCompletionRequest = {
  messages: ChatCompletionMessage[]
  model?: string
  temperature?: number
  reasoning_effort?: ReasoningEffort
}

export type ChatCompletionResponse = {
  id?: string
  model?: string
  reasoning_effort?: ReasoningEffort
  reasoning?: unknown
  reasoning_content?: unknown
  choices?: Array<{
    index?: number
    finish_reason?: string
    reasoning?: unknown
    reasoning_content?: unknown
    reasoning_effort?: ReasoningEffort
    message?: {
      content?: string
      role?: string
      reasoning?: unknown
      reasoning_content?: unknown
      reasoning_effort?: ReasoningEffort
    }
    text?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}

type AbortSignalLike = {
  aborted: boolean
}

type AbortControllerLike = {
  signal: AbortSignalLike
  abort: () => void
}

type FetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignalLike
}

type FetchResponse = {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

type FetchFn = (input: string, init?: FetchInit) => Promise<FetchResponse>

type ChatCompletionOptions = {
  baseUrl: string
  apiKey?: string
  messages: ChatCompletionMessage[]
  model?: string
  temperature?: number
  reasoningEffort?: ReasoningEffort
  fetchFn: FetchFn
  headers?: Record<string, string>
  signal?: AbortSignalLike
}

type TimeoutController = {
  signal?: AbortSignalLike
  abort: () => void
  clear: () => void
  didTimeout: () => boolean
}

type ParsedResponseError = {
  message?: string
  type?: string
  code?: string
}

const toErrorString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

const parseResponseErrorDetail = (detail: string): ParsedResponseError => {
  const trimmed = detail.trim()
  if (!trimmed) {
    return {}
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    const parsedRecord = parsed as Record<string, unknown>
    const nestedError =
      parsedRecord.error && typeof parsedRecord.error === 'object'
        ? (parsedRecord.error as Record<string, unknown>)
        : null
    return {
      message:
        toErrorString(nestedError?.message) ??
        toErrorString(parsedRecord.message),
      type:
        toErrorString(nestedError?.type) ??
        toErrorString(parsedRecord.type),
      code:
        toErrorString(nestedError?.code) ??
        toErrorString(parsedRecord.code),
    }
  } catch {
    return {}
  }
}

export class ChatCompletionRequestError extends Error {
  status?: number
  code?: string
  type?: string
  rawDetail?: string

  constructor(options: {
    message: string
    status?: number
    code?: string
    type?: string
    rawDetail?: string
  }) {
    super(options.message)
    this.name = 'ChatCompletionRequestError'
    this.status = options.status
    this.code = options.code
    this.type = options.type
    this.rawDetail = options.rawDetail
  }
}

const getAbortController = (): AbortControllerLike | null => {
  const controllerRef = (
    globalThis as typeof globalThis & {
      AbortController?: new () => AbortControllerLike
    }
  ).AbortController

  if (!controllerRef) {
    return null
  }

  return new controllerRef()
}

export const createTimeoutController = (timeoutMs: number): TimeoutController => {
  const controller = getAbortController()
  let timedOut = false
  if (!controller) {
    return {
      abort: () => {},
      clear: () => {},
      didTimeout: () => false,
    }
  }

  const abort = () => controller.abort()
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true
      abort()
    }, timeoutMs)
  }

  const clear = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
  }

  return {
    signal: controller.signal,
    abort,
    clear,
    didTimeout: () => timedOut,
  }
}

export const buildChatCompletionEndpoint = (baseUrl: string) => {
  if (!baseUrl) {
    return null
  }

  const normalized = baseUrl.replace(/\/+$/, '')
  return `${normalized}/chat/completions`
}

const extractAssistantContent = (
  data: ChatCompletionResponse,
): string | null => {
  if (!data || typeof data !== 'object') {
    return null
  }

  const choice = data.choices?.[0]
  if (!choice) {
    return null
  }

  if (choice.message?.content && typeof choice.message.content === 'string') {
    return choice.message.content
  }

  if (choice.text && typeof choice.text === 'string') {
    return choice.text
  }

  return null
}

export const createChatCompletion = async (
  options: ChatCompletionOptions,
) => {
  const endpoint = buildChatCompletionEndpoint(options.baseUrl)
  if (!endpoint) {
    throw new Error('Base URL is not set.')
  }

  const payload: ChatCompletionRequest = {
    messages: options.messages,
  }

  if (options.model) {
    payload.model = options.model
  }

  if (typeof options.temperature === 'number') {
    payload.temperature = options.temperature
  }

  if (options.reasoningEffort) {
    payload.reasoning_effort = options.reasoningEffort
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  }

  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`
  }

  const response = await options.fetchFn(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  })

  if (!response.ok) {
    const detail = await response.text()
    const parsed = detail ? parseResponseErrorDetail(detail) : {}
    const fallbackDetail = detail?.trim()
    const messageDetail = parsed.message ?? (fallbackDetail || undefined)
    const message = messageDetail
      ? `Request failed (${response.status}): ${messageDetail}`
      : `Request failed (${response.status}).`
    throw new ChatCompletionRequestError({
      message,
      status: response.status,
      code: parsed.code,
      type: parsed.type,
      rawDetail: detail || undefined,
    })
  }

  const data = (await response.json()) as ChatCompletionResponse
  const content = extractAssistantContent(data)

  if (!content) {
    throw new Error('No model response content returned.')
  }

  return { content, raw: data }
}

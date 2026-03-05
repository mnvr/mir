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
  if (!controller) {
    return {
      abort: () => {},
      clear: () => {},
    }
  }

  const abort = () => controller.abort()
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
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
    throw new Error(
      detail
        ? `Request failed (${response.status}): ${detail}`
        : `Request failed (${response.status}).`,
    )
  }

  const data = (await response.json()) as ChatCompletionResponse
  const content = extractAssistantContent(data)

  if (!content) {
    throw new Error('No model response content returned.')
  }

  return { content, raw: data }
}

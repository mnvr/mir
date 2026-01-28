import type { ChatCompletionResponse } from './chat'
import type {
  MessageBackend,
  MessagePayload,
  MessageRequest,
  MessageResponse,
  MessageUsage,
} from './storage'
import { formatLocalTimestamp } from './time'

export const buildMessageBackend = (
  baseUrl: string,
): MessageBackend | undefined => {
  if (!baseUrl) {
    return undefined
  }
  return { kind: 'remote', baseUrl }
}

export const buildMessageRequest = (
  baseUrl: string,
  model: string,
): MessageRequest | undefined => {
  const backend = buildMessageBackend(baseUrl)
  if (!backend && !model) {
    return undefined
  }
  return {
    model: model || undefined,
    backend,
  }
}

export const toMessageUsage = (
  response: ChatCompletionResponse,
): MessageUsage | undefined => {
  const usage = response.usage
  if (!usage) {
    return undefined
  }
  const prompt = usage.prompt_tokens
  const completion = usage.completion_tokens
  const total = usage.total_tokens
  if (
    typeof prompt !== 'number' ||
    typeof completion !== 'number' ||
    typeof total !== 'number'
  ) {
    return undefined
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
  }
}

export const buildMessageResponse = (
  response: ChatCompletionResponse,
  latencyMs?: number,
): MessageResponse | undefined => {
  const usage = toMessageUsage(response)
  const model = typeof response.model === 'string' ? response.model : undefined
  const id = typeof response.id === 'string' ? response.id : undefined
  const choice = response.choices?.[0]
  const finishReason =
    choice && typeof choice.finish_reason === 'string'
      ? choice.finish_reason
      : undefined
  const hasData =
    Boolean(usage) ||
    typeof latencyMs === 'number' ||
    Boolean(model) ||
    Boolean(id) ||
    Boolean(finishReason)
  if (!hasData) {
    return undefined
  }
  return {
    id,
    model,
    usage,
    latencyMs,
    finishReason,
  }
}

export const toMessagePayload = (
  role: string,
  content: string,
  options?: {
    request?: MessageRequest
    response?: MessageResponse
  },
): MessagePayload => ({
  role,
  content,
  localTimestamp: formatLocalTimestamp(new Date()),
  request: options?.request,
  response: options?.response,
})

export const formatMessageSource = (backend?: MessageBackend) => {
  if (!backend) {
    return null
  }
  if (backend.kind === 'remote') {
    return backend.baseUrl ?? 'remote'
  }
  return backend.engine ?? 'local'
}

export const formatLatency = (latencyMs?: number) => {
  if (typeof latencyMs !== 'number') {
    return null
  }
  return `${Math.round(latencyMs)} ms`
}

export const formatUsage = (usage?: MessageUsage) => {
  if (!usage) {
    return null
  }
  return `${usage.totalTokens} tokens`
}

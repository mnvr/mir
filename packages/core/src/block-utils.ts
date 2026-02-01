import type { ChatCompletionResponse } from './chat'
import type {
  BlockBackend,
  BlockPayload,
  BlockRequest,
  BlockResponse,
  BlockUsage,
} from './storage'
import { formatLocalTimestamp } from './time'

export const buildBlockBackend = (
  baseUrl: string,
): BlockBackend | undefined => {
  if (!baseUrl) {
    return undefined
  }
  return { kind: 'remote', baseUrl }
}

export const buildBlockRequest = (
  baseUrl: string,
  model: string,
  temperature?: number,
): BlockRequest | undefined => {
  const backend = buildBlockBackend(baseUrl)
  if (!backend && !model) {
    return undefined
  }
  return {
    model: model || undefined,
    backend,
    temperature:
      typeof temperature === 'number' && Number.isFinite(temperature)
        ? temperature
        : undefined,
  }
}

export const toBlockUsage = (
  response: ChatCompletionResponse,
): BlockUsage | undefined => {
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

export const buildBlockResponse = (
  response: ChatCompletionResponse,
  latencyMs?: number,
): BlockResponse | undefined => {
  const usage = toBlockUsage(response)
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

export const toBlockPayload = (
  role: string,
  content: string,
  options?: {
    request?: BlockRequest
    response?: BlockResponse
  },
): BlockPayload => ({
  role,
  content,
  localTimestamp: formatLocalTimestamp(new Date()),
  request: options?.request,
  response: options?.response,
})

export const formatBlockSource = (backend?: BlockBackend) => {
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

export const formatUsage = (usage?: BlockUsage) => {
  if (!usage) {
    return null
  }
  return `${usage.totalTokens} tokens`
}

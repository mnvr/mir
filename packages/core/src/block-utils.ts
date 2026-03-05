import type { ChatCompletionResponse } from './chat'
import type {
  BlockPayload,
  BlockRequest,
  BlockResponse,
  ReasoningEffort,
  BlockUsage,
} from './storage'
import { formatLocalTimestamp } from './time'

const REASONING_EFFORT_VALUES = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
])
const MAX_REASONING_TRACE_COUNT = 24
const MAX_REASONING_TRACE_LENGTH = 2000

const toReasoningEffort = (value: unknown): ReasoningEffort | undefined =>
  typeof value === 'string' && REASONING_EFFORT_VALUES.has(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined

export const buildBlockRequest = (
  baseUrl: string,
  model: string,
  temperature?: number,
  reasoningEffort?: ReasoningEffort,
): BlockRequest | undefined => {
  if (!baseUrl && !model && !reasoningEffort) {
    return undefined
  }
  return {
    type: baseUrl ? 'remote' : undefined,
    baseUrl: baseUrl || undefined,
    model: model || undefined,
    temperature:
      typeof temperature === 'number' && Number.isFinite(temperature)
        ? temperature
        : undefined,
    reasoningEffort,
  }
}

const toBlockUsage = (
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
  const reasoningTokens =
    typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
      ? usage.completion_tokens_details.reasoning_tokens
      : undefined
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    reasoningTokens,
  }
}

const normalizeReasoningTrace = (value: string) => {
  const normalized = value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASONING_TRACE_LENGTH)
  return normalized.length > 0 ? normalized : null
}

const collectReasoningTraces = (
  value: unknown,
  traces: string[],
  seen: Set<string>,
  depth = 0,
) => {
  if (depth > 4 || value === null || value === undefined) {
    return
  }
  if (traces.length >= MAX_REASONING_TRACE_COUNT) {
    return
  }
  if (typeof value === 'string') {
    const normalized = normalizeReasoningTrace(value)
    if (!normalized || seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    traces.push(normalized)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      collectReasoningTraces(entry, traces, seen, depth + 1)
    })
    return
  }
  if (typeof value !== 'object') {
    return
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if (
      typeof entry === 'string' &&
      /(reason|trace|summary|content|text)/i.test(key)
    ) {
      collectReasoningTraces(entry, traces, seen, depth + 1)
      return
    }
    if (Array.isArray(entry) || (entry && typeof entry === 'object')) {
      collectReasoningTraces(entry, traces, seen, depth + 1)
    }
  })
}

const extractReasoningTraces = (
  response: ChatCompletionResponse,
): string[] | undefined => {
  const choice = response.choices?.[0]
  const candidates: unknown[] = [
    response.reasoning,
    response.reasoning_content,
    choice?.reasoning,
    choice?.reasoning_content,
    choice?.message?.reasoning,
    choice?.message?.reasoning_content,
  ]
  const traces: string[] = []
  const seen = new Set<string>()
  candidates.forEach((candidate) => {
    collectReasoningTraces(candidate, traces, seen)
  })
  return traces.length > 0 ? traces : undefined
}

const extractResponseReasoningEffort = (
  response: ChatCompletionResponse,
  fallbackReasoningEffort?: ReasoningEffort,
): ReasoningEffort | undefined => {
  const choice = response.choices?.[0]
  return (
    toReasoningEffort(choice?.message?.reasoning_effort) ??
    toReasoningEffort(choice?.reasoning_effort) ??
    toReasoningEffort(response.reasoning_effort) ??
    fallbackReasoningEffort
  )
}

export const buildBlockResponse = (
  response: ChatCompletionResponse,
  latencyMs?: number,
  options?: {
    requestReasoningEffort?: ReasoningEffort
  },
): BlockResponse | undefined => {
  const usage = toBlockUsage(response)
  const model = typeof response.model === 'string' ? response.model : undefined
  const id = typeof response.id === 'string' ? response.id : undefined
  const choice = response.choices?.[0]
  const finishReason =
    choice && typeof choice.finish_reason === 'string'
      ? choice.finish_reason
      : undefined
  const reasoningEffort = extractResponseReasoningEffort(
    response,
    options?.requestReasoningEffort,
  )
  const reasoningTraces = extractReasoningTraces(response)
  const hasData =
    Boolean(usage) ||
    typeof latencyMs === 'number' ||
    Boolean(model) ||
    Boolean(id) ||
    Boolean(finishReason) ||
    Boolean(reasoningEffort) ||
    Boolean(reasoningTraces?.length)
  if (!hasData) {
    return undefined
  }
  return {
    id,
    model,
    usage,
    latencyMs,
    finishReason,
    reasoningEffort,
    reasoningTraces,
  }
}

export const toBlockPayload = (
  role: string,
  content: string,
  options?: {
    request?: BlockRequest
    response?: BlockResponse
    rootContextId?: string
  },
): BlockPayload => ({
  role,
  content,
  localTimestamp: formatLocalTimestamp(new Date()),
  request: options?.request,
  response: options?.response,
  rootContextId: options?.rootContextId,
})

export const formatLatency = (latencyMs?: number) => {
  if (typeof latencyMs !== 'number') {
    return null
  }
  return `${Math.round(latencyMs)} ms`
}

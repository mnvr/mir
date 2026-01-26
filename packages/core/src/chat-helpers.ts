import type { ChatCompletionMessage } from './chat'
import type { CollectionRecord, MessagePayload } from './storage'

const DAY_MS = 24 * 60 * 60 * 1000

const formatDayGroupLabel = (date: Date, todayStart: Date) => {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round(
    (todayStart.getTime() - dayStart.getTime()) / DAY_MS,
  )

  if (diffDays === 0) {
    return 'Today'
  }

  if (diffDays === 1) {
    return 'Yesterday'
  }

  if (diffDays < 7 && diffDays > 0) {
    return dayStart.toLocaleDateString('en-US', { weekday: 'long' })
  }

  return dayStart.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export const groupCollectionsByDay = (collections: CollectionRecord[]) => {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const groups = new Map<
    string,
    { key: string; label: string; time: number; collections: CollectionRecord[] }
  >()

  collections.forEach((collection) => {
    const createdAt = new Date(collection.createdAt)
    if (Number.isNaN(createdAt.getTime())) {
      const key = 'undated'
      const existing = groups.get(key)
      if (existing) {
        existing.collections.push(collection)
        return
      }
      groups.set(key, {
        key,
        label: 'Undated',
        time: 0,
        collections: [collection],
      })
      return
    }

    const dayStart = new Date(
      createdAt.getFullYear(),
      createdAt.getMonth(),
      createdAt.getDate(),
    )
    const key = dayStart.toISOString()
    const existing = groups.get(key)
    if (existing) {
      existing.collections.push(collection)
      return
    }
    groups.set(key, {
      key,
      label: formatDayGroupLabel(dayStart, todayStart),
      time: dayStart.getTime(),
      collections: [collection],
    })
  })

  return Array.from(groups.values())
    .sort((a, b) => b.time - a.time)
    .map((group) => ({
      ...group,
      collections: group.collections.slice().sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return b.createdAt - a.createdAt
        }
        return a.id.localeCompare(b.id)
      }),
    }))
}

const isChatRole = (
  role: MessagePayload['role'],
): role is ChatCompletionMessage['role'] =>
  role === 'user' || role === 'assistant' || role === 'system'

export const toChatMessages = (
  payloads: MessagePayload[],
): ChatCompletionMessage[] =>
  payloads
    .filter(
      (payload): payload is MessagePayload & {
        role: ChatCompletionMessage['role']
      } => isChatRole(payload.role),
    )
    .map(({ role, content }) => ({ role, content }))

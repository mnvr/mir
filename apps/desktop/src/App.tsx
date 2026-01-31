import {
  buildChatCompletionEndpoint,
  createChatCompletion,
  createTimeoutController,
  demoCollection,
  demoCollectionMessages,
  formatLocalTimestamp,
  formatLocalTimestampHeading,
  groupCollectionsByDay,
  parseLocalTimestampDate,
  buildMessageRequest,
  buildMessageResponse,
  toMessagePayload,
  formatMessageSource,
  formatLatency,
  toChatMessages,
  type CollectionPayload,
  type CollectionRecord,
  type MessagePayload,
  type MessageRecord,
} from 'mir-core'
import {
  memo,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  appendMessage,
  createCollection,
  deleteKvValue,
  getActiveCollection,
  getKvValue,
  listCollections,
  listCollectionMessages,
  setActiveCollectionId,
  setKvValue,
  updateCollectionTitle,
} from './services/db'
import './App.css'

type MessageDirection = 'input' | 'output'

type Message = {
  id: string
  direction: MessageDirection
  content: string
  payload?: MessagePayload
  status?: 'pending' | 'error' | 'canceled'
}

type PendingScroll = {
  id: string
  mode: 'bottom' | 'read'
}

type StorageMode = 'secure' | 'session'

const STORAGE_KEYS = {
  apiKeySession: 'mir.chat.apiKey.session',
}

const KV_KEYS = {
  baseUrl: 'settings.baseUrl',
  model: 'settings.model',
  apiKeyEncrypted: 'settings.apiKey.encrypted',
}

const NEW_COLLECTION_TITLE = 'New Collection'
const TEMPERATURE_PRESETS = [0, 0.2, 0.5, 0.7, 1, 1.2, 1.5, 2]
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform)

const REQUEST_TIMEOUT_MS = 60_000
const TICK_INTERVAL_MS = 1000
const TICK_TRAIL_LIMIT = 30
const SCROLL_CONTEXT_PEEK_LINES = 3
const SCROLL_CONTEXT_PEEK_FALLBACK_PX = 48
const SCROLL_NEAR_BOTTOM_RATIO = 0.5
const SCROLL_STICK_BOTTOM_PX = 8

const MARKDOWN_PLUGINS = [remarkGfm]

const demoCollections = [demoCollection]

const messageDirectionForRole = (role?: string): MessageDirection =>
  role === 'user' ? 'input' : 'output'

const isPersistedMessageId = (id: string) => id.startsWith('message_')

const getLatestPersistedMessageId = (messages: Message[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message?.payload) {
      continue
    }
    if (!isPersistedMessageId(message.id)) {
      continue
    }
    return message.id
  }
  return null
}

const recordToMessage = (record: MessageRecord): Message => ({
  id: record.id,
  direction: messageDirectionForRole(record.payload.role),
  content: record.payload.content,
  payload: record.payload,
})

const getCollectionTitle = (collection: CollectionRecord) =>
  collection.payload.title!

const getCollectionTimestamp = (collection: CollectionRecord) =>
  collection.payload.localTimestamp

const deriveCollectionTitle = (content: string) => {
  const lines = content.split('\n').map((line) => line.trim())
  const firstLine = lines.find((line) => line.length > 0) ?? content.trim()
  return firstLine.slice(0, 120)
}

const formatTokenCount = (count?: number) =>
  typeof count === 'number' ? `${count.toLocaleString()} tokens` : null

const formatMessageCount = (count: number) =>
  `${count} message${count === 1 ? '' : 's'}`

const formatLatencySeconds = (latencyMs?: number) => {
  if (typeof latencyMs !== 'number') {
    return null
  }
  const seconds = Math.round((latencyMs / 1000) * 10) / 10
  return `${seconds} s`
}

const formatQuickTimestamp = (localTimestamp?: string) => {
  if (!localTimestamp) {
    return null
  }
  const match = localTimestamp.match(/\b(\d{2}):(\d{2})\b/)
  if (!match) {
    return localTimestamp
  }
  const [_, hours, minutes] = match
  const hoursNumber = Number(hours)
  if (!Number.isFinite(hoursNumber)) {
    return localTimestamp
  }
  const period = hoursNumber >= 12 ? 'PM' : 'AM'
  const hours12 = hoursNumber % 12 === 0 ? 12 : hoursNumber % 12
  const timeLabel = `${hours12}:${minutes} ${period}`
  const parsed = parseLocalTimestampDate(localTimestamp)
  if (!parsed) {
    return timeLabel
  }
  return `${parsed.weekdayShort} ${parsed.monthShort} ${parsed.day} · ${timeLabel}`
}
const hasSecureBridge = () =>
  typeof window !== 'undefined' &&
  typeof window.ipcRenderer?.invoke === 'function'

const checkSecureStorage = async () => {
  if (!hasSecureBridge()) {
    return false
  }

  try {
    return Boolean(await window.ipcRenderer.invoke('secrets:is-available'))
  } catch {
    return false
  }
}

const encryptSecret = async (plainText: string) => {
  if (!hasSecureBridge()) {
    throw new Error('Secure storage is unavailable.')
  }

  return (await window.ipcRenderer.invoke(
    'secrets:encrypt',
    plainText,
  )) as string
}

const decryptSecret = async (cipherText: string) => {
  if (!hasSecureBridge()) {
    throw new Error('Secure storage is unavailable.')
  }

  return (await window.ipcRenderer.invoke(
    'secrets:decrypt',
    cipherText,
  )) as string
}

type MessageRowProps = {
  message: Message
  isActive: boolean
  onMouseDown: () => void
  onClick: (id: string) => void
  registerRef: (id: string, node: HTMLDivElement | null) => void
}

const TickTrail = memo(function TickTrail() {
  const [ticks, setTicks] = useState<number[]>(() => {
    const tickId = Date.now()
    return [tickId]
  })

  useEffect(() => {
    let tickId = Date.now()
    const interval = window.setInterval(() => {
      tickId += 1
      setTicks((prev) => {
        const next = [...prev, tickId]
        if (next.length > TICK_TRAIL_LIMIT) {
          next.splice(0, next.length - TICK_TRAIL_LIMIT)
        }
        return next
      })
    }, TICK_INTERVAL_MS)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  if (ticks.length === 0) {
    return null
  }

  return (
    <div className="message-ticks" aria-hidden="true">
      {ticks.map((tick, index) => {
        const total = ticks.length
        const opacity = total <= 1 ? 0.7 : 0.2 + (0.6 * (index + 1)) / total
        return (
          <span
            key={tick}
            className="message-tick"
            style={{ opacity }}
          />
        )
      })}
    </div>
  )
})

const MessageRow = memo(function MessageRow({
  message,
  isActive,
  onMouseDown,
  onClick,
  registerRef,
}: MessageRowProps) {
  return (
    <div
      ref={(node) => registerRef(message.id, node)}
      data-message-id={message.id}
      className={`message ${message.direction}${
        message.status ? ` ${message.status}` : ''
      }${isActive ? ' selected' : ''}`}
      onMouseDown={onMouseDown}
      onClick={(event) => {
        event.stopPropagation()
        onClick(message.id)
      }}
    >
      {message.direction === 'input' ? (
        <blockquote className="input-quote">
          <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
            {message.content}
          </ReactMarkdown>
        </blockquote>
      ) : (
        <>
          <div className="output-markdown">
            <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
              {message.content}
            </ReactMarkdown>
          </div>
          {message.status === 'pending' ? <TickTrail /> : null}
        </>
      )}
    </div>
  )
})

type ChatPaneProps = {
  messages: Message[]
  activeMessageId: string | null
  showEmptyState: boolean
  endRef: React.RefObject<HTMLDivElement | null>
  onChatClick: (event: MouseEvent<HTMLElement>) => void
  onMessageMouseDown: () => void
  onMessageClick: (id: string) => void
  registerMessageRef: (id: string, node: HTMLDivElement | null) => void
}

const ChatPane = memo(function ChatPane({
  messages,
  activeMessageId,
  showEmptyState,
  endRef,
  onChatClick,
  onMessageMouseDown,
  onMessageClick,
  registerMessageRef,
}: ChatPaneProps) {
  return (
    <main className="chat" onClick={onChatClick}>
      {messages.length === 0 && showEmptyState ? (
        <div className="chat-empty">
          <div className="chat-empty-title">No context yet</div>
          <div className="chat-empty-body">
            Add a message to start building context
          </div>
        </div>
      ) : (
        <div className="chat-stream">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              isActive={message.id === activeMessageId}
              onMouseDown={onMessageMouseDown}
              onClick={onMessageClick}
              registerRef={registerMessageRef}
            />
          ))}
        </div>
      )}
      <div className="chat-end" ref={endRef} />
    </main>
  )
})

function App() {
  const appRef = useRef<HTMLDivElement | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [hasLoadedMessages, setHasLoadedMessages] = useState(false)
  const [draft, setDraft] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [storageMode, setStorageMode] = useState<StorageMode>('session')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [temperature, setTemperature] = useState(1)
  const [showKey, setShowKey] = useState(false)
  const [suppressKeyTooltip, setSuppressKeyTooltip] = useState(false)
  const [suppressNewCollectionTooltip, setSuppressNewCollectionTooltip] =
    useState(false)
  const [suppressSettingsTooltip, setSuppressSettingsTooltip] = useState(false)
  const [suppressSidebarTooltip, setSuppressSidebarTooltip] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [collections, setCollections] = useState<CollectionRecord[]>([])
  const [pendingCollection, setPendingCollection] =
    useState<CollectionPayload | null>(null)
  const [activeCollection, setActiveCollection] =
    useState<CollectionRecord | null>(null)
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const [selectedCollectionId, setSelectedCollectionId] =
    useState<string | null>(null)
  const [sidebarTab, setSidebarTab] = useState<'chats' | 'inspect'>(
    'chats',
  )
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [lastRunStats, setLastRunStats] = useState<{
    completionTokens?: number
    latencyMs?: number
  } | null>(null)
  const [copyAckId, setCopyAckId] = useState<string | null>(null)
  const copyAckTimeoutRef = useRef<number | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const mainColumnRef = useRef<HTMLDivElement | null>(null)
  const contextRailRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const suppressMessageActivationRef = useRef(false)
  const abortControllerRef = useRef<ReturnType<typeof createTimeoutController> | null>(null)
  const scrollIgnoreUntilRef = useRef(0)
  const pendingScrollRef = useRef<PendingScroll | null>(null)
  const followRef = useRef(true)
  const stickToBottomRef = useRef(true)
  const nearBottomBreakRef = useRef(0)
  const submitFollowBreakRef = useRef<number | null>(null)
  const collectionLoadIdRef = useRef(0)
  const openSettingsRef = useRef<() => void>(() => {})
  const toggleSidebarRef = useRef<() => void>(() => {})
  const sidebarTabRef = useRef<(tab: unknown) => void>(() => {})
  const startNewCollectionRef = useRef<() => void>(() => {})
  const submitContinuationRef = useRef<() => void>(() => {})
  const submitContinuationMultilineRef = useRef<() => void>(() => {})
  const insertNewlineRef = useRef<() => void>(() => {})
  const focusComposerRef = useRef<() => void>(() => {})
  const selectPreviousMessageRef = useRef<() => void>(() => {})
  const selectNextMessageRef = useRef<() => void>(() => {})
  const scrollToTopRef = useRef<() => void>(() => {})
  const scrollToEndRef = useRef<() => void>(() => {})
  const sendMessageGuardRef = useRef(false)
  const maxRows = 9
  const hasNewline = draft.includes('\n')
  const trimmedDraft = draft.trim()
  const draftRef = useRef(draft)
  const trimmedDraftRef = useRef(trimmedDraft)
  const hasNewlineRef = useRef(hasNewline)
  const isSendingRef = useRef(isSending)
  const sendMessageRef = useRef<(() => Promise<void>) | null>(null)
  const activeMessage = useMemo(
    () => messages.find((message) => message.id === activeMessageId) ?? null,
    [activeMessageId, messages],
  )
  const activePayload = activeMessage?.payload
  const activeWordMatches = useMemo(
    () => (activeMessage ? activeMessage.content.match(/\S+/g) : null),
    [activeMessage],
  )
  const groupedCollections = useMemo(
    () => groupCollectionsByDay(collections),
    [collections],
  )
  const inspectorStats = useMemo(
    () =>
      activeMessage
        ? {
            characters: activeMessage.content.length,
            words: activeWordMatches ? activeWordMatches.length : 0,
          }
        : null,
    [activeMessage, activeWordMatches],
  )
  const inspectorMeta = useMemo(
    () =>
      activePayload
        ? {
            role: activePayload.role,
            requestModel: activePayload.request?.model,
            temperature: activePayload.request?.temperature,
            responseModel: activePayload.response?.model,
            responseId: activePayload.response?.id,
            finishReason: activePayload.response?.finishReason,
            localTimestamp: activePayload.localTimestamp,
            latencyMs: activePayload.response?.latencyMs,
            usage: activePayload.response?.usage,
            backend: activePayload.request?.backend,
          }
        : null,
    [activePayload],
  )
  const isAssistantMessage = inspectorMeta?.role === 'assistant'
  const completionTokensValue = inspectorMeta?.usage?.completionTokens
  const latencySeconds = formatLatencySeconds(inspectorMeta?.latencyMs)
  const quickFacts = useMemo(() => {
    const items: Array<{ key: string; content: React.ReactNode }> = []
    const quickTime = formatQuickTimestamp(inspectorMeta?.localTimestamp)
    if (quickTime) {
      items.push({ key: 'time', content: quickTime })
    }
    if (isAssistantMessage) {
      const quickModel =
        inspectorMeta?.requestModel ?? inspectorMeta?.responseModel ?? null
      if (quickModel) {
        items.push({ key: 'model', content: quickModel })
      }
      if (typeof completionTokensValue === 'number' || latencySeconds) {
        items.push({
          key: 'tokens-latency',
          content: (
            <>
              {typeof completionTokensValue === 'number'
                ? `${completionTokensValue.toLocaleString()} tokens`
                : null}
              {typeof completionTokensValue === 'number' && latencySeconds
                ? ', '
                : null}
              {latencySeconds ?? null}
            </>
          ),
        })
      }
    }
    return items
  }, [
    completionTokensValue,
    inspectorMeta?.localTimestamp,
    inspectorMeta?.requestModel,
    inspectorMeta?.responseModel,
    isAssistantMessage,
    latencySeconds,
  ])
  const promptTokens = formatTokenCount(inspectorMeta?.usage?.promptTokens)
  const completionTokens = formatTokenCount(
    inspectorMeta?.usage?.completionTokens,
  )
  const totalTokens = formatTokenCount(inspectorMeta?.usage?.totalTokens)
  const contextTokens = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const usage = messages[index]?.payload?.response?.usage
      if (usage?.totalTokens) {
        return usage.totalTokens
      }
    }
    return null
  }, [messages])
  const lastRunLatency = formatLatencySeconds(lastRunStats?.latencyMs)
  const lastRunTokensLabel =
    typeof lastRunStats?.completionTokens === 'number'
      ? `+${lastRunStats.completionTokens.toLocaleString()}`
      : '—'
  const lastRunLatencyLabel = lastRunLatency ?? '—'
  const showLastRun =
    Boolean(lastRunStats) &&
    (lastRunTokensLabel !== '—' || lastRunLatencyLabel !== '—')
  const lastRunBullet = (() => {
    if (lastRunTokensLabel === '—' && lastRunLatencyLabel === '—') {
      return '—'
    }
    if (lastRunTokensLabel === '—') {
      return lastRunLatencyLabel
    }
    if (lastRunLatencyLabel === '—') {
      return lastRunTokensLabel
    }
    return `${lastRunTokensLabel} · ${lastRunLatencyLabel}`
  })()
  const collectionTimestamp =
    activeCollection?.payload.localTimestamp ?? pendingCollection?.localTimestamp
  const collectionDateLabel = formatLocalTimestampHeading(collectionTimestamp)
  const collectionMessageCountLabel = formatMessageCount(messages.length)
  const modelLabel = model || 'Default'
  const temperatureLabel = temperature.toFixed(1)

  const upsertCollection = useCallback((collection: CollectionRecord) => {
    setCollections((prev) => {
      const next = prev.filter((item) => item.id !== collection.id)
      return [collection, ...next]
    })
  }, [])

  const updateSidebarOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setIsSidebarOpen((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next
        window.ipcRenderer?.send?.('sidebar:state', resolved)
        return resolved
      })
    },
    [],
  )
  const toggleSidebarTab = useCallback(
    (tab: 'chats' | 'inspect') => {
      updateSidebarOpen((prev) => !(prev && sidebarTab === tab))
      setSidebarTab(tab)
    },
    [sidebarTab, updateSidebarOpen],
  )

  useEffect(() => {
    openSettingsRef.current = () => {
      setIsSettingsOpen(true)
    }
  }, [])

  useEffect(() => {
    toggleSidebarRef.current = () => {
      updateSidebarOpen((prev) => !prev)
    }
  }, [updateSidebarOpen])

  useEffect(() => {
    sidebarTabRef.current = (tab: unknown) => {
      if (tab !== 'chats' && tab !== 'inspect') {
        return
      }
      toggleSidebarTab(tab)
    }
  }, [toggleSidebarTab])

  useEffect(() => {
    let isMounted = true

    const loadSettings = async () => {
      try {
        const [storedBaseUrl, storedModel] = await Promise.all([
          getKvValue<string>(KV_KEYS.baseUrl),
          getKvValue<string>(KV_KEYS.model),
        ])
        if (!isMounted) {
          return
        }
        const nextBaseUrl =
          typeof storedBaseUrl === 'string' ? storedBaseUrl : ''
        const nextModel =
          typeof storedModel === 'string' ? storedModel : ''
        setBaseUrl(nextBaseUrl)
        setModel(nextModel)
        setIsSettingsOpen(!nextBaseUrl)
        setSettingsLoaded(true)
      } catch {
        if (isMounted) {
          setIsSettingsOpen(true)
          setSettingsLoaded(true)
        }
      }
    }

    void loadSettings()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!settingsLoaded) {
      return
    }
    if (baseUrl === '') {
      void deleteKvValue(KV_KEYS.baseUrl)
      return
    }
    void setKvValue(KV_KEYS.baseUrl, baseUrl)
  }, [baseUrl, settingsLoaded])

  useEffect(() => {
    if (!settingsLoaded) {
      return
    }
    if (model === '') {
      void deleteKvValue(KV_KEYS.model)
      return
    }
    void setKvValue(KV_KEYS.model, model)
  }, [model, settingsLoaded])

  useEffect(() => {
    if (isSettingsOpen) {
      setShowKey(false)
    }
  }, [isSettingsOpen])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleOpenSettings = () => {
      openSettingsRef.current()
    }

    window.ipcRenderer.on('open-settings', handleOpenSettings)

    return () => {
      window.ipcRenderer.off('open-settings', handleOpenSettings)
    }
  }, [])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleToggleSidebar = () => {
      toggleSidebarRef.current()
    }

    window.ipcRenderer.on('sidebar:toggle', handleToggleSidebar)

    return () => {
      window.ipcRenderer.off('sidebar:toggle', handleToggleSidebar)
    }
  }, [])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleSidebarTab = (_event: unknown, tab: unknown) => {
      sidebarTabRef.current(tab)
    }

    window.ipcRenderer.on('sidebar:tab', handleSidebarTab)

    return () => {
      window.ipcRenderer.off('sidebar:tab', handleSidebarTab)
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    const loadCollections = async () => {
      try {
        const storedCollections = await listCollections()
        if (!isMounted) {
          return
        }
        setCollections(storedCollections)
      } catch {
        // Ignore local persistence failures on cold start.
      }
    }

    const loadMessages = async () => {
      setHasLoadedMessages(false)
      try {
        const collection = await getActiveCollection()
        if (!isMounted) {
          return
        }
        if (!collection) {
          setCollectionId(null)
          setActiveCollection(null)
          setPendingCollection(null)
          setSelectedCollectionId(null)
          setMessages([])
          setHasLoadedMessages(true)
          return
        }
        const storedMessages = await listCollectionMessages(collection.id)
        if (!isMounted) {
          return
        }
        setCollectionId(collection.id)
        setActiveCollection(collection)
        setPendingCollection(null)
        setSelectedCollectionId(collection.id)
        setMessages(storedMessages.map(recordToMessage))
        setHasLoadedMessages(true)
        if (storedMessages.length > 0) {
          pendingScrollRef.current = { mode: 'bottom', id: '' }
        }
      } catch {
        // Ignore local persistence failures on cold start.
        if (isMounted) {
          setHasLoadedMessages(true)
        }
      }
    }

    void loadCollections()
    void loadMessages()

    return () => {
      isMounted = false
    }
  }, [])

  const focusComposer = useCallback(() => {
    setActiveMessageId(null)
    const textarea = textareaRef.current
    if (textarea) {
      textarea.focus()
      const end = textarea.value.length
      textarea.setSelectionRange(end, end)
    }
  }, [])

  const blurComposer = useCallback(() => {
    const textarea = textareaRef.current
    if (textarea && document.activeElement === textarea) {
      textarea.blur()
    }
  }, [])

  const markProgrammaticScroll = useCallback(() => {
    scrollIgnoreUntilRef.current = Date.now() + 200
  }, [])

  const scrollToMessage = useCallback((messageId: string) => {
    setActiveMessageId(messageId)
    window.requestAnimationFrame(() => {
      messageRefs.current
        .get(messageId)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }, [])

  const selectPreviousMessage = useCallback(() => {
    if (!messages.length) {
      return
    }

    const currentIndex = activeMessageId
      ? messages.findIndex((message) => message.id === activeMessageId)
      : -1

    if (currentIndex === -1) {
      scrollToMessage(messages[messages.length - 1].id)
      return
    }

    if (currentIndex > 0) {
      scrollToMessage(messages[currentIndex - 1].id)
    }
  }, [activeMessageId, messages, scrollToMessage])

  const selectNextMessage = useCallback(() => {
    if (!messages.length) {
      return
    }

    const currentIndex = activeMessageId
      ? messages.findIndex((message) => message.id === activeMessageId)
      : -1

    if (currentIndex === -1 || currentIndex >= messages.length - 1) {
      focusComposer()
      return
    }

    scrollToMessage(messages[currentIndex + 1].id)
  }, [activeMessageId, messages, focusComposer, scrollToMessage])


  useEffect(() => {
    const handleArrowNavigation = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return
      }

      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return
      }

      const target = event.target as HTMLElement | null
      const isTextarea = target === textareaRef.current
      const isEditable =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')

      if (isEditable && !isTextarea) {
        return
      }

      if (isTextarea) {
        if (event.key !== 'ArrowUp') {
          return
        }

        const textarea = textareaRef.current
        if (!textarea) {
          return
        }

        const selectionStart = textarea.selectionStart ?? 0
        const selectionEnd = textarea.selectionEnd ?? 0
        if (selectionStart !== 0 || selectionEnd !== 0) {
          return
        }

        event.preventDefault()
        textarea.blur()
        selectPreviousMessage()
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        selectPreviousMessage()
        return
      }
      event.preventDefault()
      selectNextMessage()
    }

    window.addEventListener('keydown', handleArrowNavigation)
    return () => {
      window.removeEventListener('keydown', handleArrowNavigation)
    }
  }, [selectNextMessage, selectPreviousMessage])

  const handleCopyActiveMessage = useCallback(() => {
    if (!activeMessage) {
      return
    }
    const messageId = activeMessage.id
    void navigator.clipboard
      ?.writeText(activeMessage.content)
      .then(() => {
        setCopyAckId(messageId)
        if (copyAckTimeoutRef.current) {
          window.clearTimeout(copyAckTimeoutRef.current)
        }
        copyAckTimeoutRef.current = window.setTimeout(() => {
          setCopyAckId((prev) => (prev === messageId ? null : prev))
        }, 2000)
      })
      .catch(() => {})
  }, [activeMessage])

  useEffect(() => {
    if (copyAckId && activeMessage?.id !== copyAckId) {
      setCopyAckId(null)
    }
  }, [activeMessage?.id, copyAckId])

  useEffect(() => {
    return () => {
      if (copyAckTimeoutRef.current) {
        window.clearTimeout(copyAckTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const handleCopyShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return
      }

      if (!(event.metaKey || event.ctrlKey)) {
        return
      }

      if (event.key.toLowerCase() !== 'c') {
        return
      }

      const selection = window.getSelection()
      if (selection && selection.toString().length > 0) {
        return
      }

      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return
      }

      if (!activeMessage) {
        return
      }

      event.preventDefault()
      void handleCopyActiveMessage()
    }

    window.addEventListener('keydown', handleCopyShortcut)
    return () => {
      window.removeEventListener('keydown', handleCopyShortcut)
    }
  }, [activeMessage, handleCopyActiveMessage])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleFocusComposer = () => {
      focusComposerRef.current()
    }
    const handleSelectPrevious = () => {
      selectPreviousMessageRef.current()
    }
    const handleSelectNext = () => {
      selectNextMessageRef.current()
    }
    const handleScrollTop = () => {
      scrollToTopRef.current()
    }
    const handleScrollEnd = () => {
      scrollToEndRef.current()
    }

    window.ipcRenderer.on('composer:focus', handleFocusComposer)
    window.ipcRenderer.on('selection:prev', handleSelectPrevious)
    window.ipcRenderer.on('selection:next', handleSelectNext)
    window.ipcRenderer.on('scroll:top', handleScrollTop)
    window.ipcRenderer.on('scroll:end', handleScrollEnd)

    return () => {
      window.ipcRenderer.off('composer:focus', handleFocusComposer)
      window.ipcRenderer.off('selection:prev', handleSelectPrevious)
      window.ipcRenderer.off('selection:next', handleSelectNext)
      window.ipcRenderer.off('scroll:top', handleScrollTop)
      window.ipcRenderer.off('scroll:end', handleScrollEnd)
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    const loadSecrets = async () => {
      const secureAvailable = await checkSecureStorage()
      if (!isMounted) {
        return
      }

      setStorageMode(secureAvailable ? 'secure' : 'session')

      let nextKey = ''
      if (secureAvailable) {
        const encrypted = await getKvValue<string>(KV_KEYS.apiKeyEncrypted)
        if (encrypted) {
          try {
            nextKey = await decryptSecret(encrypted)
          } catch {
            await deleteKvValue(KV_KEYS.apiKeyEncrypted)
            setKeyError('Saved key could not be decrypted. Please re-enter it.')
          }
        }
        sessionStorage.removeItem(STORAGE_KEYS.apiKeySession)
      } else {
        nextKey = sessionStorage.getItem(STORAGE_KEYS.apiKeySession) ?? ''
      }

      if (!isMounted) {
        return
      }

      setApiKey(nextKey)
      setSettingsReady(true)
    }

    void loadSecrets()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!settingsReady) {
      return
    }

    const timeout = window.setTimeout(() => {
      const persist = async () => {
        if (storageMode === 'secure') {
          sessionStorage.removeItem(STORAGE_KEYS.apiKeySession)

          if (!apiKey) {
            await deleteKvValue(KV_KEYS.apiKeyEncrypted)
            setKeyError(null)
            return
          }

          try {
            const encrypted = await encryptSecret(apiKey)
            await setKvValue(KV_KEYS.apiKeyEncrypted, encrypted)
            setKeyError(null)
          } catch {
            setKeyError('Unable to save key securely on this device.')
          }
        } else {
          if (!apiKey) {
            sessionStorage.removeItem(STORAGE_KEYS.apiKeySession)
          } else {
            sessionStorage.setItem(STORAGE_KEYS.apiKeySession, apiKey)
          }
          setKeyError(null)
        }
      }

      void persist()
    }, 250)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [apiKey, settingsReady, storageMode])

  const getNearBottomThresholdPx = useCallback(
    (container: HTMLElement | null) => {
      const height = container?.clientHeight ?? window.innerHeight
      return Math.round(height * SCROLL_NEAR_BOTTOM_RATIO)
    },
    [],
  )

  const getBottomDistancePx = useCallback((container: HTMLElement | null) => {
    if (container) {
      return (
        container.scrollHeight - (container.scrollTop + container.clientHeight)
      )
    }
    const doc = document.documentElement
    const scrollTop = window.scrollY ?? doc.scrollTop
    const scrollHeight = doc.scrollHeight
    const clientHeight = window.innerHeight
    return scrollHeight - (scrollTop + clientHeight)
  }, [])

  const isNearBottom = useCallback(() => {
    const container = mainColumnRef.current
    const threshold = getNearBottomThresholdPx(container)
    return getBottomDistancePx(container) <= threshold
  }, [getBottomDistancePx, getNearBottomThresholdPx])

  const isAtBottom = useCallback(() => {
    const container = mainColumnRef.current
    return getBottomDistancePx(container) <= SCROLL_STICK_BOTTOM_PX
  }, [getBottomDistancePx])

  const getScrollPeekPx = useCallback((element: HTMLElement | null) => {
    if (!element) {
      return SCROLL_CONTEXT_PEEK_FALLBACK_PX
    }
    const computed = window.getComputedStyle(element)
    const lineHeight = Number.parseFloat(computed.lineHeight)
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
      return SCROLL_CONTEXT_PEEK_FALLBACK_PX
    }
    return Math.round(lineHeight * SCROLL_CONTEXT_PEEK_LINES)
  }, [])

  const handleMainScroll = useCallback(() => {
    if (Date.now() < scrollIgnoreUntilRef.current) {
      return
    }
    const container = mainColumnRef.current
    const bottomDistance = getBottomDistancePx(container)
    const isBottom = bottomDistance <= getNearBottomThresholdPx(container)
    const isStuck = bottomDistance <= SCROLL_STICK_BOTTOM_PX
    if (followRef.current && !isBottom) {
      nearBottomBreakRef.current += 1
    }
    followRef.current = isBottom
    stickToBottomRef.current = isStuck
  }, [getBottomDistancePx, getNearBottomThresholdPx])

  useEffect(() => {
    draftRef.current = draft
    trimmedDraftRef.current = trimmedDraft
    hasNewlineRef.current = hasNewline
    isSendingRef.current = isSending
  }, [draft, trimmedDraft, hasNewline, isSending])

  useLayoutEffect(() => {
    followRef.current = isNearBottom()
    stickToBottomRef.current = isAtBottom()
  }, [isAtBottom, isNearBottom, messages.length])

  const queueScrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      markProgrammaticScroll()
      const container = mainColumnRef.current
      if (container) {
        const maxScrollTop = container.scrollHeight - container.clientHeight
        container.scrollTop = Math.max(0, maxScrollTop)
      } else {
        endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
      }
      followRef.current = true
      stickToBottomRef.current = true
    })
  }, [markProgrammaticScroll])

  const queueScrollToMessageForReading = useCallback((messageId: string) => {
    window.requestAnimationFrame(() => {
      const container = mainColumnRef.current
      const node = messageRefs.current.get(messageId)
      if (!container || !node) {
        queueScrollToBottom()
        return
      }
      const containerRect = container.getBoundingClientRect()
      const railRect = contextRailRef.current?.getBoundingClientRect()
      const effectiveBottom = railRect?.top ?? containerRect.bottom
      const availableHeight = effectiveBottom - containerRect.top
      if (availableHeight <= 0) {
        queueScrollToBottom()
        return
      }
      const nodeRect = node.getBoundingClientRect()
      const rawPeekPx = getScrollPeekPx(node)
      const peekPx = Math.min(rawPeekPx, availableHeight * 0.5)
      const desiredTop = containerRect.top + peekPx
      const delta = nodeRect.top - desiredTop
      if (Math.abs(delta) < 1 && nodeRect.bottom <= effectiveBottom) {
        followRef.current = isNearBottom()
        stickToBottomRef.current = isAtBottom()
        return
      }
      const nextScrollTop = container.scrollTop + delta
      const maxScrollTop = container.scrollHeight - container.clientHeight
      markProgrammaticScroll()
      container.scrollTop = Math.min(
        Math.max(nextScrollTop, 0),
        maxScrollTop,
      )
      followRef.current = isNearBottom()
      stickToBottomRef.current = isAtBottom()
    })
  }, [getScrollPeekPx, isAtBottom, isNearBottom, markProgrammaticScroll, queueScrollToBottom])

  const scrollToTop = useCallback(() => {
    window.requestAnimationFrame(() => {
      markProgrammaticScroll()
      const container = mainColumnRef.current
      if (container) {
        container.scrollTop = 0
      } else {
        window.scrollTo({ top: 0 })
      }
      followRef.current = false
      stickToBottomRef.current = false
    })
  }, [markProgrammaticScroll])

  const scrollToEnd = useCallback(() => {
    queueScrollToBottom()
  }, [queueScrollToBottom])

  useEffect(() => {
    focusComposerRef.current = focusComposer
    selectPreviousMessageRef.current = selectPreviousMessage
    selectNextMessageRef.current = selectNextMessage
    scrollToTopRef.current = scrollToTop
    scrollToEndRef.current = scrollToEnd
  }, [
    focusComposer,
    scrollToEnd,
    scrollToTop,
    selectNextMessage,
    selectPreviousMessage,
  ])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasPrimaryModifier = IS_MAC ? event.metaKey : event.ctrlKey
      if (!hasPrimaryModifier) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setActiveMessageId(null)
          blurComposer()
        }
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        scrollToTop()
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        scrollToEnd()
        return
      }

      const key = event.key.toLowerCase()
      if (key === 'b') {
        event.preventDefault()
        updateSidebarOpen((prev) => !prev)
        return
      }

      if (key === 'l') {
        event.preventDefault()
        focusComposer()
        return
      }

      if (key === 'i') {
        event.preventDefault()
        toggleSidebarTab('inspect')
        return
      }

      if (key === 'e') {
        event.preventDefault()
        toggleSidebarTab('chats')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    blurComposer,
    focusComposer,
    scrollToEnd,
    scrollToTop,
    toggleSidebarTab,
    updateSidebarOpen,
  ])


  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }

    const container = mainColumnRef.current
    const wasAtBottom =
      container &&
      getBottomDistancePx(container) <= SCROLL_STICK_BOTTOM_PX
    stickToBottomRef.current = Boolean(wasAtBottom)

    textarea.style.height = 'auto'
    const computed = window.getComputedStyle(textarea)
    const lineHeight = Number.parseFloat(computed.lineHeight)
    const maxHeight = lineHeight ? lineHeight * maxRows : 200
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${nextHeight}px`

    if (container && wasAtBottom) {
      markProgrammaticScroll()
      const maxScrollTop = container.scrollHeight - container.clientHeight
      container.scrollTop = Math.max(0, maxScrollTop)
    }
  }, [draft, getBottomDistancePx, markProgrammaticScroll, maxRows])

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current
    if (!pending) {
      return
    }
    pendingScrollRef.current = null
    if (pending.mode === 'bottom') {
      queueScrollToBottom()
      return
    }
    queueScrollToMessageForReading(pending.id)
  }, [messages, queueScrollToBottom, queueScrollToMessageForReading])

  useLayoutEffect(() => {
    const appEl = appRef.current
    const composerEl = composerRef.current
    if (!appEl || !composerEl) {
      return
    }

    const updateLayoutHeights = () => {
      appEl.style.setProperty(
        '--composer-height',
        `${composerEl.offsetHeight}px`,
      )
    }

    updateLayoutHeights()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      updateLayoutHeights()
    })

    observer.observe(composerEl)
    return () => {
      observer.disconnect()
    }
  }, [])

  const handleToggleApiKey = () => {
    setShowKey((prev) => !prev)
    setSuppressKeyTooltip(true)
  }

  const handleToggleSettings = () => {
    setIsSettingsOpen((prev) => !prev)
    setSuppressSettingsTooltip(true)
  }

  const handleToggleSidebar = () => {
    updateSidebarOpen((prev) => !prev)
    setSuppressSidebarTooltip(true)
  }

  const startNewCollection = useCallback(() => {
    setSuppressNewCollectionTooltip(true)
    setSelectedCollectionId(null)
    setMessages([])
    setDraft('')
    setCollectionId(null)
    setActiveCollection(null)
    setPendingCollection({
      title: NEW_COLLECTION_TITLE,
      localTimestamp: formatLocalTimestamp(new Date()),
    })
    setActiveMessageId(null)
    setLastRunStats(null)

    focusComposer()
  }, [focusComposer])

  useEffect(() => {
    startNewCollectionRef.current = startNewCollection
  }, [startNewCollection])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleNewCollection = () => {
      void startNewCollectionRef.current()
    }

    window.ipcRenderer.on('collection:new', handleNewCollection)

    return () => {
      window.ipcRenderer.off('collection:new', handleNewCollection)
    }
  }, [])

  const stopRequest = () => {
    abortControllerRef.current?.abort()
  }

  const isAbortError = (error: unknown) =>
    error instanceof Error && error.name === 'AbortError'

  const sendMessage = async () => {
    if (!trimmedDraft || isSending || sendMessageGuardRef.current) {
      return
    }
    sendMessageGuardRef.current = true

    try {
      const parentMessageId = getLatestPersistedMessageId(messages)
      const derivedTitle = deriveCollectionTitle(trimmedDraft)
      const endpoint = buildChatCompletionEndpoint(baseUrl)
      const request = buildMessageRequest(baseUrl, model, temperature)
      const timestamp = Date.now()
      const userPayload = toMessagePayload('user', trimmedDraft, {
        request,
      })
      const userMessage: Message = {
        id: `m-${timestamp}-input`,
        direction: 'input',
        content: trimmedDraft,
        payload: userPayload,
      }

      const assistantMessage: Message = {
        id: `m-${timestamp}-output`,
        direction: 'output',
        content: 'Generating continuation…',
        status: 'pending',
      }

      setMessages((prev) => [...prev, userMessage, assistantMessage])
      setDraft('')
      const shouldAutoScroll = isNearBottom()
      followRef.current = shouldAutoScroll

      if (shouldAutoScroll) {
        submitFollowBreakRef.current = nearBottomBreakRef.current
        pendingScrollRef.current = { id: assistantMessage.id, mode: 'bottom' }
      } else {
        submitFollowBreakRef.current = null
      }

      let targetCollectionId = collectionId
      let userRecordPromise: Promise<MessageRecord | null> | null = null
      if (!selectedCollectionId && !targetCollectionId) {
        try {
          const pendingTitle = pendingCollection?.title
          const pendingTimestamp = pendingCollection?.localTimestamp
          const collection = await createCollection({
            title:
              pendingTitle && pendingTitle !== NEW_COLLECTION_TITLE
                ? pendingTitle
                : derivedTitle,
            localTimestamp:
              pendingTimestamp ?? formatLocalTimestamp(new Date()),
          })
          targetCollectionId = collection.id
          setCollectionId(collection.id)
          setActiveCollection(collection)
          setPendingCollection(null)
          upsertCollection(collection)
        } catch {
          targetCollectionId = null
        }
      }

      if (
        targetCollectionId &&
        messages.length === 0 &&
        activeCollection?.id === targetCollectionId &&
        activeCollection.payload.title === NEW_COLLECTION_TITLE &&
        activeCollection.id !== demoCollection.id
      ) {
        void updateCollectionTitle(targetCollectionId, derivedTitle)
          .then((updated) => {
            if (!updated) {
              return
            }
            setActiveCollection(updated)
            upsertCollection(updated)
          })
          .catch(() => {})
      }

      if (targetCollectionId && selectedCollectionId !== demoCollection.id) {
        const pendingUserRecord = appendMessage(
          targetCollectionId,
          userPayload,
          {
            parentIds: parentMessageId ? [parentMessageId] : undefined,
          },
        )
        userRecordPromise = pendingUserRecord
        void pendingUserRecord
          .then((record) => {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === userMessage.id
                  ? { ...message, id: record.id }
                  : message,
              ),
            )
            setActiveMessageId((prev) =>
              prev === userMessage.id ? record.id : prev,
            )
          })
          .catch(() => {})
      }

      if (!endpoint) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  content:
                    'Error: Add a base URL (OPENAI_BASE_URL style) in Connection settings first.',
                  status: 'error',
                }
              : message,
          ),
        )
        return
      }

      const contextPayloads = [...messages, userMessage]
        .filter(
          (
            message,
          ): message is Message & { payload: MessagePayload } =>
            !message.status && Boolean(message.payload),
        )
        .map((message) => message.payload)
      const contextMessages = toChatMessages(contextPayloads)
      const token = apiKey
      const timeoutController = createTimeoutController(REQUEST_TIMEOUT_MS)
      abortControllerRef.current = timeoutController
      setIsSending(true)
      const requestStart = Date.now()

      try {
        const { content: nextContent, raw } = await createChatCompletion({
          baseUrl,
          apiKey: token || undefined,
          messages: contextMessages,
          model: model || undefined,
          temperature,
          fetchFn: (input, init) =>
            window.fetch(input, init as RequestInit | undefined),
          signal: timeoutController.signal,
        })
        const latencyMs = Date.now() - requestStart
        const response = buildMessageResponse(raw, latencyMs)
        setLastRunStats({
          completionTokens: response?.usage?.completionTokens,
          latencyMs,
        })
        const assistantPayload = toMessagePayload('assistant', nextContent, {
          request,
          response,
        })

        const shouldAutoScroll =
          submitFollowBreakRef.current !== null &&
          submitFollowBreakRef.current === nearBottomBreakRef.current
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  content: nextContent,
                  status: undefined,
                  payload: assistantPayload,
                }
              : message,
          ),
        )
        if (targetCollectionId && selectedCollectionId !== demoCollection.id) {
          let assistantParentId: string | null = null
          if (userRecordPromise) {
            const userRecord = await userRecordPromise.catch(() => null)
            assistantParentId = userRecord?.id ?? null
          }
          void appendMessage(
            targetCollectionId,
            assistantPayload,
            {
              parentIds: assistantParentId ? [assistantParentId] : undefined,
            },
          )
            .then((record) => {
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === assistantMessage.id
                    ? { ...message, id: record.id, content: nextContent }
                    : message,
                ),
              )
              setActiveMessageId((prev) =>
                prev === assistantMessage.id ? record.id : prev,
              )
            })
            .catch(() => {})
        }
        if (shouldAutoScroll) {
          pendingScrollRef.current = { id: assistantMessage.id, mode: 'read' }
        }
      } catch (error) {
        if (isAbortError(error)) {
          const shouldAutoScroll =
            submitFollowBreakRef.current !== null &&
            submitFollowBreakRef.current === nearBottomBreakRef.current
          setMessages((prev) =>
            prev.map((item) =>
              item.id === assistantMessage.id
                ? { ...item, content: 'Request stopped.', status: 'canceled' }
                : item,
            ),
          )
          if (shouldAutoScroll) {
            pendingScrollRef.current = { id: assistantMessage.id, mode: 'read' }
          }
          return
        }
        const message =
          error instanceof Error ? error.message : 'Unknown error occurred.'
        const shouldAutoScroll =
          submitFollowBreakRef.current !== null &&
          submitFollowBreakRef.current === nearBottomBreakRef.current
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantMessage.id
              ? { ...item, content: `Error: ${message}`, status: 'error' }
              : item,
          ),
        )
        if (shouldAutoScroll) {
          pendingScrollRef.current = { id: assistantMessage.id, mode: 'read' }
        }
      } finally {
        setIsSending(false)
        timeoutController.clear()
        abortControllerRef.current = null
        submitFollowBreakRef.current = null
      }
    } finally {
      sendMessageGuardRef.current = false
    }
  }

  sendMessageRef.current = sendMessage

  const handleSubmitContinuation = useCallback(() => {
    if (
      isSendingRef.current ||
      !trimmedDraftRef.current ||
      hasNewlineRef.current
    ) {
      return
    }
    void sendMessageRef.current?.()
  }, [])

  const handleSubmitContinuationMultiline = useCallback(() => {
    if (isSendingRef.current || !trimmedDraftRef.current) {
      return
    }
    void sendMessageRef.current?.()
  }, [])

  const handleInsertNewline = useCallback(() => {
    if (isSendingRef.current) {
      return
    }
    const textarea = textareaRef.current
    if (!textarea) {
      setDraft((prev) => `${prev}\n`)
      return
    }
    const selectionStart = textarea.selectionStart ?? draftRef.current.length
    const selectionEnd = textarea.selectionEnd ?? draftRef.current.length
    const next =
      draftRef.current.slice(0, selectionStart) +
      '\n' +
      draftRef.current.slice(selectionEnd)
    setDraft(next)
    window.requestAnimationFrame(() => {
      textarea.focus()
      const cursor = selectionStart + 1
      textarea.setSelectionRange(cursor, cursor)
    })
  }, [])

  useEffect(() => {
    submitContinuationRef.current = handleSubmitContinuation
    submitContinuationMultilineRef.current = handleSubmitContinuationMultiline
    insertNewlineRef.current = handleInsertNewline
  }, [
    handleInsertNewline,
    handleSubmitContinuation,
    handleSubmitContinuationMultiline,
  ])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleSubmit = () => {
      submitContinuationRef.current()
    }
    const handleSubmitMultiline = () => {
      submitContinuationMultilineRef.current()
    }
    const handleInsert = () => {
      insertNewlineRef.current()
    }

    window.ipcRenderer.on('composer:submit', handleSubmit)
    window.ipcRenderer.on('composer:submit-multiline', handleSubmitMultiline)
    window.ipcRenderer.on('composer:insert-newline', handleInsert)
    return () => {
      window.ipcRenderer.off('composer:submit', handleSubmit)
      window.ipcRenderer.off('composer:submit-multiline', handleSubmitMultiline)
      window.ipcRenderer.off('composer:insert-newline', handleInsert)
    }
  }, [])

  const handleChatClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null
    if (!target) {
      return
    }
    if (target.closest('.message')) {
      return
    }
    setActiveMessageId(null)
  }, [])

  const hasTextSelection = useCallback(() => {
    const selection = window.getSelection()
    return Boolean(selection && selection.toString().length > 0)
  }, [])

  const handleMessageMouseDown = useCallback(() => {
    if (hasTextSelection()) {
      suppressMessageActivationRef.current = true
    }
  }, [hasTextSelection])

  const handleMessageClick = useCallback(
    (messageId: string) => {
      if (suppressMessageActivationRef.current || hasTextSelection()) {
        suppressMessageActivationRef.current = false
        return
      }
      suppressMessageActivationRef.current = false
      setActiveMessageId((prev) => (prev === messageId ? null : messageId))
    },
    [hasTextSelection],
  )

  const registerMessageRef = useCallback(
    (id: string, node: HTMLDivElement | null) => {
      const current = messageRefs.current
      if (!node) {
        current.delete(id)
        return
      }
      current.set(id, node)
    },
    [],
  )

  const handleSidebarTabClick = (tab: 'chats' | 'inspect') => {
    setSidebarTab(tab)
    updateSidebarOpen(true)
  }

  const handleSelectCollection = (collection: CollectionRecord) => {
    const requestId = collectionLoadIdRef.current + 1
    collectionLoadIdRef.current = requestId
    setSelectedCollectionId(collection.id)
    setCollectionId(collection.id)
    setActiveCollection(collection)
    setPendingCollection(null)
    setActiveMessageId(null)
    setLastRunStats(null)

    if (collection.id === demoCollection.id) {
      setHasLoadedMessages(false)
      setMessages(demoCollectionMessages.map(recordToMessage))
      setHasLoadedMessages(true)
      if (demoCollectionMessages.length > 0) {
        pendingScrollRef.current = { mode: 'bottom', id: '' }
      }
      return
    }

    setHasLoadedMessages(false)
    setMessages([])
    void setActiveCollectionId(collection.id)
    void listCollectionMessages(collection.id)
      .then((records) => {
        if (collectionLoadIdRef.current !== requestId) {
          return
        }
        setMessages(records.map(recordToMessage))
        setHasLoadedMessages(true)
        if (records.length > 0) {
          pendingScrollRef.current = { mode: 'bottom', id: '' }
        }
      })
      .catch(() => {
        if (collectionLoadIdRef.current !== requestId) {
          return
        }
        setMessages([])
        setHasLoadedMessages(true)
      })
  }

  return (
    <div className={`app${isSettingsOpen ? ' settings-open' : ''}`} ref={appRef}>
      <div className={`layout${isSidebarOpen ? ' sidebar-open' : ''}`}>
        <div className="main-stack">
          <header className="header">
            <div className="header-left">
              <div className="header-meta">
                <div className="header-subtitle">
                  {isSettingsOpen
                    ? 'Settings'
                    : collectionDateLabel ?? 'Undated'}
                </div>
              </div>
              <div className="header-actions">
                <span
                  className={`tooltip tooltip-bottom tooltip-hover-only${suppressNewCollectionTooltip ? ' tooltip-suppressed' : ''}`}
                  data-tooltip="New Collection"
                  onMouseLeave={() => setSuppressNewCollectionTooltip(false)}
                >
                  <button
                    className="new-chat-toggle"
                    type="button"
                    onClick={() => {
                      void startNewCollection()
                    }}
                    aria-label="New Collection"
                    onBlur={() => setSuppressNewCollectionTooltip(false)}
                  >
                    <span
                      className="codicon codicon-symbol-file"
                      aria-hidden="true"
                    />
                  </button>
                </span>
                <span
                  className={`tooltip tooltip-bottom tooltip-hover-only${suppressSettingsTooltip ? ' tooltip-suppressed' : ''}`}
                  data-tooltip="Settings"
                  onMouseLeave={() => setSuppressSettingsTooltip(false)}
                >
                  <button
                    className="settings-toggle"
                    type="button"
                    onClick={handleToggleSettings}
                    aria-label="Toggle settings"
                    aria-expanded={isSettingsOpen}
                    aria-controls="settings-panel"
                    onBlur={() => setSuppressSettingsTooltip(false)}
                  >
                    <span className="codicon codicon-gear" aria-hidden="true" />
                  </button>
                </span>
                <span
                  className={`tooltip tooltip-bottom tooltip-hover-only${suppressSidebarTooltip ? ' tooltip-suppressed' : ''}`}
                  data-tooltip={
                    isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'
                  }
                  onMouseLeave={() => setSuppressSidebarTooltip(false)}
                >
                  <button
                    className="sidebar-toggle"
                    type="button"
                    onClick={handleToggleSidebar}
                    aria-label="Toggle sidebar"
                    aria-pressed={isSidebarOpen}
                    aria-expanded={isSidebarOpen}
                    aria-controls="sidebar"
                    onBlur={() => setSuppressSidebarTooltip(false)}
                  >
                    <span
                      className={`codicon ${
                        isSidebarOpen
                          ? 'codicon-layout-sidebar-right'
                          : 'codicon-layout-sidebar-right-off'
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                </span>
              </div>
            </div>
          </header>
          <div
            className="main-column"
            ref={mainColumnRef}
            onScroll={handleMainScroll}
          >
            {isSettingsOpen ? (
              <section className="settings" id="settings-panel">
                <div className="settings-inner">
                  <div className="settings-heading">Connection</div>
                  <div className="settings-grid">
                    <label className="settings-field">
                      <span>Base URL</span>
                      <input
                        className="settings-input"
                        type="url"
                        placeholder="https://api.openai.com/v1"
                        value={baseUrl}
                        spellCheck={false}
                        onChange={(event) =>
                          setBaseUrl(event.target.value.trim())
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Model</span>
                      <input
                        className="settings-input"
                        type="text"
                        placeholder="gpt-5.2"
                        value={model}
                        spellCheck={false}
                        onChange={(event) =>
                          setModel(event.target.value.trim())
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>API key</span>
                      <div className="settings-input-wrap">
                        <input
                          className="settings-input"
                          type={showKey ? 'text' : 'password'}
                          placeholder={
                            storageMode === 'secure'
                              ? 'Stored securely on this device'
                              : 'Stored for this session only'
                          }
                          value={apiKey}
                          spellCheck={false}
                          onChange={(event) =>
                            setApiKey(event.target.value.trim())
                          }
                        />
                        <span
                          className={`tooltip tooltip-inline tooltip-hover-only${suppressKeyTooltip ? ' tooltip-suppressed' : ''}`}
                          data-tooltip={
                            showKey ? 'Hide API key' : 'Show API key'
                          }
                          onMouseLeave={() => setSuppressKeyTooltip(false)}
                        >
                          <button
                            className="settings-button"
                            type="button"
                            onClick={handleToggleApiKey}
                            aria-label={
                              showKey ? 'Hide API key' : 'Show API key'
                            }
                            onBlur={() => setSuppressKeyTooltip(false)}
                          >
                            <span
                              className={`codicon ${showKey ? 'codicon-eye-closed' : 'codicon-eye'}`}
                              aria-hidden="true"
                            />
                          </button>
                        </span>
                      </div>
                    </label>
                  </div>
                  <div
                    className={`settings-note${
                      storageMode === 'session' ? ' warning' : ''
                    }`}
                  >
                    {storageMode === 'secure'
                      ? "API keys are saved using the device safe storage."
                      : 'Secure storage is unavailable. API keys are kept only for this session.'}
                  </div>
                  {keyError ? (
                    <div className="settings-error">{keyError}</div>
                  ) : null}
                </div>
              </section>
            ) : null}
            <ChatPane
              messages={messages}
              activeMessageId={activeMessageId}
              showEmptyState={hasLoadedMessages}
              endRef={endRef}
              onChatClick={handleChatClick}
              onMessageMouseDown={handleMessageMouseDown}
              onMessageClick={handleMessageClick}
              registerMessageRef={registerMessageRef}
            />
          </div>
          <div
            className="context-rail"
            aria-label="Context controls"
            ref={contextRailRef}
          >
            <div className="context-rail-meta">
              <span className="context-rail-title">Context</span>
              <span className="context-rail-value">
                {contextTokens ? `${contextTokens.toLocaleString()} tokens` : '—'}
              </span>
              {showLastRun ? (
                <span className="context-rail-run">{lastRunBullet}</span>
              ) : null}
            </div>
          </div>
          <footer className="composer" ref={composerRef}>
            <div className="composer-box">
              <textarea
                ref={textareaRef}
                className="composer-input"
                placeholder="Add tokens"
                value={draft}
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') {
                    return
                  }

                  if (event.shiftKey) {
                    return
                  }

                  if (event.metaKey || event.ctrlKey) {
                    event.preventDefault()
                    void sendMessage()
                    return
                  }

                  if (hasNewline || isSending) {
                    return
                  }

                  event.preventDefault()
                  void sendMessage()
                }}
                rows={1}
              />
              <div className="composer-actions">
                <div className="composer-controls">
                  <button
                    className="composer-chip"
                    type="button"
                    aria-label="Model settings"
                  >
                    <span className="composer-chip-label">Model</span>
                    <span className="composer-chip-value">{modelLabel}</span>
                  </button>
                  <button
                    className="composer-chip"
                    type="button"
                    aria-label="Temperature settings"
                    onClick={() =>
                      setTemperature((prev) => {
                        const rounded = Math.round(prev * 10) / 10
                        const currentIndex = TEMPERATURE_PRESETS.findIndex(
                          (value) => value === rounded,
                        )
                        const nextIndex =
                          currentIndex === -1
                            ? TEMPERATURE_PRESETS.indexOf(1)
                            : (currentIndex + 1) % TEMPERATURE_PRESETS.length
                        return TEMPERATURE_PRESETS[nextIndex] ?? 1
                      })
                    }
                  >
                    <span className="composer-chip-label">Temp</span>
                    <span className="composer-chip-value">
                      {temperatureLabel}
                    </span>
                  </button>
                </div>
                {isSending ? (
                  <span className="tooltip tooltip-hover-only" data-tooltip="Stop continuation">
                    <button
                      className="send-button"
                      type="button"
                      onClick={stopRequest}
                      aria-label="Stop continuation"
                    >
                      <span className="codicon codicon-debug-stop" aria-hidden="true" />
                    </button>
                  </span>
                ) : (
                  <span>
                    <button
                      className="send-button"
                      type="button"
                      onClick={() => void sendMessage()}
                      disabled={!trimmedDraft}
                      aria-label="Add to context"
                    >
                      <span className="codicon codicon-arrow-up" aria-hidden="true" />
                    </button>
                  </span>
                )}
              </div>
            </div>
          </footer>
        </div>

        <aside className="sidebar" id="sidebar" aria-hidden={!isSidebarOpen}>
          <div className="sidebar-header">
            <div
              className="sidebar-tabs"
              role="tablist"
              aria-label="Sidebar panels"
            >
              <span
                className="tooltip tooltip-bottom tooltip-left tooltip-hover-only"
                data-tooltip="Collections"
              >
                <button
                  className={`sidebar-tab${sidebarTab === 'chats' ? ' active' : ''}`}
                  type="button"
                  onClick={() => handleSidebarTabClick('chats')}
                  role="tab"
                  aria-selected={sidebarTab === 'chats'}
                  aria-controls="sidebar-panel"
                  aria-label="Collections panel"
                >
                  <span
                    className="codicon codicon-list-unordered"
                    aria-hidden="true"
                  />
                </button>
              </span>
              <span
                className="tooltip tooltip-bottom tooltip-left tooltip-hover-only"
                data-tooltip="Inspect"
              >
                <button
                  className={`sidebar-tab${sidebarTab === 'inspect' ? ' active' : ''}`}
                  type="button"
                  onClick={() => handleSidebarTabClick('inspect')}
                  role="tab"
                  aria-selected={sidebarTab === 'inspect'}
                  aria-controls="sidebar-panel"
                  aria-label="Inspect panel"
                >
                  <span className="codicon codicon-inspect" aria-hidden="true" />
                </button>
              </span>
            </div>
          </div>
          <div
            className="sidebar-body"
            role="tabpanel"
            id="sidebar-panel"
            aria-live="polite"
          >
            {sidebarTab === 'chats' ? (
              <div className="chat-list" role="listbox" aria-label="Chats">
                {groupedCollections.map((group) => (
                  <div key={group.key} className="chat-group">
                    <div className="section-title">{group.label}</div>
                    <div className="chat-group-list" role="group">
                      {group.collections.map((collection) => (
                        <button
                          key={collection.id}
                          type="button"
                          className={`chat-list-item${selectedCollectionId === collection.id ? ' active' : ''}`}
                          onClick={() => handleSelectCollection(collection)}
                          role="option"
                          aria-selected={selectedCollectionId === collection.id}
                        >
                          <div className="chat-list-title">
                            {getCollectionTitle(collection)}
                          </div>
                          <div className="chat-list-meta">
                            <span>{getCollectionTimestamp(collection)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {demoCollections.length ? (
                  <div className="chat-group chat-group-demo">
                    <div className="section-title">Demo</div>
                    <div className="chat-group-list" role="group">
                      {demoCollections.map((collection) => (
                        <button
                          key={collection.id}
                          type="button"
                          className={`chat-list-item${selectedCollectionId === collection.id ? ' active' : ''}`}
                          onClick={() => handleSelectCollection(collection)}
                          role="option"
                          aria-selected={selectedCollectionId === collection.id}
                        >
                          <div className="chat-list-title">
                            {getCollectionTitle(collection)}
                          </div>
                          <div className="chat-list-meta">
                            <span>{getCollectionTimestamp(collection)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : activeMessage && inspectorStats ? (
              <>
                {quickFacts.length > 0 ? (
                  <div className="sidebar-quick-facts">
                    {quickFacts.map((fact) => (
                      <div className="sidebar-quick-fact" key={fact.key}>
                        {fact.content}
                      </div>
                    ))}
                    <div className="sidebar-quick-fact sidebar-quick-fact-action">
                      <span
                        className="tooltip tooltip-hover-only tooltip-left"
                        data-tooltip={
                          copyAckId === activeMessage?.id
                            ? 'Copied'
                            : 'Copy message'
                        }
                      >
                        <button
                          className="sidebar-icon-button"
                          type="button"
                          onClick={handleCopyActiveMessage}
                          aria-label="Copy message"
                        >
                          <span
                            className={`codicon ${
                              copyAckId === activeMessage?.id
                                ? 'codicon-check'
                                : 'codicon-copy'
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </span>
                    </div>
                  </div>
                ) : null}
                <div className="sidebar-section">
                  <div className="sidebar-group">
                    <div className="sidebar-group-header">
                      <div className="section-title">Message</div>
                    </div>
                    <div className="sidebar-group-body">
                      {inspectorMeta?.localTimestamp ? (
                        <div className="sidebar-field">
                          <div className="sidebar-field-label">Time</div>
                          <div className="sidebar-field-value">
                            {inspectorMeta.localTimestamp}
                          </div>
                        </div>
                      ) : null}
                      {inspectorMeta?.role ? (
                        <div className="sidebar-field">
                          <div className="sidebar-field-label">Role</div>
                          <div className="sidebar-field-value">
                            {inspectorMeta.role}
                          </div>
                        </div>
                      ) : null}
                      <div className="sidebar-field">
                        <div className="sidebar-field-label">Words</div>
                        <div className="sidebar-field-value">
                          {inspectorStats.words}
                        </div>
                      </div>
                      <div className="sidebar-field">
                        <div className="sidebar-field-label">Characters</div>
                        <div className="sidebar-field-value">
                          {inspectorStats.characters}
                        </div>
                      </div>
                    </div>
                  </div>
                  {isAssistantMessage ? (
                    <>
                      <div className="sidebar-group">
                        <div className="sidebar-group-header">
                          <div className="section-title">Request</div>
                        </div>
                        <div className="sidebar-group-body">
                          {formatMessageSource(inspectorMeta?.backend) ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">Source</div>
                              <div className="sidebar-field-value">
                                {formatMessageSource(inspectorMeta?.backend)}
                              </div>
                            </div>
                          ) : null}
                          {inspectorMeta?.requestModel ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">Model</div>
                              <div className="sidebar-field-value">
                                {inspectorMeta.requestModel}
                              </div>
                            </div>
                          ) : null}
                          {typeof inspectorMeta?.temperature === 'number' ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">
                                Temperature
                              </div>
                              <div className="sidebar-field-value">
                                {inspectorMeta.temperature.toFixed(1)}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="sidebar-group">
                        <div className="sidebar-group-header">
                          <div className="section-title">Response</div>
                        </div>
                        <div className="sidebar-group-body">
                          {inspectorMeta?.responseModel &&
                          inspectorMeta.responseModel !==
                            inspectorMeta.requestModel ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">Model</div>
                              <div className="sidebar-field-value">
                                {inspectorMeta.responseModel}
                              </div>
                            </div>
                          ) : null}
                          {formatLatency(inspectorMeta?.latencyMs) ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">Latency</div>
                              <div className="sidebar-field-value">
                                {formatLatency(inspectorMeta?.latencyMs)}
                              </div>
                            </div>
                          ) : null}
                          {promptTokens ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">
                                Prompt tokens
                              </div>
                              <div className="sidebar-field-value">
                                {promptTokens}
                              </div>
                            </div>
                          ) : null}
                          {completionTokens ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">
                                Completion tokens
                              </div>
                              <div className="sidebar-field-value">
                                {completionTokens}
                              </div>
                            </div>
                          ) : null}
                          {totalTokens ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">
                                Total tokens
                              </div>
                              <div className="sidebar-field-value">
                                {totalTokens}
                              </div>
                            </div>
                          ) : null}
                          {inspectorMeta?.finishReason ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">
                                Finish reason
                              </div>
                              <div className="sidebar-field-value">
                                {inspectorMeta.finishReason}
                              </div>
                            </div>
                          ) : null}
                          {inspectorMeta?.responseId ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">
                                Response ID
                              </div>
                              <div className="sidebar-field-value">
                                {inspectorMeta.responseId}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              </>
            ) : collectionTimestamp ? (
              <div className="sidebar-section">
                <div className="sidebar-quick-facts">
                  <div className="sidebar-quick-fact">
                    {formatQuickTimestamp(collectionTimestamp) ??
                      collectionTimestamp}
                  </div>
                  <div className="sidebar-quick-fact">
                    {collectionMessageCountLabel}
                  </div>
                </div>
              </div>
            ) : (
              <div className="sidebar-empty">
                Select a message to inspect.
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

export default App

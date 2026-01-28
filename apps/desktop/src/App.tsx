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
  useEffect,
  useLayoutEffect,
  useCallback,
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

const REQUEST_TIMEOUT_MS = 60_000
const SCROLL_THRESHOLD_PX = 120

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

function App() {
  const appRef = useRef<HTMLDivElement | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [storageMode, setStorageMode] = useState<StorageMode>('session')
  const [keyError, setKeyError] = useState<string | null>(null)
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
  const endRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const suppressMessageActivationRef = useRef(false)
  const abortControllerRef = useRef<ReturnType<typeof createTimeoutController> | null>(null)
  const autoScrollRef = useRef(false)
  const lastRunTimerRef = useRef<number | null>(null)
  const maxRows = 9
  const hasNewline = draft.includes('\n')
  const trimmedDraft = draft.trim()
  const modifierLabel =
    typeof navigator !== 'undefined' &&
    navigator.platform.toUpperCase().includes('MAC')
      ? 'Cmd'
      : 'Ctrl'
  const activeMessage =
    messages.find((message) => message.id === activeMessageId) ?? null
  const activePayload = activeMessage?.payload
  const activeWordMatches = activeMessage
    ? activeMessage.content.match(/\S+/g)
    : null
  const groupedCollections = groupCollectionsByDay(collections)
  const inspectorStats = activeMessage
    ? {
        characters: activeMessage.content.length,
        words: activeWordMatches ? activeWordMatches.length : 0,
      }
    : null
  const inspectorMeta = activePayload
    ? {
        role: activePayload.role,
        requestModel: activePayload.request?.model,
        responseModel: activePayload.response?.model,
        responseId: activePayload.response?.id,
        finishReason: activePayload.response?.finishReason,
        localTimestamp: activePayload.localTimestamp,
        latencyMs: activePayload.response?.latencyMs,
        usage: activePayload.response?.usage,
        backend: activePayload.request?.backend,
      }
    : null
  const isAssistantMessage = inspectorMeta?.role === 'assistant'
  const completionTokensValue = inspectorMeta?.usage?.completionTokens
  const latencySeconds = formatLatencySeconds(inspectorMeta?.latencyMs)
  const quickFacts: Array<{
    key: string
    content: React.ReactNode
  }> = []

  const quickTime = formatQuickTimestamp(inspectorMeta?.localTimestamp)
  if (quickTime) {
    quickFacts.push({ key: 'time', content: quickTime })
  }

  if (isAssistantMessage) {
    const quickModel =
      inspectorMeta?.requestModel ?? inspectorMeta?.responseModel ?? null
    if (quickModel) {
      quickFacts.push({ key: 'model', content: quickModel })
    }

    if (typeof completionTokensValue === 'number' || latencySeconds) {
      quickFacts.push({
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
  const promptTokens = formatTokenCount(inspectorMeta?.usage?.promptTokens)
  const completionTokens = formatTokenCount(
    inspectorMeta?.usage?.completionTokens,
  )
  const totalTokens = formatTokenCount(inspectorMeta?.usage?.totalTokens)
  const contextTokens = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const usage = messages[index]?.payload?.response?.usage
      if (usage?.totalTokens) {
        return usage.totalTokens
      }
    }
    return null
  })()
  const lastRunLatency = formatLatencySeconds(lastRunStats?.latencyMs)
  const collectionTimestamp =
    activeCollection?.payload.localTimestamp ?? pendingCollection?.localTimestamp
  const collectionDateLabel = formatLocalTimestampHeading(collectionTimestamp)
  const collectionMessageCountLabel = formatMessageCount(messages.length)
  const minimapBlocks = messages.map((message) => ({
    id: message.id,
    isActive: message.id === activeMessageId,
    direction: message.direction,
  }))

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
      setIsSettingsOpen(true)
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
      updateSidebarOpen((prev) => !prev)
    }

    window.ipcRenderer.on('sidebar:toggle', handleToggleSidebar)

    return () => {
      window.ipcRenderer.off('sidebar:toggle', handleToggleSidebar)
    }
  }, [updateSidebarOpen])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleSidebarTab = (_event: unknown, tab: unknown) => {
      if (tab !== 'chats' && tab !== 'inspect') {
        return
      }
      toggleSidebarTab(tab)
    }

    window.ipcRenderer.on('sidebar:tab', handleSidebarTab)

    return () => {
      window.ipcRenderer.off('sidebar:tab', handleSidebarTab)
    }
  }, [toggleSidebarTab])

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
      } catch {
        // Ignore local persistence failures on cold start.
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setActiveMessageId(null)
          blurComposer()
        }
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
  }, [blurComposer, focusComposer, toggleSidebarTab, updateSidebarOpen])

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
    void navigator.clipboard
      ?.writeText(activeMessage.content)
      .catch(() => {})
  }, [activeMessage])

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
      focusComposer()
    }
    const handleSelectPrevious = () => {
      selectPreviousMessage()
    }
    const handleSelectNext = () => {
      selectNextMessage()
    }

    window.ipcRenderer.on('composer:focus', handleFocusComposer)
    window.ipcRenderer.on('selection:prev', handleSelectPrevious)
    window.ipcRenderer.on('selection:next', handleSelectNext)

    return () => {
      window.ipcRenderer.off('composer:focus', handleFocusComposer)
      window.ipcRenderer.off('selection:prev', handleSelectPrevious)
      window.ipcRenderer.off('selection:next', handleSelectNext)
    }
  }, [focusComposer, selectNextMessage, selectPreviousMessage])

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

  useEffect(() => {
    if (!lastRunStats) {
      return
    }
    if (lastRunTimerRef.current) {
      window.clearTimeout(lastRunTimerRef.current)
    }
    lastRunTimerRef.current = window.setTimeout(() => {
      setLastRunStats(null)
      lastRunTimerRef.current = null
    }, 4000)
    return () => {
      if (lastRunTimerRef.current) {
        window.clearTimeout(lastRunTimerRef.current)
        lastRunTimerRef.current = null
      }
    }
  }, [lastRunStats])

  const isNearBottom = () => {
    const doc = document.documentElement
    const scrollTop = window.scrollY ?? doc.scrollTop
    const scrollHeight = doc.scrollHeight
    const clientHeight = window.innerHeight
    return scrollHeight - (scrollTop + clientHeight) <= SCROLL_THRESHOLD_PX
  }

  const queueScrollToBottom = () => {
    window.requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    })
  }

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }

    textarea.style.height = 'auto'
    const computed = window.getComputedStyle(textarea)
    const lineHeight = Number.parseFloat(computed.lineHeight)
    const maxHeight = lineHeight ? lineHeight * maxRows : 200
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${nextHeight}px`
  }, [draft, maxRows])

  useLayoutEffect(() => {
    const appEl = appRef.current
    const composerEl = composerRef.current
    if (!appEl || !composerEl) {
      return
    }

    const updateComposerHeight = () => {
      appEl.style.setProperty(
        '--composer-height',
        `${composerEl.offsetHeight}px`,
      )
    }

    updateComposerHeight()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      updateComposerHeight()
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

    focusComposer()
  }, [focusComposer])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleNewCollection = () => {
      void startNewCollection()
    }

    window.ipcRenderer.on('collection:new', handleNewCollection)

    return () => {
      window.ipcRenderer.off('collection:new', handleNewCollection)
    }
  }, [startNewCollection])

  const stopRequest = () => {
    abortControllerRef.current?.abort()
  }

  const isAbortError = (error: unknown) =>
    error instanceof Error && error.name === 'AbortError'

  const sendMessage = async () => {
    if (!trimmedDraft || isSending) {
      return
    }

    const parentMessageId = getLatestPersistedMessageId(messages)
    const derivedTitle = deriveCollectionTitle(trimmedDraft)
    const endpoint = buildChatCompletionEndpoint(baseUrl)
    const request = buildMessageRequest(baseUrl, model)
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
      content: 'Thinking...',
      status: 'pending',
    }

    setMessages((prev) => [...prev, userMessage, assistantMessage])
    setDraft('')
    const shouldAutoScroll = isNearBottom()
    autoScrollRef.current = shouldAutoScroll

    if (shouldAutoScroll) {
      queueScrollToBottom()
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

      const shouldAutoScroll = autoScrollRef.current && isNearBottom()
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
        queueScrollToBottom()
      }
    } catch (error) {
      if (isAbortError(error)) {
        const shouldAutoScroll = autoScrollRef.current && isNearBottom()
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantMessage.id
              ? { ...item, content: 'Request stopped.', status: 'canceled' }
              : item,
          ),
        )
        if (shouldAutoScroll) {
          queueScrollToBottom()
        }
        return
      }
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred.'
      const shouldAutoScroll = autoScrollRef.current && isNearBottom()
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantMessage.id
            ? { ...item, content: `Error: ${message}`, status: 'error' }
            : item,
        ),
      )
      if (shouldAutoScroll) {
        queueScrollToBottom()
      }
    } finally {
      setIsSending(false)
      timeoutController.clear()
      abortControllerRef.current = null
      autoScrollRef.current = false
    }
  }

  const handleChatClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null
    if (!target) {
      return
    }
    if (target.closest('.message')) {
      return
    }
    setActiveMessageId(null)
  }

  const hasTextSelection = () => {
    const selection = window.getSelection()
    return Boolean(selection && selection.toString().length > 0)
  }

  const handleSidebarTabClick = (tab: 'chats' | 'inspect') => {
    setSidebarTab(tab)
    updateSidebarOpen(true)
  }

  const handleSelectCollection = (collection: CollectionRecord) => {
    setSelectedCollectionId(collection.id)
    setCollectionId(collection.id)
    setActiveCollection(collection)
    setPendingCollection(null)
    setActiveMessageId(null)

    if (collection.id === demoCollection.id) {
      setMessages(demoCollectionMessages.map(recordToMessage))
      return
    }

    setMessages([])
    void setActiveCollectionId(collection.id)
    void listCollectionMessages(collection.id)
      .then((records) => {
        setMessages(records.map(recordToMessage))
      })
      .catch(() => {
        setMessages([])
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
          <div className="main-column">
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
            <main className="chat" onClick={handleChatClick}>
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <div className="chat-empty-title">No context yet</div>
                  <div className="chat-empty-body">
                    Add a message to start building context
                  </div>
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    ref={(node) => {
                      if (node) {
                        messageRefs.current.set(message.id, node)
                      } else {
                        messageRefs.current.delete(message.id)
                      }
                    }}
                    className={`message ${message.direction}${
                      message.status ? ` ${message.status}` : ''
                    }${message.id === activeMessageId ? ' selected' : ''}`}
                    onMouseDown={() => {
                      if (hasTextSelection()) {
                        suppressMessageActivationRef.current = true
                      }
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (
                        suppressMessageActivationRef.current ||
                        hasTextSelection()
                      ) {
                        suppressMessageActivationRef.current = false
                        return
                      }
                      suppressMessageActivationRef.current = false
                      setActiveMessageId((prev) =>
                        prev === message.id ? null : message.id,
                      )
                    }}
                  >
                    {message.direction === 'input' ? (
                      <blockquote className="input-quote">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </ReactMarkdown>
                      </blockquote>
                    ) : (
                      <div className="output-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={endRef} />
            </main>
          </div>
          <div className="context-rail" aria-label="Context controls">
            <div className="context-rail-meta">
              <span className="context-rail-title">Context</span>
              <span className="context-rail-value">
                {contextTokens ? `${contextTokens.toLocaleString()} tokens` : '—'}
              </span>
              {lastRunStats && (lastRunLatency || lastRunStats.completionTokens) ? (
                <span className="context-rail-run">
                  {typeof lastRunStats.completionTokens === 'number'
                    ? `+${lastRunStats.completionTokens.toLocaleString()} tokens`
                    : null}
                  {typeof lastRunStats.completionTokens === 'number' &&
                  lastRunLatency
                    ? ' · '
                    : null}
                  {lastRunLatency ?? null}
                </span>
              ) : null}
            </div>
            <div className="context-rail-minimap" aria-label="Conversation map">
              {minimapBlocks.map((block) => (
                <button
                  key={block.id}
                  type="button"
                  className={`context-rail-block${block.isActive ? ' active' : ''}${block.direction === 'input' ? ' input' : ''}`}
                  onClick={() => scrollToMessage(block.id)}
                  aria-label="Jump to message"
                />
              ))}
            </div>
            <div className="context-rail-controls" aria-hidden="true" />
          </div>
          <footer className="composer" ref={composerRef}>
            <div className="composer-box">
              <textarea
                ref={textareaRef}
                className="composer-input"
                placeholder="Add a message to the context"
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
                <span className="hint">
                  {hasNewline
                    ? `${modifierLabel} + Enter to generate`
                    : 'Enter to generate · Shift + Enter for newline'}
                </span>
                <span
                  className={`tooltip tooltip-hover-only${trimmedDraft && !isSending ? ' tooltip-suppressed' : ''}`}
                  data-tooltip={isSending ? 'Stop request' : 'Add to context'}
                >
                  <button
                    className="send-button"
                    type="button"
                    onClick={isSending ? stopRequest : () => void sendMessage()}
                    disabled={!isSending && !trimmedDraft}
                    aria-label={isSending ? 'Stop request' : 'Add to context'}
                  >
                    <span
                      className={`codicon ${isSending ? 'codicon-debug-stop' : 'codicon-add'}`}
                      aria-hidden="true"
                    />
                  </button>
                </span>
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
                  </div>
                ) : null}
                <div className="sidebar-section">
                  <div className="sidebar-group">
                    <div className="section-title">Message</div>
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
                  {isAssistantMessage ? (
                    <>
                      <div className="sidebar-group">
                        <div className="section-title">Request</div>
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
                      </div>
                      <div className="sidebar-group">
                        <div className="section-title">Response</div>
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
                            <div className="sidebar-field-label">Total tokens</div>
                            <div className="sidebar-field-value">
                              {totalTokens}
                            </div>
                          </div>
                        ) : null}
                        {inspectorMeta?.finishReason &&
                        inspectorMeta.finishReason !== 'stop' ? (
                          <div className="sidebar-field">
                            <div className="sidebar-field-label">Finish</div>
                            <div className="sidebar-field-value">
                              {inspectorMeta.finishReason}
                            </div>
                          </div>
                        ) : null}
                        {inspectorMeta?.responseId ? (
                          <div className="sidebar-field">
                            <div className="sidebar-field-label">Response ID</div>
                            <div className="sidebar-field-value">
                              {inspectorMeta.responseId}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </div>
                <div className="sidebar-actions">
                  <button
                    className="sidebar-action"
                    type="button"
                    onClick={handleCopyActiveMessage}
                  >
                    <span className="codicon codicon-copy" aria-hidden="true" />
                    Copy
                  </button>
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

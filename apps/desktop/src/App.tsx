import {
  buildChatCompletionEndpoint,
  createChatCompletion,
  createTimeoutController,
  demoChat,
  type DemoChat,
  type ChatCompletionMessage,
  type MessagePayload,
  type MessageRecord,
  type MessageUsage,
  buildMessageRequest,
  buildMessageResponse,
  toMessagePayload,
  formatMessageSource,
  formatLatency,
  formatUsage,
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
  deleteKvValue,
  getOrCreateActiveCollection,
  getKvValue,
  listCollectionMessages,
  setKvValue,
} from './services/db'
import './App.css'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  payload?: MessagePayload
  status?: 'pending' | 'error' | 'canceled'
  omitFromContext?: boolean
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

const REQUEST_TIMEOUT_MS = 60_000
const SCROLL_THRESHOLD_PX = 120

const seedMessages: Message[] = [
  {
    id: 'm1',
    role: 'assistant',
    content:
      'This is a minimal chat scaffold. Add your base URL and API key to send completions.',
    omitFromContext: true,
  },
]

const demoChats = [demoChat]

const DAY_MS = 24 * 60 * 60 * 1000

const formatChatGroupLabel = (date: Date, todayStart: Date) => {
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

const groupChatsByDay = (chats: DemoChat[]) => {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const groups = new Map<
    string,
    { key: string; label: string; time: number; chats: DemoChat[] }
  >()

  chats.forEach((chat) => {
    const parsed = new Date(chat.createdAt)
    if (Number.isNaN(parsed.getTime())) {
      const key = 'undated'
      const existing = groups.get(key)
      if (existing) {
        existing.chats.push(chat)
        return
      }
      groups.set(key, { key, label: 'Undated', time: 0, chats: [chat] })
      return
    }

    const dayStart = new Date(
      parsed.getFullYear(),
      parsed.getMonth(),
      parsed.getDate(),
    )
    const key = dayStart.toISOString()
    const existing = groups.get(key)
    if (existing) {
      existing.chats.push(chat)
      return
    }
    groups.set(key, {
      key,
      label: formatChatGroupLabel(dayStart, todayStart),
      time: dayStart.getTime(),
      chats: [chat],
    })
  })

  return Array.from(groups.values())
    .sort((a, b) => b.time - a.time)
    .map((group) => ({
      ...group,
      chats: group.chats.slice().sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime()
        const bTime = new Date(b.createdAt).getTime()
        return bTime - aTime
      }),
    }))
}

const recordToMessage = (record: MessageRecord): Message => {
  const role = record.payload?.role === 'user' ? 'user' : 'assistant'
  return {
    id: record.id,
    role,
    content: record.payload?.content ?? '',
    payload: record.payload,
  }
}


const toChatMessages = (items: Message[]): ChatCompletionMessage[] =>
  items
    .filter((message) => !message.omitFromContext && !message.status)
    .map(({ role, content }) => ({ role, content }))

const toDemoMessages = (chat: DemoChat): Message[] =>
  chat.messages
    .filter(
      (message): message is ChatCompletionMessage & {
        role: 'user' | 'assistant'
      } => message.role === 'user' || message.role === 'assistant',
    )
    .map((message, index) => ({
      id: `${chat.id}-${message.role}-${index}`,
      role: message.role,
      content: message.content,
    }))

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
  const [messages, setMessages] = useState<Message[]>(seedMessages)
  const [draft, setDraft] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [storageMode, setStorageMode] = useState<StorageMode>('session')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [suppressKeyTooltip, setSuppressKeyTooltip] = useState(false)
  const [suppressSettingsTooltip, setSuppressSettingsTooltip] = useState(false)
  const [suppressSidebarTooltip, setSuppressSidebarTooltip] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [sidebarTab, setSidebarTab] = useState<'chats' | 'inspect'>(
    'chats',
  )
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const suppressMessageActivationRef = useRef(false)
  const abortControllerRef = useRef<ReturnType<typeof createTimeoutController> | null>(null)
  const autoScrollRef = useRef(false)
  const maxRows = 9
  const hasNewline = draft.includes('\n')
  const modifierLabel =
    typeof navigator !== 'undefined' &&
    navigator.platform.toUpperCase().includes('MAC')
      ? 'Cmd'
      : 'Ctrl'
  const activeMessage =
    messages.find((message) => message.id === activeMessageId) ?? null
  const activePayload = activeMessage?.payload
  const groupedChats = groupChatsByDay([])
  const inspectorStats = activeMessage
    ? {
        role: activeMessage.role,
        characters: activeMessage.content.length,
        words: activeMessage.content.trim()
          ? activeMessage.content.trim().split(/\s+/).length
          : 0,
      }
    : null
  const inspectorMeta = activePayload
    ? {
        requestModel: activePayload.request?.model,
        responseModel: activePayload.response?.model,
        localTimestamp: activePayload.localTimestamp,
        latencyMs: activePayload.response?.latencyMs,
        usage: activePayload.response?.usage,
        backend: activePayload.request?.backend,
      }
    : null



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
        const nextModel = typeof storedModel === 'string' ? storedModel : ''
        setBaseUrl(nextBaseUrl)
        setModel(nextModel)
        setIsSettingsOpen(!nextBaseUrl.trim())
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
    void setKvValue(KV_KEYS.baseUrl, baseUrl)
  }, [baseUrl, settingsLoaded])

  useEffect(() => {
    if (!settingsLoaded) {
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

    const loadMessages = async () => {
      try {
        const collection = await getOrCreateActiveCollection()
        const storedMessages = await listCollectionMessages(collection.id)
        if (!isMounted) {
          return
        }
        setCollectionId(collection.id)
        if (storedMessages.length > 0) {
          setMessages(storedMessages.map(recordToMessage))
          setActiveChatId(null)
        }
      } catch {
      }
    }

    void loadMessages()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!activeMessageId) {
      return
    }

    const node = messageRefs.current.get(activeMessageId)
    if (!node) {
      return
    }
    node.scrollIntoView({ block: 'nearest' })
  }, [activeMessageId])

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

  const handleCopyActiveMessage = async () => {
    if (!activeMessage) {
      return
    }

    try {
      await navigator.clipboard?.writeText(activeMessage.content)
    } catch {
    }
  }

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

  const stopRequest = () => {
    abortControllerRef.current?.abort()
  }

  const isAbortError = (error: unknown) =>
    error instanceof Error && error.name === 'AbortError'

  const sendMessage = async () => {
    const trimmed = draft.trim()
    if (!trimmed || isSending) {
      return
    }

    const endpoint = buildChatCompletionEndpoint(baseUrl)
    const request = buildMessageRequest(baseUrl, model)
    const timestamp = Date.now()
    const userPayload = toMessagePayload('user', trimmed, {
      request,
    })
    const userMessage: Message = {
      id: `m-${timestamp}-user`,
      role: 'user',
      content: trimmed,
      payload: userPayload,
    }

    const assistantMessage: Message = {
      id: `m-${timestamp}-assistant`,
      role: 'assistant',
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

    if (!activeChatId && collectionId) {
      void appendMessage(
        collectionId,
        userPayload,
      )
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

    const contextMessages = toChatMessages([...messages, userMessage])
    const token = apiKey.trim()
    const timeoutController = createTimeoutController(REQUEST_TIMEOUT_MS)
    abortControllerRef.current = timeoutController
    setIsSending(true)
    const requestStart = Date.now()

    try {
      const { content: nextContent, raw } = await createChatCompletion({
        baseUrl,
        apiKey: token || undefined,
        messages: contextMessages,
        model: model.trim() ? model.trim() : undefined,
        fetchFn: (input, init) => window.fetch(input, init),
        signal: timeoutController.signal,
      })
      const latencyMs = Date.now() - requestStart
      const response = buildMessageResponse(raw, latencyMs)
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
      if (!activeChatId && collectionId) {
        void appendMessage(
          collectionId,
          assistantPayload,
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
    if (event.target === event.currentTarget) {
      setActiveMessageId(null)
    }
  }

  const hasTextSelection = () => {
    const selection = window.getSelection()
    return Boolean(selection && selection.toString().length > 0)
  }

  const handleSidebarTabClick = (tab: 'chats' | 'inspect') => {
    setSidebarTab(tab)
    updateSidebarOpen(true)
  }

  const handleSelectChat = (chat: DemoChat) => {
    setActiveChatId(chat.id)
    setMessages(toDemoMessages(chat))
    setActiveMessageId(null)
  }

  return (
    <div className={`app${isSettingsOpen ? ' settings-open' : ''}`} ref={appRef}>
      <div className={`layout${isSidebarOpen ? ' sidebar-open' : ''}`}>
        <div className="main-stack">
          <div className="main-column">
            <header className="header">
              <div className="header-left">
                <div className="header-meta">
                  <div className="header-subtitle">
                    {isSettingsOpen ? 'Settings' : 'Sat Jan 24th, 2027'}
                  </div>
                </div>
                <div className="header-actions">
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
                      <span
                        className="codicon codicon-gear"
                        aria-hidden="true"
                      />
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
                        onChange={(event) => setBaseUrl(event.target.value)}
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
                        onChange={(event) => setModel(event.target.value)}
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
                          onChange={(event) => setApiKey(event.target.value)}
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
              {messages.map((message) => (
              <div
                key={message.id}
                ref={(node) => {
                  if (node) {
                    messageRefs.current.set(message.id, node)
                  } else {
                    messageRefs.current.delete(message.id)
                  }
                }}
                className={`message ${message.role}${
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
                  {message.role === 'user' ? (
                    <blockquote className="user-quote">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.content}
                      </ReactMarkdown>
                    </blockquote>
                  ) : (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      className="assistant-markdown"
                    >
                      {message.content}
                    </ReactMarkdown>
                  )}
                </div>
              ))}
              <div ref={endRef} />
            </main>

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
                    className={`tooltip tooltip-hover-only${draft.trim() && !isSending ? ' tooltip-suppressed' : ''}`}
                    data-tooltip={isSending ? 'Stop request' : 'Add to context'}
                  >
                    <button
                      className="send-button"
                      type="button"
                      onClick={
                        isSending ? stopRequest : () => void sendMessage()
                      }
                      disabled={!isSending && !draft.trim()}
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
                {groupedChats.map((group) => (
                  <div key={group.key} className="chat-group">
                    <div className="chat-group-title">{group.label}</div>
                    <div className="chat-group-list" role="group">
                      {group.chats.map((chat) => (
                        <button
                          key={chat.id}
                          type="button"
                          className={`chat-list-item${activeChatId === chat.id ? ' active' : ''}`}
                          onClick={() => handleSelectChat(chat)}
                          role="option"
                          aria-selected={activeChatId === chat.id}
                        >
                          <div className="chat-list-title">{chat.title}</div>
                          <div className="chat-list-meta">
                            <span>{chat.createdAt}</span>
                            <span>·</span>
                            <span>{chat.model}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {demoChats.length ? (
                  <div className="chat-group chat-group-demo">
                    <div className="chat-group-title">Demo</div>
                    <div className="chat-group-list" role="group">
                      {demoChats.map((chat) => (
                        <button
                          key={chat.id}
                          type="button"
                          className={`chat-list-item${activeChatId === chat.id ? ' active' : ''}`}
                          onClick={() => handleSelectChat(chat)}
                          role="option"
                          aria-selected={activeChatId === chat.id}
                        >
                          <div className="chat-list-title">{chat.title}</div>
                          <div className="chat-list-meta">
                            <span>{chat.createdAt}</span>
                            <span>·</span>
                            <span>{chat.model}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : activeMessage && inspectorStats ? (
              <div className="sidebar-section">
                <div className="sidebar-row">
                  <span>Characters</span>
                  <span>{inspectorStats.characters}</span>
                </div>
                <div className="sidebar-row">
                  <span>Words</span>
                  <span>{inspectorStats.words}</span>
                </div>
                {inspectorMeta?.responseModel || inspectorMeta?.requestModel ? (
                  <div className="sidebar-row">
                    <span>Model</span>
                    <span>
                      {inspectorMeta.responseModel ??
                        inspectorMeta.requestModel}
                    </span>
                  </div>
                ) : null}
                {formatMessageSource(inspectorMeta?.backend) ? (
                  <div className="sidebar-row">
                    <span>Source</span>
                    <span>{formatMessageSource(inspectorMeta?.backend)}</span>
                  </div>
                ) : null}
                {formatLatency(inspectorMeta?.latencyMs) ? (
                  <div className="sidebar-row">
                    <span>Latency</span>
                    <span>{formatLatency(inspectorMeta?.latencyMs)}</span>
                  </div>
                ) : null}
                {formatUsage(inspectorMeta?.usage) ? (
                  <div className="sidebar-row">
                    <span>Usage</span>
                    <span>{formatUsage(inspectorMeta?.usage)}</span>
                  </div>
                ) : null}
                {inspectorMeta?.localTimestamp ? (
                  <div className="sidebar-row">
                    <span>Time</span>
                    <span>
                      {inspectorMeta.localTimestamp}
                    </span>
                  </div>
                ) : null}
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

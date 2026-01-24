import {
  buildChatCompletionEndpoint,
  createChatCompletion,
  createTimeoutController,
  type ChatCompletionMessage,
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
import './App.css'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'pending' | 'error' | 'canceled'
  omitFromContext?: boolean
}

type StorageMode = 'secure' | 'session'

const STORAGE_KEYS = {
  baseUrl: 'mir.chat.baseUrl',
  model: 'mir.chat.model',
  apiKeyEncrypted: 'mir.chat.apiKey.encrypted',
  apiKeySession: 'mir.chat.apiKey.session',
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

const toChatMessages = (items: Message[]): ChatCompletionMessage[] =>
  items
    .filter((message) => !message.omitFromContext && !message.status)
    .map(({ role, content }) => ({ role, content }))

const getInitialBaseUrl = () => {
  if (typeof window === 'undefined') {
    return ''
  }

  return localStorage.getItem(STORAGE_KEYS.baseUrl) ?? ''
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
  const [messages, setMessages] = useState<Message[]>(seedMessages)
  const [draft, setDraft] = useState('')
  const initialBaseUrl = getInitialBaseUrl()
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
  const [model, setModel] = useState(
    () => localStorage.getItem(STORAGE_KEYS.model) ?? '',
  )
  const [apiKey, setApiKey] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(
    () => !initialBaseUrl.trim(),
  )
  const [storageMode, setStorageMode] = useState<StorageMode>('session')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [suppressKeyTooltip, setSuppressKeyTooltip] = useState(false)
  const [suppressSettingsTooltip, setSuppressSettingsTooltip] = useState(false)
  const [suppressSidebarTooltip, setSuppressSidebarTooltip] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const [sidebarTab, setSidebarTab] = useState<'chats' | 'inspect'>(
    'chats',
  )
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
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
  const inspectorStats = activeMessage
    ? {
        role: activeMessage.role,
        characters: activeMessage.content.length,
        words: activeMessage.content.trim()
          ? activeMessage.content.trim().split(/\s+/).length
          : 0,
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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.baseUrl, baseUrl)
  }, [baseUrl])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.model, model)
  }, [model])

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
    if (!activeMessageId) {
      return
    }

    setSidebarTab('inspect')
    updateSidebarOpen(true)
  }, [activeMessageId, updateSidebarOpen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'b'
      ) {
        return
      }

      event.preventDefault()
      updateSidebarOpen((prev) => !prev)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [updateSidebarOpen])

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
        const encrypted = localStorage.getItem(STORAGE_KEYS.apiKeyEncrypted)
        if (encrypted) {
          try {
            nextKey = await decryptSecret(encrypted)
          } catch {
            localStorage.removeItem(STORAGE_KEYS.apiKeyEncrypted)
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
            localStorage.removeItem(STORAGE_KEYS.apiKeyEncrypted)
            setKeyError(null)
            return
          }

          try {
            const encrypted = await encryptSecret(apiKey)
            localStorage.setItem(STORAGE_KEYS.apiKeyEncrypted, encrypted)
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
    const timestamp = Date.now()
    const userMessage: Message = {
      id: `m-${timestamp}-user`,
      role: 'user',
      content: trimmed,
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

    try {
      const { content: nextContent } = await createChatCompletion({
        baseUrl,
        apiKey: token || undefined,
        messages: contextMessages,
        model: model.trim() ? model.trim() : undefined,
        fetchFn: (input, init) => window.fetch(input, init),
        signal: timeoutController.signal,
      })

      const shouldAutoScroll = autoScrollRef.current && isNearBottom()
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: nextContent, status: undefined }
            : message,
        ),
      )
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

  const handleCopyActiveMessage = async () => {
    if (!activeMessage) {
      return
    }

    try {
      await navigator.clipboard?.writeText(activeMessage.content)
    } catch {
    }
  }

  const handleChatClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) {
      setActiveMessageId(null)
    }
  }

  const handleSidebarTabClick = (tab: 'chats' | 'inspect') => {
    setSidebarTab(tab)
    updateSidebarOpen(true)
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-meta">
          <div className="header-subtitle">Sat Jan 24th, 2027</div>
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
              <span className="codicon codicon-gear" aria-hidden="true" />
            </button>
          </span>
          <span
            className={`tooltip tooltip-bottom tooltip-hover-only${suppressSidebarTooltip ? ' tooltip-suppressed' : ''}`}
            data-tooltip={isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
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
                    data-tooltip={showKey ? 'Hide API key' : 'Show API key'}
                    onMouseLeave={() => setSuppressKeyTooltip(false)}
                  >
                    <button
                      className="settings-button"
                      type="button"
                      onClick={handleToggleApiKey}
                      aria-label={showKey ? 'Hide API key' : 'Show API key'}
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

      <div className={`main-layout${isSidebarOpen ? ' sidebar-open' : ''}`}>
        <div className="main-column">
          <main className="chat" onClick={handleChatClick}>
            {messages.map((message) => (
              <div
                key={message.id}
                className={`message ${message.role}${
                  message.status ? ` ${message.status}` : ''
                }${message.id === activeMessageId ? ' selected' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
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

          <footer className="composer">
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
                    onClick={isSending ? stopRequest : () => void sendMessage()}
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

        <aside className="sidebar" id="sidebar" aria-hidden={!isSidebarOpen}>
          <div className="sidebar-header">
            <div className="sidebar-title">
              {sidebarTab === 'chats' ? 'Chats' : 'Inspector'}
              {sidebarTab === 'inspect' && activeMessage ? (
                <span className="sidebar-meta">{activeMessage.role}</span>
              ) : null}
            </div>
            <div className="sidebar-tabs" role="tablist" aria-label="Sidebar panels">
              <button
                className={`sidebar-tab${sidebarTab === 'chats' ? ' active' : ''}`}
                type="button"
                onClick={() => handleSidebarTabClick('chats')}
                role="tab"
                aria-selected={sidebarTab === 'chats'}
                aria-controls="sidebar-panel"
                aria-label="Chats panel"
              >
                <span className="codicon codicon-list-unordered" aria-hidden="true" />
              </button>
              <button
                className={`sidebar-tab${sidebarTab === 'inspect' ? ' active' : ''}`}
                type="button"
                onClick={() => handleSidebarTabClick('inspect')}
                role="tab"
                aria-selected={sidebarTab === 'inspect'}
                aria-controls="sidebar-panel"
                aria-label="Inspector panel"
              >
                <span className="codicon codicon-inspect" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div
            className="sidebar-body"
            role="tabpanel"
            id="sidebar-panel"
            aria-live="polite"
          >
            {sidebarTab === 'chats' ? (
              <div className="sidebar-empty">
                Chat history and search will appear here.
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

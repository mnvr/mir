import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'pending' | 'error'
  omitFromContext?: boolean
}

type ChatCompletionMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string
    }
    text?: string
  }>
}

type StorageMode = 'secure' | 'session'

const STORAGE_KEYS = {
  baseUrl: 'mir.chat.baseUrl',
  apiKeyEncrypted: 'mir.chat.apiKey.encrypted',
  apiKeySession: 'mir.chat.apiKey.session',
}

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

const extractAssistantText = (data: ChatCompletionResponse): string | null => {
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

const buildChatEndpoint = (baseUrl: string) => {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    return null
  }

  const normalized = trimmed.replace(/\/+$/, '')
  return `${normalized}/chat/completions`
}

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
  const [apiKey, setApiKey] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(
    () => !initialBaseUrl.trim(),
  )
  const [storageMode, setStorageMode] = useState<StorageMode>('session')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [suppressKeyTooltip, setSuppressKeyTooltip] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const keyTooltipTimeoutRef = useRef<number | null>(null)
  const maxRows = 9

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.baseUrl, baseUrl)
  }, [baseUrl])

  useEffect(() => {
    return () => {
      if (keyTooltipTimeoutRef.current !== null) {
        window.clearTimeout(keyTooltipTimeoutRef.current)
      }
    }
  }, [])

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

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
    if (keyTooltipTimeoutRef.current !== null) {
      window.clearTimeout(keyTooltipTimeoutRef.current)
    }
    keyTooltipTimeoutRef.current = window.setTimeout(() => {
      setSuppressKeyTooltip(false)
    }, 400)
  }

  const sendMessage = async () => {
    const trimmed = draft.trim()
    if (!trimmed || isSending) {
      return
    }

    const endpoint = buildChatEndpoint(baseUrl)
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
    const payload: { messages: ChatCompletionMessage[] } = {
      messages: contextMessages,
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const token = apiKey.trim()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    setIsSending(true)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
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
      const nextContent = extractAssistantText(data)

      if (!nextContent) {
        throw new Error('No assistant content returned.')
      }

      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: nextContent, status: undefined }
            : message,
        ),
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred.'
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantMessage.id
            ? { ...item, content: `Error: ${message}`, status: 'error' }
            : item,
        ),
      )
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-meta">
          <div className="header-subtitle">Sat Jan 24th, 2027</div>
        </div>
        <span className="tooltip tooltip-bottom" data-tooltip="Settings">
          <button
            className="settings-toggle"
            type="button"
            onClick={() => setIsSettingsOpen((prev) => !prev)}
            aria-label="Toggle settings"
            aria-expanded={isSettingsOpen}
            aria-controls="settings-panel"
          >
            <span className="codicon codicon-gear" aria-hidden="true" />
          </button>
        </span>
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
                    className={`tooltip tooltip-inline${suppressKeyTooltip ? ' tooltip-suppressed' : ''}`}
                    data-tooltip={showKey ? 'Hide API key' : 'Show API key'}
                  >
                    <button
                      className="settings-button"
                      type="button"
                      onClick={handleToggleApiKey}
                      aria-label={showKey ? 'Hide API key' : 'Show API key'}
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
                ? 'API keys are encrypted and stored in secure storage.'
                : 'Secure storage is unavailable. API keys are kept only for this session.'}
            </div>
            {keyError ? (
              <div className="settings-error">{keyError}</div>
            ) : null}
          </div>
        </section>
      ) : null}

      <main className="chat">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message ${message.role}${
              message.status ? ` ${message.status}` : ''
            }`}
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
              if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey) &&
                !isSending
              ) {
                event.preventDefault()
                void sendMessage()
              }
            }}
            rows={1}
          />
          <div className="composer-actions">
            <span className="hint">Cmd + Enter</span>
            <span className="tooltip" data-tooltip="Add to context">
              <button
                className="send-button"
                type="button"
                onClick={() => void sendMessage()}
                disabled={!draft.trim() || isSending}
                aria-label="Add to context"
              >
                <span className="codicon codicon-add" aria-hidden="true" />
              </button>
            </span>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App

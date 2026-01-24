import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const seedMessages: Message[] = [
  {
    id: 'm1',
    role: 'assistant',
    content:
      'This is a minimal chat scaffold. Add a message below to generate the next completion.',
  },
]

function App() {
  const [messages, setMessages] = useState<Message[]>(seedMessages)
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const maxRows = 9

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

  const sendMessage = () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }

    const userMessage: Message = {
      id: `m-${Date.now()}-user`,
      role: 'user',
      content: trimmed,
    }

    const assistantMessage: Message = {
      id: `m-${Date.now()}-assistant`,
      role: 'assistant',
      content:
        'This is a placeholder completion. Wire up the LLM endpoint to replace it.',
    }

    setMessages((prev) => [...prev, userMessage, assistantMessage])
    setDraft('')
  }

  return (
    <div className="app">
      <header className="header">Sat Jan 24th, 2027</header>

      <main className="chat">
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
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
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                sendMessage()
              }
            }}
            rows={1}
          />
          <div className="composer-actions">
            <span className="hint">Cmd + Enter</span>
            <span className="send-tooltip" data-tooltip="Add to context">
              <button
                className="send-button"
                type="button"
                onClick={sendMessage}
                disabled={!draft.trim()}
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

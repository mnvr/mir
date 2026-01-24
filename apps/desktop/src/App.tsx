import { useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

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
      <header className="header">Mir</header>

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
        <textarea
          className="composer-input"
          placeholder="Add a message to the context..."
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              sendMessage()
            }
          }}
          rows={3}
        />
        <div className="composer-actions">
          <button
            className="send-button"
            onClick={sendMessage}
            disabled={!draft.trim()}
          >
            Send
          </button>
          <span className="hint">Cmd + Enter</span>
        </div>
      </footer>
    </div>
  )
}

export default App

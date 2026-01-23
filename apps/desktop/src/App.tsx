import { useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Block, Branch } from 'mir-core'
import { forkBranchWithEdit } from 'mir-core'
import './App.css'

type EditingState = {
  blockId: string
  draft: string
}

const seedBlocks: Block[] = [
  {
    id: 'b1',
    markdown:
      '# Mir\nA markdown-first interface where each edit creates a new branch.',
  },
  {
    id: 'b2',
    markdown:
      'Click any block to edit it. Saving your edit forks the document from that block onward.',
  },
  {
    id: 'b3',
    markdown:
      '- Blocks are rendered markdown\n- Edits are local, fast, and reversible\n- Branches let you explore alternatives',
  },
]

const initialBranch: Branch = {
  id: 'main',
  label: 'main',
  createdAt: Date.now(),
  blocks: seedBlocks,
}

function App() {
  const [branches, setBranches] = useState<Branch[]>([initialBranch])
  const [activeBranchId, setActiveBranchId] = useState(initialBranch.id)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const branchCounter = useRef(1)

  const branchIndex = useMemo(
    () => new Map(branches.map((branch) => [branch.id, branch])),
    [branches],
  )

  const activeBranch = useMemo(
    () => branches.find((branch) => branch.id === activeBranchId) ?? branches[0],
    [branches, activeBranchId],
  )

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, Branch[]>()
    for (const branch of branches) {
      const parentId = branch.parentId ?? null
      const list = map.get(parentId) ?? []
      list.push(branch)
      map.set(parentId, list)
    }

    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.createdAt === b.createdAt) {
          return a.id.localeCompare(b.id)
        }
        return a.createdAt - b.createdAt
      })
    }

    return map
  }, [branches])

  const renderBranchTree = (parentId: string | null, depth = 0) => {
    const children = childrenByParent.get(parentId) ?? []
    if (children.length === 0) {
      return null
    }

    return (
      <ul className={`branch-tree${depth === 0 ? ' root' : ''}`}>
        {children.map((branch) => {
          const isActive = branch.id === activeBranch?.id
          const parent = branch.parentId
            ? branchIndex.get(branch.parentId)
            : null

          return (
            <li key={branch.id} className="branch-node">
              <button
                className={`branch-node-button${isActive ? ' active' : ''}`}
                onClick={() => selectBranch(branch.id)}
              >
                <span className="branch-node-dot" />
                <span className="branch-node-content">
                  <span className="branch-node-label">{branch.label}</span>
                  <span className="branch-node-meta">
                    {parent ? `forked from ${parent.label}` : 'origin'}
                  </span>
                </span>
              </button>
              {renderBranchTree(branch.id, depth + 1)}
            </li>
          )
        })}
      </ul>
    )
  }

  const startEdit = (block: Block) => {
    setEditing({ blockId: block.id, draft: block.markdown })
  }

  const cancelEdit = () => {
    setEditing(null)
  }

  const saveEdit = () => {
    if (!editing || !activeBranch) {
      return
    }

    const nextIndex = branchCounter.current++
    const nextBranch = forkBranchWithEdit(
      activeBranch,
      editing.blockId,
      editing.draft,
      {
        id: `branch-${nextIndex}`,
        label: `branch ${nextIndex}`,
        createdAt: Date.now(),
      },
    )

    setBranches((prev) => [...prev, nextBranch])
    setActiveBranchId(nextBranch.id)
    setEditing(null)
  }

  const selectBranch = (branchId: string) => {
    setActiveBranchId(branchId)
    setEditing(null)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Mir</span>
          <span className="brand-subtitle">Branching editor prototype</span>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-title">Branches</div>
          <div className="branch-list">
            {branches.map((branch) => {
              const isActive = branch.id === activeBranch?.id
              const parent = branch.parentId
                ? branchIndex.get(branch.parentId)
                : null
              return (
                <button
                  key={branch.id}
                  className={`branch-card${isActive ? ' active' : ''}`}
                  onClick={() => selectBranch(branch.id)}
                >
                  <div className="branch-name">{branch.label}</div>
                  <div className="branch-meta">
                    {parent ? `forked from ${parent.label}` : 'root branch'}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-title">Branch tree</div>
          {renderBranchTree(null)}
        </div>

        <div className="sidebar-section hint">
          Click any block to edit it. Saving creates a new branch from that
          point onward.
        </div>
      </aside>

      <main className="document">
        <header className="document-header">
          <div>
            <div className="doc-title">Conversation Draft</div>
            <div className="doc-subtitle">
              Active branch: {activeBranch?.label ?? 'main'}
            </div>
          </div>
          <div className="doc-status">
            {editing ? 'Editing' : 'Read-only'}
          </div>
        </header>

        <section className="blocks">
          {activeBranch?.blocks.map((block, index) => {
            const isEditing = editing?.blockId === block.id
            return (
              <article
                key={block.id}
                className={`block${isEditing ? ' editing' : ''}`}
                onClick={isEditing ? undefined : () => startEdit(block)}
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <div className="block-meta">
                  Block {index + 1} - {block.id}
                </div>

                {isEditing ? (
                  <>
                    <textarea
                      className="block-editor"
                      value={editing?.draft ?? ''}
                      onChange={(event) =>
                        setEditing((prev) =>
                          prev
                            ? { ...prev, draft: event.target.value }
                            : prev,
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && event.metaKey) {
                          event.preventDefault()
                          saveEdit()
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          saveEdit()
                        }
                      }}
                      autoFocus
                    />
                    <div className="block-actions">
                      <button
                        className="action-button primary"
                        onClick={(event) => {
                          event.stopPropagation()
                          saveEdit()
                        }}
                      >
                        Save + Fork
                      </button>
                      <button
                        className="action-button ghost"
                        onClick={(event) => {
                          event.stopPropagation()
                          cancelEdit()
                        }}
                      >
                        Cancel
                      </button>
                      <div className="action-hint">
                        Cmd + Enter or Esc to save
                      </div>
                    </div>
                  </>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    className="markdown"
                  >
                    {block.markdown}
                  </ReactMarkdown>
                )}
              </article>
            )
          })}
        </section>
      </main>
    </div>
  )
}

export default App

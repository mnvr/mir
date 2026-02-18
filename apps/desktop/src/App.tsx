import {
  buildChatCompletionEndpoint,
  createChatCompletion,
  createTimeoutController,
  createId,
  demoCollection,
  demoCollectionBlocks,
  formatLocalTimestamp,
  formatLocalTimestampHeading,
  groupCollectionsByDay,
  parseLocalTimestampDate,
  buildBlockRequest,
  buildBlockResponse,
  toBlockPayload,
  formatLatency,
  toChatMessages,
  type CollectionPayload,
  type CollectionRecord,
  type BlockPayload,
  type BlockRecord,
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
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import {
  appendBlock,
  createCollection,
  deleteKvValue,
  deleteCollection,
  getActiveCollection,
  getKvValue,
  listCollectionBlockGraph,
  listCollections,
  setActiveCollectionId,
  setKvValue,
  updateCollectionTitle,
  type CollectionBlockGraph,
} from './services/db'
import {
  applyImport,
  exportData,
  loadImportPreview,
  revealExportedFile,
  type ImportPreview,
} from './services/export'
import { getFileBasename } from './utils/file'
import './App.css'
import 'katex/dist/katex.min.css'

type BlockDirection = 'input' | 'output'

type Block = {
  id: string
  direction: BlockDirection
  content: string
  payload?: BlockPayload
  status?: 'pending' | 'error' | 'canceled'
  retryParentId?: string | null
  transientParentId?: string | null
}

type BranchOption = {
  id: string
  summary: string | null
}

type PendingScroll = {
  id: string
  mode: 'bottom' | 'read'
}

type CollectionGraph = Pick<
  CollectionBlockGraph,
  'parentIdsByBlockId' | 'childIdsByBlockId'
>

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
const SCROLL_CONTEXT_PEEK_LINES = 3
const SCROLL_CONTEXT_PEEK_FALLBACK_PX = 48
const SCROLL_NEAR_BOTTOM_RATIO = 0.5
const SCROLL_STICK_BOTTOM_PX = 8
const COPY_ACK_DURATION_MS = 1200
const COPY_TOOLTIP_SUPPRESS_MS = 1100

const MARKDOWN_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

const normalizeMathDelimiters = (markdown: string) => {
  let normalized = markdown
  if (normalized.includes('\\[') && normalized.includes('\\]')) {
    normalized = normalized.replace(/\\\[/g, '$$').replace(/\\\]/g, '$$')
  }
  if (normalized.includes('\\(') && normalized.includes('\\)')) {
    normalized = normalized.replace(/\\\(/g, '$').replace(/\\\)/g, '$')
  }
  return normalized
}

const formatExportedAt = (value?: string) => {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString()
}

const demoCollections = [demoCollection]

const blockDirectionForRole = (role?: string): BlockDirection =>
  role === 'user' ? 'input' : 'output'

const isPersistedBlockId = (id: string) => id.startsWith('block_')

const recordToBlock = (record: BlockRecord): Block => ({
  id: record.id,
  direction: blockDirectionForRole(record.payload.role),
  content: record.payload.content,
  payload: record.payload,
})

const getCollectionTitle = (collection: CollectionRecord) =>
  collection.payload.title ?? 'Untitled'

const getCollectionTimestamp = (collection: CollectionRecord) =>
  collection.payload.localTimestamp

const deriveCollectionTitle = (content: string) => {
  const lines = content.split('\n').map((line) => line.trim())
  const firstLine = lines.find((line) => line.length > 0) ?? content.trim()
  return firstLine.slice(0, 120)
}

const formatTokenCount = (count?: number) =>
  typeof count === 'number' ? `${count.toLocaleString()} tokens` : null

const formatBlockCount = (count: number) =>
  `${count} block${count === 1 ? '' : 's'}`

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

const summarizeBlockContent = (content: string, maxLength = 84) => {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength)}...`
}

const summarizeForkPointLabel = (content: string) => {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }
  if (normalized.length <= 42) {
    return normalized
  }
  return `${normalized.slice(0, 42)}...`
}

const summarizeBranchPreview = (content: string) =>
  summarizeBlockContent(content, 128)
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

type BlockRowProps = {
  block: Block
  isActive: boolean
  branchOptions: BranchOption[]
  isForkFocused: boolean
  isContinuationCursor: boolean
  isSending: boolean
  onMouseDown: () => void
  onClick: (id: string) => void
  onSetContinuationCursor: (id: string) => void
  onOpenPathsFork: (id: string) => void
  onRetry: (id: string) => void
  onCopy: (id: string) => void
  registerRef: (id: string, node: HTMLDivElement | null) => void
}

const BlockRow = memo(function BlockRow({
  block,
  isActive,
  branchOptions,
  isForkFocused,
  isContinuationCursor,
  isSending,
  onMouseDown,
  onClick,
  onSetContinuationCursor,
  onOpenPathsFork,
  onRetry,
  onCopy,
  registerRef,
}: BlockRowProps) {
  const branchChildCount = branchOptions.length
  const hasBranches = branchChildCount > 1
  const canSetContinuationCursor =
    block.direction === 'output' &&
    !block.status &&
    isPersistedBlockId(block.id)
  const canGenerateNewFromInput =
    block.direction === 'input' && isPersistedBlockId(block.id)
  const canGenerateNewFromOutput =
    block.direction === 'output' &&
    (block.status === 'error' || block.status === 'canceled')
  const canGenerateNew = canGenerateNewFromInput || canGenerateNewFromOutput
  return (
    <div
      ref={(node) => registerRef(block.id, node)}
      data-block-id={block.id}
      className={`block ${block.direction}${
        block.status ? ` ${block.status}` : ''
      }${isActive ? ' selected' : ''}${hasBranches ? ' has-branches' : ''}`}
      onMouseDown={onMouseDown}
      onClick={(event) => {
        event.stopPropagation()
        onClick(block.id)
      }}
    >
      {hasBranches ? (
        <span className="block-branch-marker-anchor">
          <span
            className="tooltip tooltip-hover-only"
            data-tooltip={`${branchChildCount} branches`}
          >
            <button
              className={`block-branch-marker${isForkFocused ? ' is-active' : ''}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onOpenPathsFork(block.id)
              }}
              aria-label={`${branchChildCount} branches`}
            >
              <span className="codicon codicon-layers" aria-hidden="true" />
              <span className="block-branch-marker-count">{branchChildCount}</span>
            </button>
          </span>
        </span>
      ) : null}
      {block.direction === 'input' ? (
        <blockquote className="input-quote">
          <ReactMarkdown
            remarkPlugins={MARKDOWN_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
          >
            {normalizeMathDelimiters(block.content)}
          </ReactMarkdown>
        </blockquote>
      ) : (
        <div className="output-markdown">
          <ReactMarkdown
            remarkPlugins={MARKDOWN_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
          >
            {normalizeMathDelimiters(block.content)}
          </ReactMarkdown>
        </div>
      )}
      <div
        className={`block-edge-actions${isActive ? ' is-visible' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        {canSetContinuationCursor ? (
          <span
            className="tooltip tooltip-hover-only"
            data-tooltip={
              isContinuationCursor ? 'Current branch source' : 'Branch from here'
            }
          >
            <button
              className={`block-edge-action${isContinuationCursor ? ' is-active' : ''}`}
              type="button"
              aria-label="Branch from here"
              onClick={() => onSetContinuationCursor(block.id)}
            >
              <span className="codicon codicon-git-branch" aria-hidden="true" />
            </button>
          </span>
        ) : null}
        {canGenerateNew && !isSending ? (
          <span className="tooltip tooltip-hover-only" data-tooltip="Generate new">
            <button
              className="block-edge-action"
              type="button"
              aria-label="Generate new"
              onClick={() => onRetry(block.id)}
            >
              <span className="codicon codicon-refresh" aria-hidden="true" />
            </button>
          </span>
        ) : null}
        <span className="tooltip tooltip-hover-only" data-tooltip="Copy block">
          <button
            className="block-edge-action"
            type="button"
            aria-label="Copy block"
            onClick={() => onCopy(block.id)}
          >
            <span className="codicon codicon-copy" aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  )
})

type ChatPaneProps = {
  blocks: Block[]
  activeBlockId: string | null
  branchOptionsByParentId: Record<string, BranchOption[]>
  focusedForkParentId: string | null
  continuationCursorBlockId: string | null
  isSending: boolean
  showEmptyState: boolean
  showConfigureLink: boolean
  onConfigure: () => void
  endRef: React.RefObject<HTMLDivElement | null>
  onChatClick: (event: MouseEvent<HTMLElement>) => void
  onBlockMouseDown: () => void
  onBlockClick: (id: string) => void
  onSetContinuationCursor: (id: string) => void
  onOpenPathsFork: (id: string) => void
  onRetryBlock: (id: string) => void
  onCopyBlock: (id: string) => void
  registerBlockRef: (id: string, node: HTMLDivElement | null) => void
}

const ChatPane = memo(function ChatPane({
  blocks,
  activeBlockId,
  branchOptionsByParentId,
  focusedForkParentId,
  continuationCursorBlockId,
  isSending,
  showEmptyState,
  showConfigureLink,
  onConfigure,
  endRef,
  onChatClick,
  onBlockMouseDown,
  onBlockClick,
  onSetContinuationCursor,
  onOpenPathsFork,
  onRetryBlock,
  onCopyBlock,
  registerBlockRef,
}: ChatPaneProps) {
  return (
    <main className="chat chat-pane" onClick={onChatClick}>
      {blocks.length === 0 && showEmptyState ? (
        <div className="chat-empty">
          <div className="chat-empty-title">No context yet</div>
          <div className="chat-empty-body">
            {showConfigureLink ? (
              <button
                className="chat-empty-link"
                type="button"
                onClick={onConfigure}
              >
                Configure your connection to start
              </button>
            ) : (
              <>Add a block to start building context</>
            )}
          </div>
        </div>
      ) : (
        <div className="chat-stream">
          {blocks.map((block) => (
            <BlockRow
              key={block.id}
              block={block}
              isActive={block.id === activeBlockId}
              branchOptions={branchOptionsByParentId[block.id] ?? []}
              isForkFocused={focusedForkParentId === block.id}
              isContinuationCursor={continuationCursorBlockId === block.id}
              isSending={isSending}
              onMouseDown={onBlockMouseDown}
              onClick={onBlockClick}
              onSetContinuationCursor={onSetContinuationCursor}
              onOpenPathsFork={onOpenPathsFork}
              onRetry={onRetryBlock}
              onCopy={onCopyBlock}
              registerRef={registerBlockRef}
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
  const [blocks, setBlocks] = useState<Block[]>([])
  const [collectionGraph, setCollectionGraph] = useState<CollectionGraph>({
    parentIdsByBlockId: {},
    childIdsByBlockId: {},
  })
  const [hasLoadedBlocks, setHasLoadedBlocks] = useState(false)
  const [draft, setDraft] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isSettingsClosing, setIsSettingsClosing] = useState(false)
  const [storageMode, setStorageMode] = useState<StorageMode>('session')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [temperature, setTemperature] = useState(1)
  const [showKey, setShowKey] = useState(false)
  const [suppressKeyTooltip, setSuppressKeyTooltip] = useState(false)
  const [suppressNewCollectionTooltip, setSuppressNewCollectionTooltip] =
    useState(false)
  const [suppressBranchesTooltip, setSuppressBranchesTooltip] = useState(false)
  const [suppressSettingsTooltip, setSuppressSettingsTooltip] = useState(false)
  const [suppressSidebarTooltip, setSuppressSidebarTooltip] = useState(false)
  const [suppressDeleteCollectionTooltip, setSuppressDeleteCollectionTooltip] =
    useState(false)
  const [isSending, setIsSending] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [exportSummary, setExportSummary] = useState<{
    filePath: string
    fileName: string
  } | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [isPickingExport, setIsPickingExport] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isPickingImport, setIsPickingImport] = useState(false)
  const [isReadingImport, setIsReadingImport] = useState(false)
  const [isImportingData, setIsImportingData] = useState(false)
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [collections, setCollections] = useState<CollectionRecord[]>([])
  const [pendingCollection, setPendingCollection] =
    useState<CollectionPayload | null>(null)
  const [activeCollection, setActiveCollection] =
    useState<CollectionRecord | null>(null)
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const [pathLeafId, setPathLeafId] = useState<string | null>(null)
  const [, setOpenBranchMenuParentId] = useState<string | null>(null)
  const [isPathsPanelOpen, setIsPathsPanelOpen] = useState(false)
  const [isPathsPanelClosing, setIsPathsPanelClosing] = useState(false)
  const [selectedPathsForkParentId, setSelectedPathsForkParentId] =
    useState<string | null>(null)
  const [pathsForkCanScrollLeft, setPathsForkCanScrollLeft] = useState(false)
  const [pathsForkCanScrollRight, setPathsForkCanScrollRight] =
    useState(false)
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
  const [copyCollectionAck, setCopyCollectionAck] = useState(false)
  const [suppressCopyBlockTooltip, setSuppressCopyBlockTooltip] =
    useState(false)
  const [suppressCopyCollectionTooltip, setSuppressCopyCollectionTooltip] =
    useState(false)
  const copyAckTimeoutRef = useRef<number | null>(null)
  const copyCollectionTimeoutRef = useRef<number | null>(null)
  const suppressCopyBlockTooltipRef = useRef<number | null>(null)
  const suppressCopyCollectionTooltipRef = useRef<number | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const selectedActionsDockRef = useRef<HTMLDivElement | null>(null)
  const mainColumnRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const blockRefs = useRef(new Map<string, HTMLDivElement>())
  const pathsForkRowRef = useRef<HTMLDivElement | null>(null)
  const settingsCloseTimeoutRef = useRef<number | null>(null)
  const pathsPanelCloseTimeoutRef = useRef<number | null>(null)
  const isMountedRef = useRef(true)
  const suppressBlockActivationRef = useRef(false)
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
  const selectPreviousBlockRef = useRef<() => void>(() => {})
  const selectNextBlockRef = useRef<() => void>(() => {})
  const scrollToTopRef = useRef<() => void>(() => {})
  const scrollToEndRef = useRef<() => void>(() => {})
  const sendMessageGuardRef = useRef(false)
  const maxRows = 9
  const trimmedDraft = draft.trim()
  const draftRef = useRef(draft)
  const trimmedDraftRef = useRef(trimmedDraft)
  const isSendingRef = useRef(isSending)
  const sendMessageRef = useRef<(() => Promise<void>) | null>(null)
  const effectiveActiveBlockId = isSettingsOpen ? null : activeBlockId
  const blocksById = useMemo(() => {
    const map = new Map<string, Block>()
    blocks.forEach((block) => {
      map.set(block.id, block)
    })
    return map
  }, [blocks])
  const blockIndexById = useMemo(() => {
    const indices: Record<string, number> = {}
    blocks.forEach((block, index) => {
      indices[block.id] = index
    })
    return indices
  }, [blocks])
  const activeBlock = useMemo(
    () =>
      (effectiveActiveBlockId ? blocksById.get(effectiveActiveBlockId) : null) ??
      null,
    [blocksById, effectiveActiveBlockId],
  )
  const resolvedParentIdByBlockId = useMemo(() => {
    const resolved: Record<string, string | null> = {}
    blocks.forEach((block, index) => {
      const graphParentIds = collectionGraph.parentIdsByBlockId[block.id] ?? []
      const graphParentId =
        graphParentIds.find((parentId) => blocksById.has(parentId)) ?? null
      if (graphParentId) {
        resolved[block.id] = graphParentId
        return
      }
      if (
        block.transientParentId &&
        blocksById.has(block.transientParentId)
      ) {
        resolved[block.id] = block.transientParentId
        return
      }
      if (block.retryParentId && blocksById.has(block.retryParentId)) {
        resolved[block.id] = block.retryParentId
        return
      }
      for (let prevIndex = index - 1; prevIndex >= 0; prevIndex -= 1) {
        const candidate = blocks[prevIndex]
        if (!candidate) {
          continue
        }
        resolved[block.id] = candidate.id
        return
      }
      resolved[block.id] = null
    })
    return resolved
  }, [blocks, blocksById, collectionGraph.parentIdsByBlockId])
  const childIdsByParentId = useMemo(() => {
    const byParent: Record<string, string[]> = {}
    Object.entries(resolvedParentIdByBlockId).forEach(([childId, parentId]) => {
      if (!parentId) {
        return
      }
      if (!byParent[parentId]) {
        byParent[parentId] = []
      }
      byParent[parentId].push(childId)
    })
    Object.values(byParent).forEach((childIds) => {
      childIds.sort(
        (a, b) => (blockIndexById[a] ?? 0) - (blockIndexById[b] ?? 0),
      )
    })
    return byParent
  }, [blockIndexById, resolvedParentIdByBlockId])
  const leafBlockIds = useMemo(() => {
    const leaves = blocks
      .filter((block) => (childIdsByParentId[block.id]?.length ?? 0) === 0)
      .map((block) => block.id)
    leaves.sort((a, b) => (blockIndexById[a] ?? 0) - (blockIndexById[b] ?? 0))
    return leaves
  }, [blockIndexById, blocks, childIdsByParentId])
  const latestLeafBlockId =
    leafBlockIds.length > 0
      ? leafBlockIds[leafBlockIds.length - 1]
      : blocks.length > 0
        ? blocks[blocks.length - 1]?.id ?? null
        : null
  const effectivePathLeafId =
    pathLeafId && blocksById.has(pathLeafId) ? pathLeafId : latestLeafBlockId
  const visiblePathBlockIds = useMemo(() => {
    if (!effectivePathLeafId) {
      return [] as string[]
    }
    const path: string[] = []
    const visited = new Set<string>()
    let cursorId: string | null = effectivePathLeafId
    while (cursorId && !visited.has(cursorId)) {
      visited.add(cursorId)
      path.push(cursorId)
      cursorId = resolvedParentIdByBlockId[cursorId] ?? null
    }
    path.reverse()
    return path
  }, [effectivePathLeafId, resolvedParentIdByBlockId])
  const visibleBlocks = useMemo(
    () =>
      visiblePathBlockIds
        .map((blockId) => blocksById.get(blockId))
        .filter((block): block is Block => Boolean(block)),
    [blocksById, visiblePathBlockIds],
  )
  const visibleBlockIdSet = useMemo(
    () => new Set(visiblePathBlockIds),
    [visiblePathBlockIds],
  )
  const persistedBlocksById = useMemo(() => {
    const map = new Map<string, Block>()
    blocksById.forEach((block, blockId) => {
      if (!isPersistedBlockId(block.id)) {
        return
      }
      map.set(blockId, block)
    })
    return map
  }, [blocksById])
  const branchOptionsByParentId = useMemo(() => {
    const optionsByParent: Record<string, BranchOption[]> = {}
    Object.entries(collectionGraph.childIdsByBlockId).forEach(
      ([parentId, childIds]) => {
        if (!persistedBlocksById.has(parentId)) {
          return
        }
        const options = childIds
          .filter((childId) => persistedBlocksById.has(childId))
          .map((childId) => {
            const childBlock = persistedBlocksById.get(childId)
            return {
              id: childId,
              summary: childBlock
                ? summarizeBranchPreview(childBlock.content)
                : null,
            }
          })
        if (options.length > 1) {
          optionsByParent[parentId] = options
        }
      },
    )
    return optionsByParent
  }, [collectionGraph.childIdsByBlockId, persistedBlocksById])
  const branchChildCountById = useMemo(() => {
    const counts: Record<string, number> = {}
    Object.entries(branchOptionsByParentId).forEach(([parentId, options]) => {
      if (options.length <= 1) {
        return
      }
      counts[parentId] = options.length
    })
    return counts
  }, [branchOptionsByParentId])
  const activeBranchChildIdByParentId = useMemo(() => {
    const activeChildren: Record<string, string> = {}
    for (
      let index = 0;
      index < visiblePathBlockIds.length - 1;
      index += 1
    ) {
      const parentId = visiblePathBlockIds[index]
      const childId = visiblePathBlockIds[index + 1]
      if (
        !parentId ||
        !childId ||
        !(branchOptionsByParentId[parentId] ?? []).some(
          (option) => option.id === childId,
        )
      ) {
        continue
      }
      activeChildren[parentId] = childId
    }
    return activeChildren
  }, [branchOptionsByParentId, visiblePathBlockIds])
  const allForkParentIds = useMemo(
    () =>
      blocks
        .filter((block) => isPersistedBlockId(block.id))
        .map((block) => block.id)
        .filter(
          (blockId) => (branchOptionsByParentId[blockId]?.length ?? 0) > 1,
        ),
    [blocks, branchOptionsByParentId],
  )
  const pathForkEntries = useMemo(
    () =>
      allForkParentIds.map((parentId, index) => {
          const options = branchOptionsByParentId[parentId] ?? []
          const activeChildId = activeBranchChildIdByParentId[parentId] ?? null
          const activeIndex = activeChildId
            ? options.findIndex((option) => option.id === activeChildId)
            : -1
          return {
            parentId,
            label: `Fork ${index + 1}`,
            shortLabel:
              summarizeForkPointLabel(
                persistedBlocksById.get(parentId)?.content ?? '',
              ) ?? `Fork ${index + 1}`,
            options,
            activeChildId,
            activeIndex,
            summary: summarizeBlockContent(
              persistedBlocksById.get(parentId)?.content ?? '',
              128,
            ),
          }
        }),
    [
      activeBranchChildIdByParentId,
      allForkParentIds,
      branchOptionsByParentId,
      persistedBlocksById,
    ],
  )
  const activePathForkParentId = useMemo(() => {
    for (let index = visiblePathBlockIds.length - 1; index >= 0; index -= 1) {
      const blockId = visiblePathBlockIds[index]
      if (!blockId) {
        continue
      }
      if ((branchOptionsByParentId[blockId]?.length ?? 0) > 1) {
        return blockId
      }
    }
    return null
  }, [branchOptionsByParentId, visiblePathBlockIds])
  const hasPathForks = pathForkEntries.length > 0
  const effectivePathsForkParentId =
    selectedPathsForkParentId &&
    pathForkEntries.some((entry) => entry.parentId === selectedPathsForkParentId)
      ? selectedPathsForkParentId
      : activePathForkParentId ?? pathForkEntries[0]?.parentId ?? null
  const selectedPathsForkEntry = useMemo(
    () =>
      effectivePathsForkParentId
        ? pathForkEntries.find(
            (entry) => entry.parentId === effectivePathsForkParentId,
          ) ?? null
        : null,
    [effectivePathsForkParentId, pathForkEntries],
  )
  const selectedPathsForkOptions = useMemo(
    () => selectedPathsForkEntry?.options ?? [],
    [selectedPathsForkEntry],
  )
  const previewPathsForkText =
    selectedPathsForkEntry?.summary ?? selectedPathsForkEntry?.shortLabel ?? ''
  const activeBranchChildCount =
    activeBlock && isPersistedBlockId(activeBlock.id)
      ? branchChildCountById[activeBlock.id] ?? 0
      : 0
  const defaultContinuationBlock = useMemo(() => {
    for (let index = visiblePathBlockIds.length - 1; index >= 0; index -= 1) {
      const blockId = visiblePathBlockIds[index]
      if (!blockId || !isPersistedBlockId(blockId)) {
        continue
      }
      const block = blocksById.get(blockId)
      if (!block || block.status || !block.payload) {
        continue
      }
      return block
    }
    return null
  }, [blocksById, visiblePathBlockIds])
  const effectiveContinuationBlock = defaultContinuationBlock
  const activePayload = activeBlock?.payload
  const activeWordMatches = useMemo(
    () => (activeBlock ? activeBlock.content.match(/\S+/g) : null),
    [activeBlock],
  )
  const groupedCollections = useMemo(
    () => groupCollectionsByDay(collections),
    [collections],
  )
  const inspectorStats = useMemo(
    () =>
      activeBlock
        ? {
            characters: activeBlock.content.length,
            words: activeWordMatches ? activeWordMatches.length : 0,
          }
        : null,
    [activeBlock, activeWordMatches],
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
            requestBaseUrl: activePayload.request?.baseUrl,
            requestEngine: activePayload.request?.engine,
          }
        : null,
    [activePayload],
  )
  const isAssistantBlock = inspectorMeta?.role === 'assistant'
  const completionTokensValue = inspectorMeta?.usage?.completionTokens
  const latencySeconds = formatLatencySeconds(inspectorMeta?.latencyMs)
  const quickFacts = useMemo(() => {
    const items: Array<{ key: string; content: React.ReactNode }> = []
    const quickTime = formatQuickTimestamp(inspectorMeta?.localTimestamp)
    if (quickTime) {
      items.push({ key: 'time', content: quickTime })
    }
    if (isAssistantBlock) {
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
    isAssistantBlock,
    latencySeconds,
  ])
  const promptTokens = formatTokenCount(inspectorMeta?.usage?.promptTokens)
  const completionTokens = formatTokenCount(
    inspectorMeta?.usage?.completionTokens,
  )
  const totalTokens = formatTokenCount(inspectorMeta?.usage?.totalTokens)
  const requestLocation = useMemo(() => {
    if (inspectorMeta?.requestBaseUrl) {
      return { label: 'Endpoint', value: inspectorMeta.requestBaseUrl }
    }
    if (inspectorMeta?.requestEngine) {
      return { label: 'Engine', value: inspectorMeta.requestEngine }
    }
    return null
  }, [inspectorMeta?.requestBaseUrl, inspectorMeta?.requestEngine])
  const canBranchFromActiveBlock = Boolean(
    activeBlock &&
      isPersistedBlockId(activeBlock.id) &&
      activeBlock.direction === 'output' &&
      !activeBlock.status,
  )
  const canGenerateNewFromActiveInput = Boolean(
    activeBlock &&
      activeBlock.direction === 'input' &&
      isPersistedBlockId(activeBlock.id),
  )
  const canGenerateNewFromActiveOutput = Boolean(
    activeBlock &&
      activeBlock.direction === 'output' &&
      (activeBlock.status === 'error' || activeBlock.status === 'canceled'),
  )
  const canGenerateNewFromActiveBlock =
    canGenerateNewFromActiveInput || canGenerateNewFromActiveOutput
  const isOffLatestPath = Boolean(
    latestLeafBlockId &&
      effectivePathLeafId &&
      effectivePathLeafId !== latestLeafBlockId,
  )
  const selectedBlockPreview = activeBlock
    ? summarizeBranchPreview(activeBlock.content)
    : previewPathsForkText || 'Branch path selected'
  const showSelectedActionsDock = Boolean(activeBlock || isOffLatestPath)
  const contextTokens = useMemo(() => {
    for (let index = visibleBlocks.length - 1; index >= 0; index -= 1) {
      const usage = visibleBlocks[index]?.payload?.response?.usage
      if (usage?.totalTokens) {
        return usage.totalTokens
      }
    }
    return null
  }, [visibleBlocks])
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
  const collectionTimestamp = isSettingsOpen
    ? undefined
    : activeCollection?.payload.localTimestamp ??
      pendingCollection?.localTimestamp
  const collectionDateLabel = formatLocalTimestampHeading(collectionTimestamp)
  const collectionBlockCountLabel = formatBlockCount(visibleBlocks.length)
  const canDeleteCollection =
    Boolean(activeCollection) &&
    activeCollection?.id !== demoCollection.id &&
    !isSettingsOpen
  const orderedCollections = useMemo(
    () => groupedCollections.flatMap((group) => group.collections),
    [groupedCollections],
  )
  const headerSubtitle = isSettingsOpen
    ? 'Settings'
    : collectionDateLabel ?? (hasLoadedBlocks ? 'Undated' : '')
  const showConfigureLink = settingsLoaded && baseUrl === ''
  const modelLabel = model || 'Provider default'
  const temperatureLabel = temperature.toFixed(1)
  const importPreviewSummary = importPreview?.summary ?? null
  const exportPreviewTime = formatExportedAt(importPreview?.payload.exportedAt)
  const exportPreviewFile = importPreview?.filePath
    ? getFileBasename(importPreview.filePath)
    : null
  const hasDataPanel = Boolean(importPreview || importSummary || exportSummary)
  const isImportLocked =
    Boolean(importPreview) || isReadingImport || isImportingData
  const canUseFileDialogs =
    typeof window !== 'undefined' &&
    typeof window.ipcRenderer?.invoke === 'function'
  const isBranchesSurfaceVisible =
    !isSettingsOpen && hasPathForks && (isPathsPanelOpen || isPathsPanelClosing)
  const isSidebarVisible = isSidebarOpen

  const upsertCollection = useCallback((collection: CollectionRecord) => {
    setCollections((prev) => {
      const next = prev.filter((item) => item.id !== collection.id)
      return [collection, ...next]
    })
  }, [])

  const attachBlockToGraph = useCallback(
    (childId: string, parentIds: string[]) => {
      setCollectionGraph((prev) => {
        const normalizedParents = parentIds.filter(Boolean)
        const nextParentsByBlockId = {
          ...prev.parentIdsByBlockId,
        }
        const nextChildrenByBlockId = {
          ...prev.childIdsByBlockId,
        }
        const currentParents = nextParentsByBlockId[childId] ?? []
        const mergedParents = [...currentParents]
        let didChange = !nextParentsByBlockId[childId]

        normalizedParents.forEach((parentId) => {
          if (!mergedParents.includes(parentId)) {
            mergedParents.push(parentId)
            didChange = true
          }
          const existingChildren = nextChildrenByBlockId[parentId] ?? []
          if (existingChildren.includes(childId)) {
            return
          }
          nextChildrenByBlockId[parentId] = [...existingChildren, childId]
          didChange = true
        })

        if (
          mergedParents.length !== currentParents.length ||
          !nextParentsByBlockId[childId]
        ) {
          nextParentsByBlockId[childId] = mergedParents
        }

        if (!didChange) {
          return prev
        }

        return {
          parentIdsByBlockId: nextParentsByBlockId,
          childIdsByBlockId: nextChildrenByBlockId,
        }
      })
    },
    [],
  )

  const getContextBlocksForParent = useCallback(
    (parentBlockId: string | null) => {
      if (!parentBlockId) {
        return [] as Array<Block & { payload: BlockPayload }>
      }

      const withPayload = blocks.filter(
        (
          block,
        ): block is Block & { payload: BlockPayload } =>
          !block.status && Boolean(block.payload),
      )
      const payloadBlockById = new Map(withPayload.map((block) => [block.id, block]))

      if (!payloadBlockById.has(parentBlockId)) {
        return [] as Array<Block & { payload: BlockPayload }>
      }

      const hasGraphData =
        Object.keys(collectionGraph.parentIdsByBlockId).length > 0

      if (!hasGraphData) {
        const parentIndex = blocks.findIndex((block) => block.id === parentBlockId)
        if (parentIndex === -1) {
          return [] as Array<Block & { payload: BlockPayload }>
        }
        return blocks.slice(0, parentIndex + 1).filter(
          (
            block,
          ): block is Block & { payload: BlockPayload } =>
            !block.status && Boolean(block.payload),
        )
      }

      const path: Array<Block & { payload: BlockPayload }> = []
      const visited = new Set<string>()
      let cursorId: string | null = parentBlockId

      while (cursorId && !visited.has(cursorId)) {
        visited.add(cursorId)
        const current = payloadBlockById.get(cursorId)
        if (!current) {
          break
        }
        path.push(current)
        const parents: string[] =
          collectionGraph.parentIdsByBlockId[cursorId] ?? []
        const nextParentId: string | null =
          parents.find((parentId: string) => payloadBlockById.has(parentId)) ??
          null
        cursorId = nextParentId
      }

      path.reverse()
      return path
    },
    [blocks, collectionGraph.parentIdsByBlockId],
  )

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

  const openSettings = useCallback(() => {
    if (settingsCloseTimeoutRef.current) {
      window.clearTimeout(settingsCloseTimeoutRef.current)
      settingsCloseTimeoutRef.current = null
    }
    setIsSettingsClosing(false)
    setIsSettingsOpen(true)
  }, [])

  const closeSettings = useCallback(() => {
    if (!isSettingsOpen) {
      return
    }
    if (settingsCloseTimeoutRef.current) {
      window.clearTimeout(settingsCloseTimeoutRef.current)
      settingsCloseTimeoutRef.current = null
    }
    setIsSettingsClosing(true)
    settingsCloseTimeoutRef.current = window.setTimeout(() => {
      setIsSettingsOpen(false)
      setIsSettingsClosing(false)
      settingsCloseTimeoutRef.current = null
    }, 120)
  }, [isSettingsOpen])

  useEffect(() => {
    openSettingsRef.current = () => {
      openSettings()
    }
  }, [openSettings])

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
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

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
        if (settingsCloseTimeoutRef.current) {
          window.clearTimeout(settingsCloseTimeoutRef.current)
          settingsCloseTimeoutRef.current = null
        }
        setIsSettingsClosing(false)
        setIsSettingsOpen(!nextBaseUrl)
        setSettingsLoaded(true)
      } catch {
        if (isMounted) {
          if (settingsCloseTimeoutRef.current) {
            window.clearTimeout(settingsCloseTimeoutRef.current)
            settingsCloseTimeoutRef.current = null
          }
          setIsSettingsClosing(false)
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
    return () => {
      if (settingsCloseTimeoutRef.current) {
        window.clearTimeout(settingsCloseTimeoutRef.current)
      }
      if (pathsPanelCloseTimeoutRef.current) {
        window.clearTimeout(pathsPanelCloseTimeoutRef.current)
      }
    }
  }, [])


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

  const loadCollections = useCallback(async () => {
    try {
      const storedCollections = await listCollections()
      if (!isMountedRef.current) {
        return
      }
      setCollections(storedCollections)
    } catch {
      // Ignore local persistence failures on cold start.
    }
  }, [])

  const loadBlocks = useCallback(async () => {
    if (!isMountedRef.current) {
      return
    }
    setHasLoadedBlocks(false)
    try {
      const collection = await getActiveCollection()
      if (!isMountedRef.current) {
        return
      }
      if (!collection) {
        setCollectionId(null)
        setActiveCollection(null)
        setPendingCollection(null)
        setSelectedCollectionId(null)
        setPathLeafId(null)
        setOpenBranchMenuParentId(null)
        setIsPathsPanelOpen(false)
        setSelectedPathsForkParentId(null)
        setBlocks([])
        setCollectionGraph({
          parentIdsByBlockId: {},
          childIdsByBlockId: {},
        })
        setHasLoadedBlocks(true)
        return
      }
      const storedGraph = await listCollectionBlockGraph(collection.id)
      if (!isMountedRef.current) {
        return
      }
      setCollectionId(collection.id)
      setActiveCollection(collection)
      setPendingCollection(null)
      setSelectedCollectionId(collection.id)
      setPathLeafId(null)
      setOpenBranchMenuParentId(null)
      setIsPathsPanelOpen(false)
      setSelectedPathsForkParentId(null)
      setBlocks(storedGraph.blocks.map(recordToBlock))
      setCollectionGraph({
        parentIdsByBlockId: storedGraph.parentIdsByBlockId,
        childIdsByBlockId: storedGraph.childIdsByBlockId,
      })
      setHasLoadedBlocks(true)
      if (storedGraph.blocks.length > 0) {
        pendingScrollRef.current = { mode: 'bottom', id: '' }
      }
    } catch {
      // Ignore local persistence failures on cold start.
      if (isMountedRef.current) {
        setPathLeafId(null)
        setOpenBranchMenuParentId(null)
        setIsPathsPanelOpen(false)
        setSelectedPathsForkParentId(null)
        setCollectionGraph({
          parentIdsByBlockId: {},
          childIdsByBlockId: {},
        })
        setHasLoadedBlocks(true)
      }
    }
  }, [])

  useEffect(() => {
    void Promise.all([loadCollections(), loadBlocks()])
  }, [loadCollections, loadBlocks])

  useEffect(() => {
    if (!blocks.length) {
      if (pathLeafId !== null) {
        setPathLeafId(null)
      }
      return
    }
    if (pathLeafId && blocksById.has(pathLeafId)) {
      return
    }
    if (latestLeafBlockId) {
      setPathLeafId(latestLeafBlockId)
    }
  }, [blocks.length, blocksById, latestLeafBlockId, pathLeafId])

  useEffect(() => {
    if (!activeBlockId) {
      return
    }
    if (visibleBlockIdSet.has(activeBlockId)) {
      return
    }
    setActiveBlockId(null)
  }, [activeBlockId, visibleBlockIdSet])

  const focusComposer = useCallback(() => {
    setActiveBlockId(null)
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

  const scrollToBlock = useCallback((blockId: string) => {
    setActiveBlockId(blockId)
    window.requestAnimationFrame(() => {
      blockRefs.current
        .get(blockId)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }, [])

  const selectPreviousBlock = useCallback(() => {
    if (!visibleBlocks.length) {
      return
    }

    const currentIndex = activeBlockId
      ? visibleBlocks.findIndex((block) => block.id === activeBlockId)
      : -1

    if (currentIndex === -1) {
      scrollToBlock(visibleBlocks[visibleBlocks.length - 1].id)
      return
    }

    if (currentIndex > 0) {
      scrollToBlock(visibleBlocks[currentIndex - 1].id)
    }
  }, [activeBlockId, scrollToBlock, visibleBlocks])

  const selectNextBlock = useCallback(() => {
    if (!visibleBlocks.length) {
      return
    }

    const currentIndex = activeBlockId
      ? visibleBlocks.findIndex((block) => block.id === activeBlockId)
      : -1

    if (currentIndex === -1 || currentIndex >= visibleBlocks.length - 1) {
      focusComposer()
      return
    }

    scrollToBlock(visibleBlocks[currentIndex + 1].id)
  }, [activeBlockId, focusComposer, scrollToBlock, visibleBlocks])


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
        selectPreviousBlock()
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        selectPreviousBlock()
        return
      }
      event.preventDefault()
      selectNextBlock()
    }

    window.addEventListener('keydown', handleArrowNavigation)
    return () => {
      window.removeEventListener('keydown', handleArrowNavigation)
    }
  }, [selectNextBlock, selectPreviousBlock])

  const handleCopyBlockById = useCallback(
    (blockId: string) => {
      const targetBlock = blocks.find((block) => block.id === blockId) ?? null
      if (!targetBlock) {
        return
      }
      void navigator.clipboard
        ?.writeText(targetBlock.content)
        .then(() => {
          setCopyAckId(blockId)
          setSuppressCopyBlockTooltip(false)
          if (suppressCopyBlockTooltipRef.current) {
            window.clearTimeout(suppressCopyBlockTooltipRef.current)
          }
          suppressCopyBlockTooltipRef.current = window.setTimeout(() => {
            setSuppressCopyBlockTooltip(true)
          }, COPY_TOOLTIP_SUPPRESS_MS)
          if (copyAckTimeoutRef.current) {
            window.clearTimeout(copyAckTimeoutRef.current)
          }
          copyAckTimeoutRef.current = window.setTimeout(() => {
            setCopyAckId((prev) => (prev === blockId ? null : prev))
          }, COPY_ACK_DURATION_MS)
        })
        .catch(() => {})
    },
    [blocks],
  )

  const handleCopyActiveBlock = useCallback(() => {
    if (!activeBlock) {
      return
    }
    const blockId = activeBlock.id
    handleCopyBlockById(blockId)
  }, [activeBlock, handleCopyBlockById])

  const handleCopyBlockFromStream = useCallback(
    (blockId: string) => {
      handleCopyBlockById(blockId)
    },
    [handleCopyBlockById],
  )

  const handleCopyCollection = useCallback(() => {
    if (!activeCollection) {
      return
    }
    const text = blocks
      .map((block) => {
        if (block.payload?.role !== 'user') {
          return block.content
        }
        return block.content
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      })
      .join('\n\n')
    if (!text) {
      return
    }
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopyCollectionAck(true)
        setSuppressCopyCollectionTooltip(false)
        if (suppressCopyCollectionTooltipRef.current) {
          window.clearTimeout(suppressCopyCollectionTooltipRef.current)
        }
        suppressCopyCollectionTooltipRef.current = window.setTimeout(() => {
          setSuppressCopyCollectionTooltip(true)
        }, COPY_TOOLTIP_SUPPRESS_MS)
        if (copyCollectionTimeoutRef.current) {
          window.clearTimeout(copyCollectionTimeoutRef.current)
        }
        copyCollectionTimeoutRef.current = window.setTimeout(() => {
          setCopyCollectionAck(false)
        }, COPY_ACK_DURATION_MS)
      })
      .catch(() => {})
  }, [activeCollection, blocks])

  const handleSetContinuationCursor = useCallback(
    (blockId: string) => {
      const targetBlock = blocks.find((block) => block.id === blockId) ?? null
      if (
        !targetBlock ||
        !isPersistedBlockId(blockId) ||
        targetBlock.direction !== 'output' ||
        Boolean(targetBlock.status)
      ) {
        return
      }
      setOpenBranchMenuParentId(null)
      setIsPathsPanelOpen(false)
      setPathLeafId(blockId)
      focusComposer()
    },
    [blocks, focusComposer],
  )

  const resolvePathLeafFromBlock = useCallback(
    (startBlockId: string) => {
      let cursorId: string | null = startBlockId
      const visited = new Set<string>()
      while (cursorId && !visited.has(cursorId)) {
        visited.add(cursorId)
        const cursorKey: string = cursorId
        const childIds: string[] = childIdsByParentId[cursorKey] ?? []
        if (childIds.length === 0) {
          break
        }
        let nextChildId: string | undefined
        if (childIds.length === 1) {
          nextChildId = childIds[0]
        } else {
          const preferredChildId: string | undefined =
            activeBranchChildIdByParentId[cursorKey]
          nextChildId =
            (preferredChildId && childIds.includes(preferredChildId)
              ? preferredChildId
              : undefined) ?? childIds[childIds.length - 1]
        }
        if (!nextChildId || visited.has(nextChildId)) {
          break
        }
        cursorId = nextChildId
      }
      return cursorId ?? startBlockId
    },
    [activeBranchChildIdByParentId, childIdsByParentId],
  )

  const handleSelectBranchStart = useCallback(
    (parentBlockId: string, childBlockId: string) => {
      const options = branchOptionsByParentId[parentBlockId] ?? []
      if (!options.some((option) => option.id === childBlockId)) {
        return
      }
      const nextLeafId = resolvePathLeafFromBlock(childBlockId)
      setOpenBranchMenuParentId(null)
      setPathLeafId(nextLeafId)
      scrollToBlock(childBlockId)
    },
    [branchOptionsByParentId, resolvePathLeafFromBlock, scrollToBlock],
  )

  const handleClosePathsPanel = useCallback(() => {
    if (!isPathsPanelOpen) {
      return
    }
    if (pathsPanelCloseTimeoutRef.current) {
      window.clearTimeout(pathsPanelCloseTimeoutRef.current)
      pathsPanelCloseTimeoutRef.current = null
    }
    setIsPathsPanelClosing(true)
    pathsPanelCloseTimeoutRef.current = window.setTimeout(() => {
      setIsPathsPanelOpen(false)
      setIsPathsPanelClosing(false)
      pathsPanelCloseTimeoutRef.current = null
    }, 120)
  }, [isPathsPanelOpen])

  const handleTogglePathsPanel = useCallback(() => {
    if (!hasPathForks) {
      return
    }
    setOpenBranchMenuParentId(null)
    if (isSettingsOpen) {
      closeSettings()
      if (pathsPanelCloseTimeoutRef.current) {
        window.clearTimeout(pathsPanelCloseTimeoutRef.current)
        pathsPanelCloseTimeoutRef.current = null
      }
      setIsPathsPanelClosing(false)
      setIsPathsPanelOpen(true)
      setSelectedPathsForkParentId((current) => {
        if (
          current &&
          pathForkEntries.some((entry) => entry.parentId === current)
        ) {
          return current
        }
        return activePathForkParentId ?? pathForkEntries[0]?.parentId ?? null
      })
      return
    }
    if (isPathsPanelOpen && !isPathsPanelClosing) {
      handleClosePathsPanel()
      return
    }
    if (pathsPanelCloseTimeoutRef.current) {
      window.clearTimeout(pathsPanelCloseTimeoutRef.current)
      pathsPanelCloseTimeoutRef.current = null
    }
    setIsPathsPanelClosing(false)
    setIsPathsPanelOpen(true)
    setSelectedPathsForkParentId((current) => {
      if (
        current &&
        pathForkEntries.some((entry) => entry.parentId === current)
      ) {
        return current
      }
      return activePathForkParentId ?? pathForkEntries[0]?.parentId ?? null
    })
  }, [
    activePathForkParentId,
    closeSettings,
    handleClosePathsPanel,
    hasPathForks,
    isSettingsOpen,
    isPathsPanelClosing,
    isPathsPanelOpen,
    pathForkEntries,
  ])

  const handleSelectPathsFork = useCallback(
    (parentId: string) => {
      if (!pathForkEntries.some((entry) => entry.parentId === parentId)) {
        return
      }
      setSelectedPathsForkParentId(parentId)
    },
    [pathForkEntries],
  )

  const handleOpenPathsFork = useCallback(
    (parentId: string) => {
      if (!pathForkEntries.some((entry) => entry.parentId === parentId)) {
        return
      }
      if (
        isPathsPanelOpen &&
        !isPathsPanelClosing &&
        effectivePathsForkParentId === parentId
      ) {
        handleClosePathsPanel()
        return
      }
      if (pathsPanelCloseTimeoutRef.current) {
        window.clearTimeout(pathsPanelCloseTimeoutRef.current)
        pathsPanelCloseTimeoutRef.current = null
      }
      if (isSettingsOpen) {
        closeSettings()
      }
      setIsPathsPanelClosing(false)
      setIsPathsPanelOpen(true)
      setSelectedPathsForkParentId(parentId)
    },
    [
      closeSettings,
      effectivePathsForkParentId,
      handleClosePathsPanel,
      isSettingsOpen,
      isPathsPanelClosing,
      isPathsPanelOpen,
      pathForkEntries,
    ],
  )

  const handleSelectPathsBranch = useCallback(
    (parentId: string, childId: string) => {
      setSelectedPathsForkParentId(parentId)
      handleSelectBranchStart(parentId, childId)
    },
    [handleSelectBranchStart],
  )

  const handleBackToLatestPath = useCallback(() => {
    if (!latestLeafBlockId) {
      return
    }
    setOpenBranchMenuParentId(null)
    setSelectedPathsForkParentId(null)
    setPathLeafId(latestLeafBlockId)
  }, [latestLeafBlockId])

  useEffect(() => {
    if (!isPathsPanelOpen && selectedPathsForkParentId === null) {
      return
    }
    if (hasPathForks) {
      return
    }
    if (isPathsPanelOpen) {
      setIsPathsPanelOpen(false)
      setIsPathsPanelClosing(false)
    }
    if (selectedPathsForkParentId !== null) {
      setSelectedPathsForkParentId(null)
    }
  }, [hasPathForks, isPathsPanelOpen, selectedPathsForkParentId])

  const updatePathsForkScrollAffordance = useCallback(() => {
    const rowEl = pathsForkRowRef.current
    if (!rowEl) {
      setPathsForkCanScrollLeft(false)
      setPathsForkCanScrollRight(false)
      return
    }
    const maxScrollLeft = rowEl.scrollWidth - rowEl.clientWidth
    const canScrollLeft = rowEl.scrollLeft > 1
    const canScrollRight = maxScrollLeft - rowEl.scrollLeft > 1
    setPathsForkCanScrollLeft(canScrollLeft)
    setPathsForkCanScrollRight(canScrollRight)
  }, [])

  const handleForkRowScroll = useCallback(() => {
    updatePathsForkScrollAffordance()
  }, [updatePathsForkScrollAffordance])

  const handleForkRowScrollBy = useCallback((direction: 'left' | 'right') => {
    const rowEl = pathsForkRowRef.current
    if (!rowEl) {
      return
    }
    const delta = Math.max(rowEl.clientWidth * 0.55, 140)
    rowEl.scrollBy({
      left: direction === 'left' ? -delta : delta,
      behavior: 'smooth',
    })
  }, [])

  useEffect(() => {
    if (isPathsPanelOpen) {
      return
    }
    if (pathsPanelCloseTimeoutRef.current) {
      window.clearTimeout(pathsPanelCloseTimeoutRef.current)
      pathsPanelCloseTimeoutRef.current = null
    }
    if (isPathsPanelClosing) {
      setIsPathsPanelClosing(false)
    }
  }, [isPathsPanelClosing, isPathsPanelOpen])

  useEffect(() => {
    if (!selectedPathsForkParentId) {
      return
    }
    if (
      pathForkEntries.some(
        (entry) => entry.parentId === selectedPathsForkParentId,
      )
    ) {
      return
    }
    setSelectedPathsForkParentId(
      activePathForkParentId ?? pathForkEntries[0]?.parentId ?? null,
    )
  }, [activePathForkParentId, pathForkEntries, selectedPathsForkParentId])

  useEffect(() => {
    if (!isPathsPanelOpen) {
      setPathsForkCanScrollLeft(false)
      setPathsForkCanScrollRight(false)
      return
    }
    updatePathsForkScrollAffordance()
  }, [
    isPathsPanelOpen,
    pathForkEntries.length,
    selectedPathsForkEntry,
    updatePathsForkScrollAffordance,
  ])

  useEffect(() => {
    if (!isPathsPanelOpen || typeof ResizeObserver === 'undefined') {
      return
    }
    const rowEl = pathsForkRowRef.current
    if (!rowEl) {
      return
    }
    const observer = new ResizeObserver(() => {
      updatePathsForkScrollAffordance()
    })
    observer.observe(rowEl)
    return () => {
      observer.disconnect()
    }
  }, [isPathsPanelOpen, updatePathsForkScrollAffordance])

  useEffect(() => {
    if (!isPathsPanelOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      handleClosePathsPanel()
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleClosePathsPanel, isPathsPanelOpen])

  const handleSetContinuationFromActiveBlock = useCallback(() => {
    if (
      !activeBlock ||
      !isPersistedBlockId(activeBlock.id) ||
      activeBlock.direction !== 'output' ||
      Boolean(activeBlock.status)
    ) {
      return
    }
    handleSetContinuationCursor(activeBlock.id)
  }, [activeBlock, handleSetContinuationCursor])

  const handleSelectCollection = useCallback((collection: CollectionRecord) => {
    const requestId = collectionLoadIdRef.current + 1
    collectionLoadIdRef.current = requestId
    setSelectedCollectionId(collection.id)
    setCollectionId(collection.id)
    setActiveCollection(collection)
    setPendingCollection(null)
    setActiveBlockId(null)
    setPathLeafId(null)
    setOpenBranchMenuParentId(null)
    setIsPathsPanelOpen(false)
    setSelectedPathsForkParentId(null)
    setLastRunStats(null)

    if (collection.id === demoCollection.id) {
      setHasLoadedBlocks(false)
      setBlocks(demoCollectionBlocks.map(recordToBlock))
      setCollectionGraph({
        parentIdsByBlockId: {},
        childIdsByBlockId: {},
      })
      setHasLoadedBlocks(true)
      if (demoCollectionBlocks.length > 0) {
        pendingScrollRef.current = { mode: 'bottom', id: '' }
      }
      return
    }

    setHasLoadedBlocks(false)
    setBlocks([])
    setPathLeafId(null)
    setOpenBranchMenuParentId(null)
    setIsPathsPanelOpen(false)
    setSelectedPathsForkParentId(null)
    setCollectionGraph({
      parentIdsByBlockId: {},
      childIdsByBlockId: {},
    })
    void setActiveCollectionId(collection.id)
    void listCollectionBlockGraph(collection.id)
      .then((graph) => {
        if (collectionLoadIdRef.current !== requestId) {
          return
        }
        setBlocks(graph.blocks.map(recordToBlock))
        setCollectionGraph({
          parentIdsByBlockId: graph.parentIdsByBlockId,
          childIdsByBlockId: graph.childIdsByBlockId,
        })
        setHasLoadedBlocks(true)
        if (graph.blocks.length > 0) {
          pendingScrollRef.current = { mode: 'bottom', id: '' }
        }
      })
      .catch(() => {
        if (collectionLoadIdRef.current !== requestId) {
          return
        }
        setBlocks([])
        setPathLeafId(null)
        setOpenBranchMenuParentId(null)
        setIsPathsPanelOpen(false)
        setSelectedPathsForkParentId(null)
        setCollectionGraph({
          parentIdsByBlockId: {},
          childIdsByBlockId: {},
        })
        setHasLoadedBlocks(true)
      })
  }, [])

  useEffect(() => {
    if (copyAckId && activeBlock?.id !== copyAckId) {
      setCopyAckId(null)
    }
    if (suppressCopyBlockTooltipRef.current) {
      window.clearTimeout(suppressCopyBlockTooltipRef.current)
      suppressCopyBlockTooltipRef.current = null
    }
    setSuppressCopyBlockTooltip(false)
  }, [activeBlock?.id, copyAckId])

  useEffect(() => {
    setCopyCollectionAck(false)
    setSuppressCopyCollectionTooltip(false)
    setSuppressDeleteCollectionTooltip(false)
    if (copyCollectionTimeoutRef.current) {
      window.clearTimeout(copyCollectionTimeoutRef.current)
      copyCollectionTimeoutRef.current = null
    }
    if (suppressCopyCollectionTooltipRef.current) {
      window.clearTimeout(suppressCopyCollectionTooltipRef.current)
      suppressCopyCollectionTooltipRef.current = null
    }
  }, [activeCollection?.id])

  useEffect(() => {
    return () => {
      if (copyAckTimeoutRef.current) {
        window.clearTimeout(copyAckTimeoutRef.current)
      }
      if (copyCollectionTimeoutRef.current) {
        window.clearTimeout(copyCollectionTimeoutRef.current)
      }
      if (suppressCopyBlockTooltipRef.current) {
        window.clearTimeout(suppressCopyBlockTooltipRef.current)
      }
      if (suppressCopyCollectionTooltipRef.current) {
        window.clearTimeout(suppressCopyCollectionTooltipRef.current)
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

      if (!activeBlock) {
        return
      }

      event.preventDefault()
      void handleCopyActiveBlock()
    }

    window.addEventListener('keydown', handleCopyShortcut)
    return () => {
      window.removeEventListener('keydown', handleCopyShortcut)
    }
  }, [activeBlock, handleCopyActiveBlock])

  useEffect(() => {
    if (!window.ipcRenderer?.on) {
      return
    }

    const handleFocusComposer = () => {
      focusComposerRef.current()
    }
    const handleSelectPrevious = () => {
      selectPreviousBlockRef.current()
    }
    const handleSelectNext = () => {
      selectNextBlockRef.current()
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
    isSendingRef.current = isSending
  }, [draft, trimmedDraft, isSending])

  useLayoutEffect(() => {
    followRef.current = isNearBottom()
    stickToBottomRef.current = isAtBottom()
  }, [isAtBottom, isNearBottom, blocks.length])

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

  const queueScrollToBlockForReading = useCallback((blockId: string) => {
    window.requestAnimationFrame(() => {
      const container = mainColumnRef.current
      const node = blockRefs.current.get(blockId)
      if (!container || !node) {
        queueScrollToBottom()
        return
      }
      const containerRect = container.getBoundingClientRect()
      const composerRect = composerRef.current?.getBoundingClientRect()
      const selectedActionsRect =
        selectedActionsDockRef.current?.getBoundingClientRect()
      const effectiveBottom = Math.min(
        containerRect.bottom,
        composerRect?.top ?? containerRect.bottom,
        selectedActionsRect?.top ?? containerRect.bottom,
      )
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
  }, [
    getScrollPeekPx,
    isAtBottom,
    isNearBottom,
    markProgrammaticScroll,
    queueScrollToBottom,
  ])

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
    selectPreviousBlockRef.current = selectPreviousBlock
    selectNextBlockRef.current = selectNextBlock
    scrollToTopRef.current = scrollToTop
    scrollToEndRef.current = scrollToEnd
  }, [
    focusComposer,
    scrollToEnd,
    scrollToTop,
    selectNextBlock,
    selectPreviousBlock,
  ])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasPrimaryModifier = IS_MAC ? event.metaKey : event.ctrlKey
      if (!hasPrimaryModifier) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setActiveBlockId(null)
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
    queueScrollToBlockForReading(pending.id)
  }, [blocks, queueScrollToBottom, queueScrollToBlockForReading])

  useLayoutEffect(() => {
    if (!activeBlockId) {
      return
    }
    queueScrollToBlockForReading(activeBlockId)
  }, [activeBlockId, queueScrollToBlockForReading, showSelectedActionsDock])

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
    if (isSettingsOpen && !isSettingsClosing) {
      closeSettings()
    } else {
      openSettings()
    }
    setSuppressSettingsTooltip(true)
  }

  const handleToggleSidebar = () => {
    updateSidebarOpen((prev) => !prev)
    setSuppressSidebarTooltip(true)
  }

  const handleExportData = useCallback(async () => {
    setExportSummary(null)
    setDataError(null)
    setImportPreview(null)
    setImportSummary(null)
    if (!canUseFileDialogs) {
      setDataError('Export is not available in this environment.')
      return
    }
    setIsPickingExport(true)
    try {
      const result = await exportData(() => {
        setIsPickingExport(false)
        setIsExporting(true)
      })
      if (result.status === 'canceled') {
        return
      }
      setExportSummary({
        filePath: result.filePath,
        fileName: result.fileName,
      })
    } catch {
      setDataError('Export failed.')
    } finally {
      setIsPickingExport(false)
      setIsExporting(false)
    }
  }, [canUseFileDialogs])

  const handleImportData = useCallback(async () => {
    setExportSummary(null)
    setDataError(null)
    setImportPreview(null)
    setImportSummary(null)
    if (!canUseFileDialogs) {
      setDataError('Import is not available in this environment.')
      return
    }
    setIsPickingImport(true)
    try {
      const result = await loadImportPreview(() => {
        setIsPickingImport(false)
        setIsReadingImport(true)
      })
      if (result.status === 'canceled') {
        return
      }
      setImportPreview(result.preview)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Import failed.'
      setDataError(message)
    } finally {
      setIsPickingImport(false)
      setIsReadingImport(false)
    }
  }, [canUseFileDialogs])

  const handleCancelImport = useCallback(() => {
    setImportPreview(null)
    setImportSummary(null)
    setDataError(null)
  }, [])

  const handleConfirmImport = useCallback(async () => {
    if (!importPreview) {
      return
    }
    setExportSummary(null)
    setDataError(null)
    setImportSummary(null)
    setIsImportingData(true)
    try {
      const { summary } = await applyImport(importPreview.payload)
      setImportPreview(null)
      const ignoredRecords =
        summary.records.skipped +
        summary.records.duplicates +
        summary.records.conflicts
      const ignoredRelations =
        summary.relations.skipped +
        summary.relations.duplicates +
        summary.relations.conflicts +
        summary.relations.missingEndpoints
      const branchingSummary =
        summary.branching.forkPointsAdded > 0
          ? `Detected ${summary.branching.forkPointsAdded} new branch point${summary.branching.forkPointsAdded === 1 ? '' : 's'} (${summary.branching.forkPointsAfter} total).`
          : `Branch points total: ${summary.branching.forkPointsAfter}.`
      setImportSummary(
        `Imported ${summary.records.imported} records and ${summary.relations.imported} relations. Ignored ${ignoredRecords} records (${summary.records.conflicts} conflicts) and ${ignoredRelations} relations. ${branchingSummary}`,
      )
      void Promise.all([loadCollections(), loadBlocks()])
    } catch {
      setDataError('Import failed.')
    } finally {
      setIsImportingData(false)
    }
  }, [importPreview, loadBlocks, loadCollections])

  const handleDismissImportSummary = useCallback(() => {
    setImportSummary(null)
  }, [])

  const handleDismissExportSummary = useCallback(() => {
    setExportSummary(null)
  }, [])

  const handleRevealExport = useCallback(() => {
    if (!exportSummary?.filePath) {
      return
    }
    void revealExportedFile(exportSummary.filePath)
  }, [exportSummary?.filePath])

  const startNewCollection = useCallback(() => {
    setSuppressNewCollectionTooltip(true)
    setSelectedCollectionId(null)
    setBlocks([])
    setPathLeafId(null)
    setOpenBranchMenuParentId(null)
    setIsPathsPanelOpen(false)
    setSelectedPathsForkParentId(null)
    setCollectionGraph({
      parentIdsByBlockId: {},
      childIdsByBlockId: {},
    })
    setDraft('')
    setCollectionId(null)
    setActiveCollection(null)
    setPendingCollection({
      title: NEW_COLLECTION_TITLE,
      localTimestamp: formatLocalTimestamp(new Date()),
    })
    setActiveBlockId(null)
    setLastRunStats(null)

    focusComposer()
  }, [focusComposer])

  const handleStartNewCollection = useCallback(() => {
    closeSettings()
    startNewCollection()
  }, [closeSettings, startNewCollection])

  const handleDeleteCollection = useCallback(() => {
    if (!activeCollection || activeCollection.id === demoCollection.id) {
      return
    }
    const currentIndex = orderedCollections.findIndex(
      (collection) => collection.id === activeCollection.id,
    )
    const nextCollection =
      currentIndex >= 0 && orderedCollections.length > 1
        ? orderedCollections[currentIndex + 1] ??
          orderedCollections[currentIndex - 1] ??
          null
        : null
    setSuppressDeleteCollectionTooltip(true)
    window.setTimeout(() => {
      const title = getCollectionTitle(activeCollection)
      const confirmed = window.confirm(
        `Delete "${title}"? This cannot be undone.`,
      )
      if (!confirmed) {
        return
      }
      setActiveBlockId(null)
      setLastRunStats(null)
      void deleteCollection(activeCollection.id)
        .then(() => {
          if (nextCollection) {
            handleSelectCollection(nextCollection)
          } else {
            startNewCollection()
          }
        })
        .then(() => loadCollections())
        .catch(() => {})
    }, 0)
  }, [
    activeCollection,
    handleSelectCollection,
    loadCollections,
    orderedCollections,
    startNewCollection,
  ])

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

  const handleRetryContinuation = useCallback(
    async (targetBlockId: string) => {
      if (isSendingRef.current || sendMessageGuardRef.current) {
        return
      }
      sendMessageGuardRef.current = true

      try {
        const runAssistantAttempt = async (
          assistantBlockId: string,
          parentUserBlock: Block & { payload: BlockPayload },
          parentUserId: string,
        ) => {
          const parentIds = collectionGraph.parentIdsByBlockId[parentUserId] ?? []
          const contextParentId =
            parentIds.find((parentId) => persistedBlocksById.has(parentId)) ??
            null
          const endpoint = buildChatCompletionEndpoint(baseUrl)
          const request = buildBlockRequest(baseUrl, model, temperature)

          const shouldAutoScroll = isNearBottom()
          if (shouldAutoScroll) {
            pendingScrollRef.current = { id: assistantBlockId, mode: 'bottom' }
          }

          if (!endpoint) {
            setBlocks((prev) =>
              prev.map((block) =>
                block.id === assistantBlockId
                  ? {
                      ...block,
                      content:
                        'Error: Add a base URL (OPENAI_BASE_URL style) in Connection settings first.',
                      status: 'error',
                      retryParentId: parentUserId,
                      transientParentId: parentUserId,
                    }
                  : block,
              ),
            )
            return
          }

          const contextBlocks = getContextBlocksForParent(contextParentId)
          const contextPayloads = [...contextBlocks, parentUserBlock]
            .map((block) => block.payload)
            .filter((payload): payload is BlockPayload => Boolean(payload))

          const timeoutController = createTimeoutController(REQUEST_TIMEOUT_MS)
          abortControllerRef.current = timeoutController
          setIsSending(true)
          const requestStart = Date.now()

          try {
            const { content: nextContent, raw } = await createChatCompletion({
              baseUrl,
              apiKey: apiKey || undefined,
              messages: toChatMessages(contextPayloads),
              model: model || undefined,
              temperature,
              fetchFn: (input, init) =>
                window.fetch(input, init as RequestInit | undefined),
              signal: timeoutController.signal,
            })
            const latencyMs = Date.now() - requestStart
            const response = buildBlockResponse(raw, latencyMs)
            setLastRunStats({
              completionTokens: response?.usage?.completionTokens,
              latencyMs,
            })
            const assistantPayload = toBlockPayload('assistant', nextContent, {
              request,
              response,
            })

            setBlocks((prev) =>
              prev.map((block) =>
                block.id === assistantBlockId
                  ? {
                      ...block,
                      content: nextContent,
                      status: undefined,
                      payload: assistantPayload,
                      retryParentId: undefined,
                      transientParentId: parentUserId,
                    }
                  : block,
              ),
            )

            if (
              collectionId &&
              selectedCollectionId !== demoCollection.id &&
              isPersistedBlockId(parentUserId)
            ) {
              const assistantRecordId = createId('block')
              void appendBlock(collectionId, assistantPayload, {
                parentIds: [parentUserId],
                recordId: assistantRecordId,
              })
                .then((record) => {
                  attachBlockToGraph(record.id, [parentUserId])
                  setBlocks((prev) =>
                    prev.map((block) =>
                      block.id === assistantBlockId
                        ? {
                            ...block,
                            id: record.id,
                            content: nextContent,
                            payload: assistantPayload,
                            status: undefined,
                            retryParentId: undefined,
                            transientParentId: undefined,
                          }
                        : block,
                    ),
                  )
                  setPathLeafId((prev) =>
                    prev === assistantBlockId ? record.id : prev,
                  )
                })
                .catch((error) => {
                  console.error(
                    '[blocks] failed to persist retry assistant block',
                    error,
                  )
                })
            }

            if (shouldAutoScroll) {
              pendingScrollRef.current = { id: assistantBlockId, mode: 'read' }
            }
          } catch (error) {
            if (isAbortError(error)) {
              setBlocks((prev) =>
                prev.map((block) =>
                  block.id === assistantBlockId
                    ? {
                        ...block,
                        content: 'Request stopped.',
                        status: 'canceled',
                        retryParentId: parentUserId,
                        transientParentId: parentUserId,
                      }
                    : block,
                ),
              )
              if (shouldAutoScroll) {
                pendingScrollRef.current = { id: assistantBlockId, mode: 'read' }
              }
              return
            }
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error occurred.'
            setBlocks((prev) =>
              prev.map((block) =>
                block.id === assistantBlockId
                  ? {
                      ...block,
                      content: `Error: ${errorMessage}`,
                      status: 'error',
                      retryParentId: parentUserId,
                      transientParentId: parentUserId,
                    }
                  : block,
              ),
            )
            if (shouldAutoScroll) {
              pendingScrollRef.current = { id: assistantBlockId, mode: 'read' }
            }
          } finally {
            setIsSending(false)
            timeoutController.clear()
            abortControllerRef.current = null
          }
        }

        const targetIndex = blocks.findIndex((block) => block.id === targetBlockId)
        if (targetIndex === -1) {
          return
        }

        const targetBlock = blocks[targetIndex]

        if (
          targetBlock.direction === 'input' &&
          targetBlock.payload &&
          isPersistedBlockId(targetBlock.id)
        ) {
          const parentUserBlock = targetBlock as Block & { payload: BlockPayload }
          const parentUserId = parentUserBlock.id
          const pendingAssistantId = `b-${Date.now()}-retry-output`
          const pendingAssistantBlock: Block = {
            id: pendingAssistantId,
            direction: 'output',
            content: '',
            status: 'pending',
            retryParentId: parentUserId,
            transientParentId: parentUserId,
          }
          setBlocks((prev) => {
            const parentIndex = prev.findIndex((block) => block.id === parentUserId)
            if (parentIndex === -1) {
              return [...prev, pendingAssistantBlock]
            }
            const next = [...prev]
            next.splice(parentIndex + 1, 0, pendingAssistantBlock)
            return next
          })
          setPathLeafId(pendingAssistantId)
          await runAssistantAttempt(
            pendingAssistantId,
            parentUserBlock,
            parentUserId,
          )
          return
        }

        const parentCandidate =
          (targetBlock.retryParentId
            ? blocks.find((block) => block.id === targetBlock.retryParentId)
            : null) ??
          blocks
            .slice(0, targetIndex)
            .reverse()
            .find(
              (block) =>
                block.direction === 'input' && Boolean(block.payload),
            ) ??
          null

        const parentUserBlock: (Block & { payload: BlockPayload }) | null =
          parentCandidate &&
          parentCandidate.direction === 'input' &&
          parentCandidate.payload
            ? (parentCandidate as Block & { payload: BlockPayload })
            : null

        if (!parentUserBlock?.payload) {
          setBlocks((prev) =>
            prev.map((block) =>
              block.id === targetBlockId
                ? {
                    ...block,
                    status: 'error',
                    content:
                      'Error: Retry failed because the parent block context is unavailable.',
                  }
                : block,
            ),
          )
          return
        }

        const parentUserId = parentUserBlock.id
        setBlocks((prev) =>
          prev.map((block) =>
            block.id === targetBlockId
              ? {
                  ...block,
                  content: '',
                  status: 'pending',
                  payload: undefined,
                  retryParentId: parentUserId,
                  transientParentId: parentUserId,
                }
              : block,
          ),
        )
        setPathLeafId(targetBlockId)

        await runAssistantAttempt(targetBlockId, parentUserBlock, parentUserId)
      } finally {
        sendMessageGuardRef.current = false
      }
    },
    [
      apiKey,
      attachBlockToGraph,
      baseUrl,
      blocks,
      collectionGraph.parentIdsByBlockId,
      collectionId,
      getContextBlocksForParent,
      isNearBottom,
      model,
      persistedBlocksById,
      selectedCollectionId,
      temperature,
    ],
  )

  const sendMessage = async () => {
    if (!trimmedDraft || isSending || sendMessageGuardRef.current) {
      return
    }
    sendMessageGuardRef.current = true

    try {
      const parentBlockId = defaultContinuationBlock?.id ?? null
      const derivedTitle = deriveCollectionTitle(trimmedDraft)
      const endpoint = buildChatCompletionEndpoint(baseUrl)
      const request = buildBlockRequest(baseUrl, model, temperature)
      const timestamp = Date.now()
      const userRecordId = createId('block')
      const assistantRecordId = createId('block')
      const userPayload = toBlockPayload('user', trimmedDraft, {
        request,
      })
      const userBlock: Block = {
        id: `b-${timestamp}-input`,
        direction: 'input',
        content: trimmedDraft,
        payload: userPayload,
        transientParentId: parentBlockId,
      }

      const assistantBlock: Block = {
        id: `b-${timestamp}-output`,
        direction: 'output',
        content: '',
        status: 'pending',
        retryParentId: userBlock.id,
        transientParentId: userBlock.id,
      }

      setBlocks((prev) => [...prev, userBlock, assistantBlock])
      setPathLeafId(assistantBlock.id)
      setDraft('')
      const shouldAutoScroll = isNearBottom()
      followRef.current = shouldAutoScroll

      if (shouldAutoScroll) {
        submitFollowBreakRef.current = nearBottomBreakRef.current
        pendingScrollRef.current = { id: assistantBlock.id, mode: 'bottom' }
      } else {
        submitFollowBreakRef.current = null
      }

      let targetCollectionId = collectionId
      let userRecordPromise: Promise<BlockRecord | null> | null = null
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
        blocks.length === 0 &&
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
        const pendingUserRecord = appendBlock(
          targetCollectionId,
          userPayload,
          {
            parentIds: parentBlockId ? [parentBlockId] : undefined,
            recordId: userRecordId,
          },
        )
        userRecordPromise = pendingUserRecord
        void pendingUserRecord
          .then((record) => {
            attachBlockToGraph(record.id, parentBlockId ? [parentBlockId] : [])
            setBlocks((prev) =>
              prev.map((block) =>
                block.id === userBlock.id
                  ? { ...block, id: record.id }
                  : block.id === assistantBlock.id &&
                      block.retryParentId === userBlock.id
                    ? {
                        ...block,
                        retryParentId: record.id,
                        transientParentId: record.id,
                      }
                    : block,
              ),
            )
            setActiveBlockId((prev) =>
              prev === userBlock.id ? record.id : prev,
            )
          })
          .catch((error) => {
            console.error('[blocks] failed to persist user block', error)
          })
      }

      if (!endpoint) {
        setBlocks((prev) =>
          prev.map((block) =>
            block.id === assistantBlock.id
              ? {
                  ...block,
                  content:
                    'Error: Add a base URL (OPENAI_BASE_URL style) in Connection settings first.',
                  status: 'error',
                }
              : block,
          ),
        )
        return
      }

      const contextBlocks = getContextBlocksForParent(parentBlockId)
      const contextPayloads = [...contextBlocks, userBlock]
        .map((block) => block.payload)
        .filter((payload): payload is BlockPayload => Boolean(payload))
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
        const response = buildBlockResponse(raw, latencyMs)
        setLastRunStats({
          completionTokens: response?.usage?.completionTokens,
          latencyMs,
        })
        const assistantPayload = toBlockPayload('assistant', nextContent, {
          request,
          response,
        })

        const shouldAutoScroll =
          submitFollowBreakRef.current !== null &&
          submitFollowBreakRef.current === nearBottomBreakRef.current
        setBlocks((prev) =>
          prev.map((block) =>
            block.id === assistantBlock.id
              ? {
                  ...block,
                  content: nextContent,
                  status: undefined,
                  payload: assistantPayload,
                  retryParentId: undefined,
                }
              : block,
          ),
        )
        if (targetCollectionId && selectedCollectionId !== demoCollection.id) {
          let assistantParentId: string | null = null
          if (userRecordPromise) {
            const userRecord = await userRecordPromise.catch(() => null)
            assistantParentId = userRecord?.id ?? null
          }
          void appendBlock(
            targetCollectionId,
            assistantPayload,
            {
              parentIds: assistantParentId ? [assistantParentId] : undefined,
              recordId: assistantRecordId,
            },
          )
            .then((record) => {
              attachBlockToGraph(
                record.id,
                assistantParentId ? [assistantParentId] : [],
              )
                  setBlocks((prev) =>
                    prev.map((block) =>
                      block.id === assistantBlock.id
                        ? {
                            ...block,
                            id: record.id,
                            content: nextContent,
                            retryParentId: undefined,
                            transientParentId: undefined,
                          }
                        : block,
                    ),
                  )
                  setPathLeafId((prev) =>
                    prev === assistantBlock.id ? record.id : prev,
                  )
              setActiveBlockId((prev) =>
                prev === assistantBlock.id ? record.id : prev,
              )
            })
            .catch((error) => {
              console.error(
                '[blocks] failed to persist assistant block',
                error,
              )
            })
        }
        if (shouldAutoScroll) {
          pendingScrollRef.current = { id: assistantBlock.id, mode: 'read' }
        }
      } catch (error) {
        if (isAbortError(error)) {
          const shouldAutoScroll =
            submitFollowBreakRef.current !== null &&
            submitFollowBreakRef.current === nearBottomBreakRef.current
          setBlocks((prev) =>
            prev.map((item) =>
              item.id === assistantBlock.id
                ? { ...item, content: 'Request stopped.', status: 'canceled' }
                : item,
            ),
          )
          if (shouldAutoScroll) {
            pendingScrollRef.current = { id: assistantBlock.id, mode: 'read' }
          }
          return
        }
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred.'
        const shouldAutoScroll =
          submitFollowBreakRef.current !== null &&
          submitFollowBreakRef.current === nearBottomBreakRef.current
        setBlocks((prev) =>
          prev.map((item) =>
            item.id === assistantBlock.id
              ? { ...item, content: `Error: ${errorMessage}`, status: 'error' }
              : item,
          ),
        )
        if (shouldAutoScroll) {
          pendingScrollRef.current = { id: assistantBlock.id, mode: 'read' }
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
    if (isSendingRef.current || !trimmedDraftRef.current) {
      return
    }
    void sendMessageRef.current?.()
  }, [])

  const handleSubmitContinuationMultiline = useCallback(() => {
    handleSubmitContinuation()
  }, [handleSubmitContinuation])

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
    if (target.closest('.block')) {
      return
    }
    setOpenBranchMenuParentId(null)
    setIsPathsPanelOpen(false)
    setActiveBlockId(null)
  }, [])

  const hasTextSelection = useCallback(() => {
    const selection = window.getSelection()
    return Boolean(selection && selection.toString().length > 0)
  }, [])

  const handleBlockMouseDown = useCallback(() => {
    if (hasTextSelection()) {
      suppressBlockActivationRef.current = true
    }
  }, [hasTextSelection])

  const handleBlockClick = useCallback(
    (blockId: string) => {
      if (suppressBlockActivationRef.current || hasTextSelection()) {
        suppressBlockActivationRef.current = false
        return
      }
      suppressBlockActivationRef.current = false
      setOpenBranchMenuParentId(null)
      setIsPathsPanelOpen(false)
      const nextActiveBlockId = activeBlockId === blockId ? null : blockId
      setActiveBlockId(nextActiveBlockId)
    },
    [activeBlockId, hasTextSelection],
  )

  const registerBlockRef = useCallback(
    (id: string, node: HTMLDivElement | null) => {
      const current = blockRefs.current
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

  const handleSidebarSelectCollection = useCallback(
    (collection: CollectionRecord) => {
      closeSettings()
      handleSelectCollection(collection)
    },
    [closeSettings, handleSelectCollection],
  )

  return (
    <div
      className={`app${isSettingsOpen ? ' settings-open' : ''}${
        isBranchesSurfaceVisible ? ' branches-open' : ''
      }${
        showSelectedActionsDock ? ' selected-actions-open' : ''
      }`}
      ref={appRef}
    >
      <div className={`layout${isSidebarVisible ? ' sidebar-open' : ''}`}>
        <div className="main-stack">
          <header className="header">
            <div className="header-left">
              <div className="header-meta">
                <div className="header-meta-row">
                  <div className="header-subtitle">
                    {headerSubtitle}
                  </div>
                  {hasPathForks && !isSettingsOpen ? (
                    <span
                      className={`tooltip tooltip-bottom tooltip-hover-only${suppressBranchesTooltip ? ' tooltip-suppressed' : ''}`}
                      data-tooltip="Branches"
                      onMouseLeave={() => setSuppressBranchesTooltip(false)}
                    >
                      <button
                        className={`header-paths-toggle header-paths-toggle-inline${
                          isPathsPanelOpen ? ' is-active' : ''
                        }`}
                        type="button"
                        onClick={() => {
                          handleTogglePathsPanel()
                          setSuppressBranchesTooltip(true)
                        }}
                        aria-label="Branches"
                        aria-expanded={isPathsPanelOpen}
                        aria-controls="header-paths-panel"
                        onBlur={() => setSuppressBranchesTooltip(false)}
                      >
                        <span
                          className="codicon codicon-layers"
                          aria-hidden="true"
                        />
                      </button>
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="header-actions">
                <span
                  className={`tooltip tooltip-bottom tooltip-hover-only${suppressNewCollectionTooltip ? ' tooltip-suppressed' : ''}`}
                  data-tooltip="New collection"
                  onMouseLeave={() => setSuppressNewCollectionTooltip(false)}
                >
                  <button
                    className="new-chat-toggle"
                    type="button"
                    onClick={() => {
                      handleStartNewCollection()
                    }}
                    aria-label="New collection"
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
          {!isSettingsOpen && isPathsPanelOpen && selectedPathsForkEntry ? (
            <section
              className={`paths-hud${isPathsPanelClosing ? ' is-closing' : ''}`}
              id="header-paths-panel"
              role="region"
              aria-label="Branches panel"
            >
              <div className="paths-hud-panel composer-paths-panel">
                <div className="paths-hud-forks">
                  <div
                    className={`composer-paths-fork-row-wrap${
                      pathsForkCanScrollLeft ? ' can-scroll-left' : ''
                    }${pathsForkCanScrollRight ? ' can-scroll-right' : ''}`}
                  >
                    <div
                      className="composer-paths-fork-row"
                      ref={pathsForkRowRef}
                      onScroll={handleForkRowScroll}
                    >
                      {pathForkEntries.map((entry) => (
                        <button
                          key={entry.parentId}
                          className={`composer-paths-fork${
                            entry.parentId === effectivePathsForkParentId
                              ? ' is-active'
                              : ''
                          }${
                            entry.activeIndex >= 0 ? '' : ' is-off-path'
                          }`}
                          type="button"
                          onClick={() => handleSelectPathsFork(entry.parentId)}
                        >
                          <span className="composer-paths-fork-label">
                            {entry.shortLabel}
                          </span>
                          <span
                            className={`composer-paths-fork-value${
                              entry.activeIndex >= 0 ? '' : ' is-off-path'
                            }`}
                          >
                            {entry.activeIndex >= 0
                              ? `${entry.activeIndex + 1}/${entry.options.length}`
                              : `-/${entry.options.length}`}
                          </span>
                        </button>
                      ))}
                    </div>
                    {pathsForkCanScrollLeft ? (
                      <button
                        className="composer-paths-fork-scroll composer-paths-fork-scroll-left"
                        type="button"
                        onClick={() => handleForkRowScrollBy('left')}
                        aria-label="Scroll fork points left"
                      >
                        <span
                          className="codicon codicon-chevron-left"
                          aria-hidden="true"
                        />
                      </button>
                    ) : null}
                    {pathsForkCanScrollRight ? (
                      <button
                        className="composer-paths-fork-scroll composer-paths-fork-scroll-right"
                        type="button"
                        onClick={() => handleForkRowScrollBy('right')}
                        aria-label="Scroll fork points right"
                      >
                        <span
                          className="codicon codicon-chevron-right"
                          aria-hidden="true"
                        />
                      </button>
                    ) : null}
                  </div>
                  <div className="composer-paths-fork-preview-row">
                    <div className="composer-paths-fork-preview">
                      {previewPathsForkText}
                    </div>
                    <button
                      className="header-meta-action composer-paths-latest"
                      type="button"
                      onClick={handleBackToLatestPath}
                      disabled={
                        !latestLeafBlockId ||
                        effectivePathLeafId === latestLeafBlockId
                      }
                    >
                      Latest
                    </button>
                  </div>
                </div>
                <div className="composer-paths-list" role="menu">
                  {selectedPathsForkOptions.map((option, index) => {
                    const isCurrentBranch =
                      option.id === selectedPathsForkEntry.activeChildId
                    return (
                      <button
                        key={option.id}
                        className={`composer-paths-list-item${
                          isCurrentBranch ? ' is-active' : ''
                        }`}
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          handleSelectPathsBranch(
                            selectedPathsForkEntry.parentId,
                            option.id,
                          )
                        }
                      >
                        <span className="composer-paths-list-main">
                          <span className="composer-paths-list-label-row">
                            <span className="composer-paths-list-label">{`Branch ${index + 1}`}</span>
                            {isCurrentBranch ? (
                              <span className="composer-paths-list-current">
                                Current
                              </span>
                            ) : null}
                          </span>
                          <span className="composer-paths-list-summary">
                            {option.summary ?? 'No preview text'}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </section>
          ) : null}
          <div className="main-pane">
            <div
              className="main-column"
              ref={mainColumnRef}
              onScroll={handleMainScroll}
            >
              <ChatPane
                blocks={visibleBlocks}
                activeBlockId={activeBlockId}
                branchOptionsByParentId={branchOptionsByParentId}
                focusedForkParentId={
                  isPathsPanelOpen ? effectivePathsForkParentId : null
                }
                continuationCursorBlockId={effectiveContinuationBlock?.id ?? null}
                isSending={isSending}
                showEmptyState={hasLoadedBlocks}
                showConfigureLink={showConfigureLink}
                onConfigure={() => openSettingsRef.current()}
                endRef={endRef}
                onChatClick={handleChatClick}
                onBlockMouseDown={handleBlockMouseDown}
                onBlockClick={handleBlockClick}
                onSetContinuationCursor={handleSetContinuationCursor}
                onOpenPathsFork={handleOpenPathsFork}
                onRetryBlock={handleRetryContinuation}
                onCopyBlock={handleCopyBlockFromStream}
                registerBlockRef={registerBlockRef}
              />
            </div>
            {isSettingsOpen ? (
              <div
                className={`settings-overlay${isSettingsClosing ? ' is-closing' : ''}`}
              >
                <section className="settings settings-pane" id="settings-panel">
                  <div className="settings-inner">
                  <div className="settings-heading">Connection</div>
                  <div className="settings-grid">
                    <label className="settings-field">
                      <span>Base URL</span>
                      <input
                        className="settings-input"
                        type="url"
                        placeholder="Example: https://api.openai.com/v1"
                        value={baseUrl}
                        spellCheck={false}
                        onChange={(event) =>
                          setBaseUrl(event.target.value.trim())
                        }
                      />
                      <span className="settings-hint">
                        Enter your provider base URL (e.g.
                        https://api.openai.com/v1).
                      </span>
                    </label>
                    <label className="settings-field">
                      <span>Model ID</span>
                      <input
                        className="settings-input"
                        type="text"
                        placeholder="Example: gpt-5.2"
                        value={model}
                        spellCheck={false}
                        onChange={(event) =>
                          setModel(event.target.value.trim())
                        }
                      />
                      <span className="settings-hint">
                        Placeholder text is only an example. Enter your provider
                        model ID if required.
                      </span>
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
                  <div className="settings-heading">Data</div>
                  <div className="settings-actions">
                    <button
                      className={`settings-action-button${isExporting ? ' is-loading' : ''}`}
                      type="button"
                      onClick={handleExportData}
                      disabled={
                        isPickingExport || isExporting
                      }
                    >
                      Export data
                    </button>
                    <button
                      className={`settings-action-button${
                        isReadingImport || isImportingData ? ' is-loading' : ''
                      }`}
                      type="button"
                      onClick={handleImportData}
                      disabled={
                        isPickingImport || isImportLocked
                      }
                    >
                      Import data
                    </button>
                  </div>
                  {hasDataPanel ? (
                    <div className="settings-import-preview">
                      {importPreview ? (
                        <>
                          <div className="settings-import-header">
                            <div className="settings-import-title">
                              Import preview
                            </div>
                          </div>
                          {exportPreviewFile ? (
                            <div className="settings-import-meta">
                              File · {exportPreviewFile}
                            </div>
                          ) : null}
                          {exportPreviewTime ? (
                            <div className="settings-import-meta">
                              Exported · {exportPreviewTime}
                            </div>
                          ) : null}
                          {importPreviewSummary ? (
                            <div className="settings-import-metrics">
                              <div>
                                <span className="settings-import-label">
                                  Collections
                                </span>
                                <span className="settings-import-value">
                                  {importPreviewSummary.collections.toLocaleString()}
                                </span>
                              </div>
                              <div>
                                <span className="settings-import-label">
                                  Blocks
                                </span>
                                <span className="settings-import-value">
                                  {importPreviewSummary.blocks.toLocaleString()}
                                </span>
                              </div>
                              <div>
                                <span className="settings-import-label">
                                  Records
                                </span>
                                <span className="settings-import-value">
                                  {importPreviewSummary.records.toLocaleString()}
                                </span>
                              </div>
                              <div>
                                <span className="settings-import-label">
                                  Relations
                                </span>
                                <span className="settings-import-value">
                                  {importPreviewSummary.relations.toLocaleString()}
                                </span>
                              </div>
                            </div>
                          ) : null}
                          <div className="settings-import-note">
                            Import merges into your existing data. Existing IDs
                            are preserved.
                          </div>
                          <div className="settings-actions">
                            <button
                              className="settings-action-button"
                              type="button"
                              onClick={handleConfirmImport}
                              disabled={isImportingData}
                            >
                              {isImportingData ? 'Importing…' : 'Import now'}
                            </button>
                            <button
                              className="settings-action-button settings-action-secondary"
                              type="button"
                              onClick={handleCancelImport}
                              disabled={isImportingData}
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : importSummary ? (
                        <>
                          <div className="settings-import-header">
                            <div className="settings-import-title">
                              Import summary
                            </div>
                            <button
                              className="settings-button settings-import-dismiss"
                              type="button"
                              onClick={handleDismissImportSummary}
                              aria-label="Dismiss import summary"
                            >
                              <span
                                className="codicon codicon-close"
                                aria-hidden="true"
                              />
                            </button>
                          </div>
                          <div className="settings-import-note">
                            {importSummary}
                          </div>
                        </>
                      ) : exportSummary ? (
                        <>
                          <div className="settings-import-header">
                            <div className="settings-import-title">
                              Export complete
                            </div>
                            <button
                              className="settings-button settings-import-dismiss"
                              type="button"
                              onClick={handleDismissExportSummary}
                              aria-label="Dismiss export summary"
                            >
                              <span
                                className="codicon codicon-close"
                                aria-hidden="true"
                              />
                            </button>
                          </div>
                          <div className="settings-import-note">
                            Exported data to{' '}
                            <button
                              className="settings-inline-link"
                              type="button"
                              onClick={handleRevealExport}
                            >
                              {exportSummary.fileName}
                            </button>
                            .
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <div className="settings-note">
                      Exports include collections, blocks, and relationships.
                      API keys and local settings are not included.
                    </div>
                  )}
                    {dataError ? (
                      <div className="settings-error">{dataError}</div>
                    ) : null}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
          {isSettingsOpen ? null : (
            <>
              {showSelectedActionsDock ? (
                <div className="selected-actions-overlay">
                  <div
                    className="selected-actions-dock"
                    ref={selectedActionsDockRef}
                    role="region"
                    aria-label="Selected message actions"
                  >
                    <div className="selected-actions-summary">
                      <span className="selected-actions-head">
                        <span className="selected-actions-label">
                          {activeBlock ? 'Selected' : 'Branch path'}
                        </span>
                        {isOffLatestPath ? (
                          <span className="selected-actions-state">
                            Off latest path
                          </span>
                        ) : null}
                      </span>
                      <span className="selected-actions-preview">
                        {selectedBlockPreview}
                      </span>
                    </div>
                    <div className="selected-actions-buttons">
                      {isOffLatestPath ? (
                        <button
                          className="selected-actions-text-button"
                          type="button"
                          onClick={handleBackToLatestPath}
                        >
                          Latest path
                        </button>
                      ) : null}
                      {activeBlock ? (
                        <>
                          {canBranchFromActiveBlock ? (
                            <span
                              className="tooltip tooltip-hover-only"
                              data-tooltip={
                                effectiveContinuationBlock?.id === activeBlock.id
                                  ? 'Current branch source'
                                  : 'Branch from here'
                              }
                            >
                              <button
                                className={`sidebar-icon-button${
                                  effectiveContinuationBlock?.id === activeBlock.id
                                    ? ' sidebar-icon-button-ack'
                                    : ''
                                }`}
                                type="button"
                                onClick={handleSetContinuationFromActiveBlock}
                                aria-label="Branch from here"
                              >
                                <span
                                  className={`codicon ${
                                    effectiveContinuationBlock?.id === activeBlock.id
                                      ? 'codicon-check'
                                      : 'codicon-git-branch'
                                  }`}
                                  aria-hidden="true"
                                />
                              </button>
                            </span>
                          ) : null}
                          {canGenerateNewFromActiveBlock && !isSending ? (
                            <span
                              className="tooltip tooltip-hover-only"
                              data-tooltip="Generate new"
                            >
                              <button
                                className="sidebar-icon-button"
                                type="button"
                                onClick={() =>
                                  void handleRetryContinuation(activeBlock.id)
                                }
                                aria-label="Generate new"
                              >
                                <span
                                  className="codicon codicon-refresh"
                                  aria-hidden="true"
                                />
                              </button>
                            </span>
                          ) : null}
                          <span
                            className={`tooltip tooltip-hover-only${
                              suppressCopyBlockTooltip ? ' tooltip-suppressed' : ''
                            }`}
                            data-tooltip={
                              copyAckId === activeBlock.id ? 'Copied' : 'Copy block'
                            }
                            onMouseLeave={() => setSuppressCopyBlockTooltip(false)}
                          >
                            <button
                              className={`sidebar-icon-button${
                                copyAckId === activeBlock.id
                                  ? ' sidebar-icon-button-ack'
                                  : ''
                              }`}
                              type="button"
                              onClick={handleCopyActiveBlock}
                              aria-label="Copy block"
                            >
                              <span
                                className={`codicon ${
                                  copyAckId === activeBlock.id
                                    ? 'codicon-check'
                                    : 'codicon-copy'
                                }`}
                                aria-hidden="true"
                              />
                            </button>
                          </span>
                          <span
                            className="tooltip tooltip-hover-only"
                            data-tooltip="Clear selection"
                          >
                            <button
                              className="sidebar-icon-button selected-actions-close-button"
                              type="button"
                              onClick={() => setActiveBlockId(null)}
                              aria-label="Clear selection"
                            >
                              <span className="codicon codicon-close" aria-hidden="true" />
                            </button>
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
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
                        event.preventDefault()
                        handleInsertNewline()
                        return
                      }

                      event.preventDefault()
                      if (isSending) {
                        return
                      }

                      void sendMessage()
                    }}
                    rows={1}
                  />
                  <div className="composer-actions">
                    <div
                      className="context-rail-meta composer-context-meta"
                      aria-label="Context controls"
                    >
                      <span className="context-rail-title">Context</span>
                      <span className="context-rail-value">
                        {contextTokens
                          ? `${contextTokens.toLocaleString()} tokens`
                          : '—'}
                      </span>
                      {isSending ? (
                        <span
                          className="context-rail-progress"
                          role="status"
                          aria-label="Generating continuation"
                        />
                      ) : showLastRun ? (
                        <span className="context-rail-run">{lastRunBullet}</span>
                      ) : null}
                    </div>
                    <div className="composer-actions-right">
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
                                  : (currentIndex + 1) %
                                    TEMPERATURE_PRESETS.length
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
                        <span
                          className="tooltip tooltip-hover-only"
                          data-tooltip="Stop continuation"
                        >
                          <button
                            className="send-button"
                            type="button"
                            onClick={stopRequest}
                            aria-label="Stop continuation"
                          >
                            <span
                              className="codicon codicon-debug-stop"
                              aria-hidden="true"
                            />
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
                            <span
                              className="codicon codicon-arrow-up"
                              aria-hidden="true"
                            />
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </footer>
            </>
          )}
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
                  <span
                    className="codicon codicon-inspect"
                    aria-hidden="true"
                  />
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
                          onClick={() => handleSidebarSelectCollection(collection)}
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
                          onClick={() => handleSidebarSelectCollection(collection)}
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
            ) : activeBlock && inspectorStats ? (
              <>
                <div className="sidebar-quick-facts">
                  {quickFacts.map((fact) => (
                    <div className="sidebar-quick-fact" key={fact.key}>
                      {fact.content}
                    </div>
                  ))}
                  <div className="sidebar-quick-fact sidebar-quick-fact-action">
                    {canBranchFromActiveBlock ? (
                      <span
                        className="tooltip tooltip-hover-only tooltip-left"
                        data-tooltip={
                          effectiveContinuationBlock?.id === activeBlock.id
                            ? 'Current branch source'
                            : 'Branch from here'
                        }
                      >
                        <button
                          className={`sidebar-icon-button${
                            effectiveContinuationBlock?.id === activeBlock.id
                              ? ' sidebar-icon-button-ack'
                              : ''
                          }`}
                          type="button"
                          onClick={handleSetContinuationFromActiveBlock}
                          aria-label="Branch from here"
                        >
                          <span
                            className={`codicon ${
                              effectiveContinuationBlock?.id === activeBlock.id
                                ? 'codicon-check'
                                : 'codicon-git-branch'
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </span>
                    ) : null}
                    {canGenerateNewFromActiveBlock && !isSending ? (
                      <span
                        className="tooltip tooltip-hover-only tooltip-left"
                        data-tooltip="Generate new"
                      >
                        <button
                          className="sidebar-icon-button"
                          type="button"
                          onClick={() => void handleRetryContinuation(activeBlock.id)}
                          aria-label="Generate new"
                        >
                          <span
                            className="codicon codicon-refresh"
                            aria-hidden="true"
                          />
                        </button>
                      </span>
                    ) : null}
                    <span
                      className={`tooltip tooltip-hover-only tooltip-left${suppressCopyBlockTooltip ? ' tooltip-suppressed' : ''}`}
                      data-tooltip={
                        copyAckId === activeBlock?.id ? 'Copied' : 'Copy block'
                      }
                      onMouseLeave={() => setSuppressCopyBlockTooltip(false)}
                    >
                      <button
                        className={`sidebar-icon-button${copyAckId === activeBlock?.id ? ' sidebar-icon-button-ack' : ''}`}
                        type="button"
                        onClick={handleCopyActiveBlock}
                        aria-label="Copy block"
                      >
                        <span
                          className={`codicon ${
                            copyAckId === activeBlock?.id
                              ? 'codicon-check'
                              : 'codicon-copy'
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                    </span>
                  </div>
                </div>
                <div className="sidebar-section">
                  <div className="sidebar-group">
                    <div className="sidebar-group-header">
                      <div className="section-title">Block</div>
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
                      {activeBranchChildCount > 1 ? (
                        <div className="sidebar-field">
                          <div className="sidebar-field-label">Branches</div>
                          <div className="sidebar-field-value">
                            {activeBranchChildCount}
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
                  {isAssistantBlock ? (
                    <>
                      <div className="sidebar-group">
                        <div className="sidebar-group-header">
                          <div className="section-title">Request</div>
                        </div>
                        <div className="sidebar-group-body">
                          {requestLocation ? (
                            <div className="sidebar-field">
                              <div className="sidebar-field-label">
                                {requestLocation.label}
                              </div>
                              <div className="sidebar-field-value">
                                {requestLocation.value}
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
                    {collectionBlockCountLabel}
                  </div>
                  {activeCollection ? (
                    <div className="sidebar-quick-fact sidebar-quick-fact-action">
                      <span
                        className={`tooltip tooltip-hover-only tooltip-left${suppressCopyCollectionTooltip ? ' tooltip-suppressed' : ''}`}
                        data-tooltip={
                          copyCollectionAck ? 'Copied' : 'Copy collection'
                        }
                        onMouseLeave={() =>
                          setSuppressCopyCollectionTooltip(false)
                        }
                      >
                        <button
                          className={`sidebar-icon-button${copyCollectionAck ? ' sidebar-icon-button-ack' : ''}`}
                          type="button"
                          onClick={handleCopyCollection}
                          aria-label="Copy collection"
                        >
                          <span
                            className={`codicon ${
                              copyCollectionAck
                                ? 'codicon-check'
                                : 'codicon-copy'
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      </span>
                      {canDeleteCollection ? (
                        <span
                          className={`tooltip tooltip-hover-only tooltip-left${suppressDeleteCollectionTooltip ? ' tooltip-suppressed' : ''}`}
                          data-tooltip="Delete collection"
                          onMouseLeave={() =>
                            setSuppressDeleteCollectionTooltip(false)
                          }
                        >
                          <button
                            className="sidebar-icon-button"
                            type="button"
                            onClick={handleDeleteCollection}
                            aria-label="Delete collection"
                          >
                            <span
                              className="codicon codicon-trash"
                              aria-hidden="true"
                            />
                          </button>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="sidebar-empty">
                Select an item to inspect.
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

export default App

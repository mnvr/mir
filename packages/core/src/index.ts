export type BlockId = string

export type Block = {
  id: BlockId
  markdown: string
}

export type Branch = {
  id: string
  label: string
  createdAt: number
  blocks: Block[]
  parentId?: string
  forkedFromBlockId?: BlockId
}

export function forkBranchWithEdit(
  branch: Branch,
  blockId: BlockId,
  nextMarkdown: string,
  options: {
    id: string
    label: string
    createdAt: number
  },
): Branch {
  const blocks = branch.blocks.map((block) =>
    block.id === blockId ? { ...block, markdown: nextMarkdown } : block,
  )

  return {
    ...branch,
    ...options,
    blocks,
    parentId: branch.id,
    forkedFromBlockId: blockId,
  }
}

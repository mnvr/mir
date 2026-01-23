export type BlockId = string

export type Block = {
  id: BlockId
  markdown: string
}

export type Document = {
  id: string
  blocks: Block[]
}

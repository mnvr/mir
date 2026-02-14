import type { MirRecord, Relation } from './storage'

export type MirExport = {
  version: 1
  exportedAt: string
  records: MirRecord[]
  relations: Relation[]
}

export type MirImportSummary = {
  records: {
    incoming: number
    imported: number
    skipped: number
    conflicts: number
    duplicates: number
  }
  relations: {
    incoming: number
    imported: number
    skipped: number
    conflicts: number
    duplicates: number
    missingEndpoints: number
  }
  branching: {
    forkPointsBefore: number
    forkPointsAfter: number
    forkPointsAdded: number
  }
}

export const parseExportPayload = (raw: string): MirExport => {
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid export file.')
  }
  const { version, exportedAt, records, relations } = parsed as {
    version?: unknown
    exportedAt?: unknown
    records?: unknown
    relations?: unknown
  }
  if (version !== 1) {
    throw new Error('Unsupported export version.')
  }
  if (!Array.isArray(records) || !Array.isArray(relations)) {
    throw new Error('Invalid export contents.')
  }
  return {
    version: 1,
    exportedAt: typeof exportedAt === 'string' ? exportedAt : '',
    records: records as MirExport['records'],
    relations: relations as MirExport['relations'],
  }
}

export const summarizeExportPayload = (payload: MirExport) => {
  let collectionsCount = 0
  let blocksCount = 0
  payload.records.forEach((record) => {
    if (record && typeof record === 'object' && 'type' in record) {
      const typeValue = (record as { type?: string }).type
      if (typeValue === 'collection') {
        collectionsCount += 1
      } else if (typeValue === 'block') {
        blocksCount += 1
      }
    }
  })
  return {
    collections: collectionsCount,
    blocks: blocksCount,
    records: payload.records.length,
    relations: payload.relations.length,
  }
}

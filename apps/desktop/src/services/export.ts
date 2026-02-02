import type {
  CollectionRecord,
  MirExport,
  MirImportSummary,
  MirRecord,
  Relation,
} from 'mir-core'
import { parseExportPayload, summarizeExportPayload } from 'mir-core'
import {
  indexCollectionsAndRelations,
  listAllRecords,
  listAllRelations,
  writeRecordsAndRelations,
} from './db'
import { getFileBasename } from '../utils/file'

export type ImportPreview = {
  payload: MirExport
  filePath: string
  summary: ReturnType<typeof summarizeExportPayload>
}

type ImportSummary = {
  summary: Awaited<ReturnType<typeof importMirData>>
}

type ExportResult =
  | { status: 'canceled' }
  | { status: 'saved'; filePath: string; fileName: string }

type ImportPreviewResult =
  | { status: 'canceled' }
  | { status: 'loaded'; preview: ImportPreview }

const ensureFileDialogSupport = () => {
  if (typeof window === 'undefined' || !window.ipcRenderer?.invoke) {
    throw new Error('File dialogs are not available in this environment.')
  }
}

const isCollectionRecord = (
  record: MirRecord | undefined | null,
): record is CollectionRecord => {
  if (!record) {
    return false
  }
  return record.type === 'collection' && !record.deletedAt
}

const buildExportPayload = async (): Promise<MirExport> => {
  const [records, relations] = await Promise.all([
    listAllRecords(),
    listAllRelations(),
  ])
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    records,
    relations,
  }
}

const importMirData = async (payload: MirExport): Promise<MirImportSummary> => {
  const [existingRecords, existingRelations] = await Promise.all([
    listAllRecords(),
    listAllRelations(),
  ])
  const existingRecordMap = new Map(
    existingRecords.map((record) => [record.id, record]),
  )
  const existingRelationMap = new Map(
    existingRelations.map((relation) => [relation.id, relation]),
  )
  const relationKeyFor = (relation: Relation) =>
    `${relation.type}::${relation.fromId}::${relation.toId}`
  const existingRelationKeys = new Set(
    existingRelations.map((relation) => relationKeyFor(relation)),
  )

  const seenRecordIds = new Set<string>()
  const seenRelationIds = new Set<string>()
  const newRecords: MirRecord[] = []
  const newCollections: CollectionRecord[] = []
  const recordConflicts: string[] = []
  let recordSkipped = 0
  let recordDuplicates = 0

  payload.records.forEach((record) => {
    if (!record || typeof record.id !== 'string') {
      return
    }
    if (seenRecordIds.has(record.id)) {
      recordDuplicates += 1
      return
    }
    seenRecordIds.add(record.id)
    const existing = existingRecordMap.get(record.id)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        recordConflicts.push(record.id)
      } else {
        recordSkipped += 1
      }
      return
    }
    newRecords.push(record)
    if (isCollectionRecord(record)) {
      newCollections.push(record)
    }
  })

  const availableRecordIds = new Set<string>([
    ...existingRecordMap.keys(),
    ...newRecords.map((record) => record.id),
  ])
  const deletedRecordIds = new Set<string>()
  existingRecords.forEach((record) => {
    if (record.deletedAt) {
      deletedRecordIds.add(record.id)
    }
  })
  newRecords.forEach((record) => {
    if (record.deletedAt) {
      deletedRecordIds.add(record.id)
    }
  })

  const newRelations: Relation[] = []
  const relationConflicts: string[] = []
  let relationSkipped = 0
  let relationDuplicates = 0
  let relationMissingEndpoints = 0

  payload.relations.forEach((relation) => {
    if (!relation || typeof relation.id !== 'string') {
      return
    }
    if (seenRelationIds.has(relation.id)) {
      relationDuplicates += 1
      return
    }
    seenRelationIds.add(relation.id)
    const relationKey = relationKeyFor(relation)
    if (existingRelationKeys.has(relationKey)) {
      relationDuplicates += 1
      return
    }
    if (
      !availableRecordIds.has(relation.fromId) ||
      !availableRecordIds.has(relation.toId)
    ) {
      relationMissingEndpoints += 1
      return
    }
    if (
      deletedRecordIds.has(relation.fromId) ||
      deletedRecordIds.has(relation.toId)
    ) {
      relationMissingEndpoints += 1
      return
    }
    const existing = existingRelationMap.get(relation.id)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(relation)) {
        relationConflicts.push(relation.id)
      } else {
        relationSkipped += 1
      }
      return
    }
    existingRelationKeys.add(relationKey)
    newRelations.push(relation)
  })

  await writeRecordsAndRelations(newRecords, newRelations)
  await indexCollectionsAndRelations(newCollections, newRelations)

  if (recordConflicts.length > 0) {
    console.warn('[import] record id conflicts', recordConflicts.slice(0, 20))
    if (recordConflicts.length > 20) {
      console.warn(
        `[import] ${recordConflicts.length - 20} more record conflicts`,
      )
    }
  }
  if (relationConflicts.length > 0) {
    console.warn(
      '[import] relation id conflicts',
      relationConflicts.slice(0, 20),
    )
    if (relationConflicts.length > 20) {
      console.warn(
        `[import] ${relationConflicts.length - 20} more relation conflicts`,
      )
    }
  }

  return {
    records: {
      incoming: payload.records.length,
      imported: newRecords.length,
      skipped: recordSkipped,
      conflicts: recordConflicts.length,
      duplicates: recordDuplicates,
    },
    relations: {
      incoming: payload.relations.length,
      imported: newRelations.length,
      skipped: relationSkipped,
      conflicts: relationConflicts.length,
      duplicates: relationDuplicates,
      missingEndpoints: relationMissingEndpoints,
    },
  }
}

export const exportData = async (
  onWriteStart?: () => void,
): Promise<ExportResult> => {
  ensureFileDialogSupport()
  const result = await window.ipcRenderer.invoke('data:export')
  if (!result || result.status === 'canceled') {
    return { status: 'canceled' }
  }
  if (result.status !== 'picked' || typeof result.path !== 'string') {
    throw new Error('Export failed.')
  }
  onWriteStart?.()
  const payload = await buildExportPayload()
  const saveResult = await window.ipcRenderer.invoke('data:export-save', {
    path: result.path,
    payload,
  })
  if (!saveResult || saveResult.status !== 'saved') {
    throw new Error('Export failed.')
  }
  return {
    status: 'saved',
    filePath: result.path,
    fileName: getFileBasename(result.path) ?? 'export',
  }
}

export const loadImportPreview = async (
  onReadStart?: () => void,
): Promise<ImportPreviewResult> => {
  ensureFileDialogSupport()
  const result = await window.ipcRenderer.invoke('data:import')
  if (!result || result.status === 'canceled') {
    return { status: 'canceled' }
  }
  if (result.status !== 'picked' || typeof result.path !== 'string') {
    throw new Error('Import failed.')
  }
  onReadStart?.()
  const readResult = await window.ipcRenderer.invoke(
    'data:import-read',
    result.path,
  )
  if (!readResult || readResult.status !== 'loaded') {
    throw new Error('Import failed.')
  }
  if (typeof readResult.contents !== 'string') {
    throw new Error('Import failed.')
  }
  const payload = parseExportPayload(readResult.contents)
  return {
    status: 'loaded',
    preview: {
      payload,
      filePath: readResult.path ?? result.path,
      summary: summarizeExportPayload(payload),
    },
  }
}

export const applyImport = async (
  payload: MirExport,
): Promise<ImportSummary> => {
  const summary = await importMirData(payload)
  return { summary }
}

export const revealExportedFile = async (filePath: string) => {
  ensureFileDialogSupport()
  await window.ipcRenderer.invoke('file:reveal', filePath)
}

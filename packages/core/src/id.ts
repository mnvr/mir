import { customAlphabet } from 'nanoid'

export const ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
export const ID_LENGTH = 21

const generateId = customAlphabet(ID_ALPHABET, ID_LENGTH)

export const createId = (prefix: string) => `${prefix}_${generateId()}`
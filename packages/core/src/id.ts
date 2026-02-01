import { customAlphabet } from 'nanoid'
import { sha256 } from '@noble/hashes/sha2'

const ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
const ID_LENGTH = 21

const generateId = customAlphabet(ID_ALPHABET, ID_LENGTH)

export const createId = (prefix: string) => `${prefix}_${generateId()}`

export const createDerivedId = (prefix: string, input: string) => {
  const digest = sha256(`${prefix}:${input}`)
  let suffix = ''
  for (let index = 0; index < ID_LENGTH; index += 1) {
    suffix += ID_ALPHABET[digest[index % digest.length] % ID_ALPHABET.length]
  }
  return `${prefix}_${suffix}`
}

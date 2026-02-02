export const getFileBasename = (filePath: string) => {
  const segments = filePath.split(/[/\\]/)
  return segments[segments.length - 1] ?? filePath
}

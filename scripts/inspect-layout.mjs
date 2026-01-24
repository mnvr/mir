import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const url = process.env.INSPECT_URL ?? 'http://localhost:5701/'
const blockSelector =
  process.env.INSPECT_BLOCK_SELECTOR ?? '.blocks .block:nth-child(2)'
const outputDir = path.resolve('artifacts')

fs.mkdirSync(outputDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

try {
  page.on('console', (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`)
  })

  await page.goto(url, { waitUntil: 'networkidle' })

  const block = page.locator(blockSelector)
  await block.waitFor({ state: 'visible', timeout: 10000 })

  const before = await block.boundingBox()
  await block.click()

  const editor = page.locator('.block.editing textarea')
  await editor.waitFor({ state: 'visible', timeout: 5000 })

  const editorBox = await editor.boundingBox()
  const after = await block.boundingBox()
  const styles = await block.evaluate((node) => {
    const style = window.getComputedStyle(node)
    return {
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
    }
  })

  const payload = {
    url,
    blockSelector,
    before,
    after,
    editorBox,
    styles,
  }

  console.log(JSON.stringify(payload, null, 2))

  await page.screenshot({
    path: path.join(outputDir, 'layout.png'),
    fullPage: true,
  })
} finally {
  await browser.close()
}

import {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  type MenuItemConstructorOptions,
} from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

app.setName('Mir')

let win: BrowserWindow | null

const isMac = process.platform === 'darwin'

function setAppMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help' },
  ]

  const menu = Menu.buildFromTemplate(template)
  const windowMenuItem = menu.items.find(
    (item) => item.role === 'windowMenu' || item.label === 'Window',
  )
  const windowSubmenu = windowMenuItem?.submenu

  if (windowSubmenu) {
    const targetIndex = windowSubmenu.items.findIndex(
      (item) => item.role === 'front',
    )
    const insertIndex =
      targetIndex === -1 ? windowSubmenu.items.length : targetIndex
    const alwaysOnTopItem = new MenuItem({
      label: 'Always on Top',
      type: 'checkbox',
      checked: win?.isAlwaysOnTop() ?? false,
      click: (menuItem) => {
        win?.setAlwaysOnTop(menuItem.checked)
      },
    })

    windowSubmenu.insert(insertIndex, new MenuItem({ type: 'separator' }))
    windowSubmenu.insert(insertIndex, alwaysOnTopItem)
    windowSubmenu.insert(insertIndex, new MenuItem({ type: 'separator' }))
  }

  Menu.setApplicationMenu(menu)
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  setAppMenu()

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)

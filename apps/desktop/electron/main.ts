import {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  ipcMain,
  safeStorage,
  nativeImage,
  nativeTheme,
  type MenuItemConstructorOptions,
} from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

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
let isSidebarOpen = false
const windowIconPath = path.join(process.env.VITE_PUBLIC ?? process.env.APP_ROOT, 'icon.png')
const devDockIconPath = path.join(process.env.APP_ROOT, 'assets', 'icon-dev.png')


const isMac = process.platform === 'darwin'

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (!win) {
    return
  }
  if (win.isMinimized()) {
    win.restore()
  }
  win.show()
  win.focus()
})

const sendToWindow = (channel: string, ...args: unknown[]) => {
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send(channel, ...args)
}

function registerSecretHandlers() {
  ipcMain.handle('secrets:is-available', () =>
    safeStorage.isEncryptionAvailable(),
  )

  ipcMain.handle('secrets:encrypt', (_event, plainText) => {
    if (typeof plainText !== 'string') {
      throw new Error('Invalid secret payload.')
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available.')
    }

    const encrypted = safeStorage.encryptString(plainText)
    return encrypted.toString('base64')
  })

  ipcMain.handle('secrets:decrypt', (_event, cipherText) => {
    if (typeof cipherText !== 'string') {
      throw new Error('Invalid secret payload.')
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available.')
    }

    const buffer = Buffer.from(cipherText, 'base64')
    return safeStorage.decryptString(buffer)
  })
}

function updateSidebarMenuState(nextState: boolean) {
  isSidebarOpen = nextState
  const menu = Menu.getApplicationMenu()
  const sidebarItem = menu?.getMenuItemById('sidebar-toggle')
  if (sidebarItem) {
    sidebarItem.checked = isSidebarOpen
  }
}

function registerSidebarHandlers() {
  ipcMain.on('sidebar:state', (_event, isOpen) => {
    updateSidebarMenuState(Boolean(isOpen))
  })
}

function setAppMenu() {
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? 'Preferences...' : 'Settings...',
    accelerator: 'CmdOrCtrl+,',
    click: () => {
      sendToWindow('open-settings')
    },
  }
  const newCollectionItem: MenuItemConstructorOptions = {
    label: 'New Collection',
    accelerator: 'CmdOrCtrl+N',
    click: () => {
      sendToWindow('collection:new')
    },
  }
  const sidebarItem: MenuItemConstructorOptions = {
    id: 'sidebar-toggle',
    label: 'Toggle Side Bar',
    type: 'checkbox',
    checked: isSidebarOpen,
    accelerator: 'CmdOrCtrl+B',
    click: () => {
      sendToWindow('sidebar:toggle')
    },
  }
  const interactionsItem: MenuItemConstructorOptions = {
    label: 'Toggle Collections',
    accelerator: 'CmdOrCtrl+E',
    click: () => {
      sendToWindow('sidebar:tab', 'chats')
    },
  }
  const inspectItem: MenuItemConstructorOptions = {
    label: 'Toggle Inspect',
    accelerator: 'CmdOrCtrl+I',
    click: () => {
      sendToWindow('sidebar:tab', 'inspect')
    },
  }
  const selectionPrevItem: MenuItemConstructorOptions = {
    label: 'Select Previous Block',
    accelerator: 'Up',
    registerAccelerator: false,
    click: () => {
      sendToWindow('selection:prev')
    },
  }
  const selectionNextItem: MenuItemConstructorOptions = {
    label: 'Select Next Block',
    accelerator: 'Down',
    registerAccelerator: false,
    click: () => {
      sendToWindow('selection:next')
    },
  }
  const scrollTopItem: MenuItemConstructorOptions = {
    label: 'Scroll to Top',
    accelerator: 'CmdOrCtrl+Up',
    registerAccelerator: false,
    click: () => {
      sendToWindow('scroll:top')
    },
  }
  const scrollEndItem: MenuItemConstructorOptions = {
    label: 'Scroll to End',
    accelerator: 'CmdOrCtrl+Down',
    registerAccelerator: false,
    click: () => {
      sendToWindow('scroll:end')
    },
  }
  const focusComposerItem: MenuItemConstructorOptions = {
    label: 'Focus Composer',
    accelerator: 'CmdOrCtrl+L',
    registerAccelerator: false,
    click: () => {
      sendToWindow('composer:focus')
    },
  }
  const generateContinuationItem: MenuItemConstructorOptions = {
    label: 'Generate Continuation',
    accelerator: 'Enter',
    registerAccelerator: false,
    click: () => {
      sendToWindow('composer:submit')
    },
  }
  const generateContinuationNewlineItem: MenuItemConstructorOptions = {
    label: 'Generate Continuation (Multiline)',
    accelerator: 'CmdOrCtrl+Enter',
    registerAccelerator: false,
    click: () => {
      sendToWindow('composer:submit-multiline')
    },
  }
  const addNewlineItem: MenuItemConstructorOptions = {
    label: 'Add Newline',
    accelerator: 'Shift+Enter',
    registerAccelerator: false,
    click: () => {
      sendToWindow('composer:insert-newline')
    },
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
        {
          label: app.getName(),
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            settingsItem,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        } as MenuItemConstructorOptions,
      ]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Selection',
      submenu: [
        selectionPrevItem,
        selectionNextItem,
        { type: 'separator' },
        focusComposerItem,
      ],
    },
    {
      label: 'Generate',
      submenu: [
        generateContinuationItem,
        generateContinuationNewlineItem,
        { type: 'separator' },
        addNewlineItem,
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help' },
  ]

  const menu = Menu.buildFromTemplate(template)

  const fileMenuItem = menu.items.find(
    (item) => item.role === 'fileMenu' || item.label === 'File',
  )
  const fileSubmenu = fileMenuItem?.submenu

  if (fileSubmenu) {
    fileSubmenu.insert(0, new MenuItem(newCollectionItem))
    fileSubmenu.insert(1, new MenuItem({ type: 'separator' }))
    if (!isMac) {
      fileSubmenu.insert(2, new MenuItem(settingsItem))
      fileSubmenu.insert(3, new MenuItem({ type: 'separator' }))
    }
  }

  const viewMenuItem = menu.items.find(
    (item) => item.role === 'viewMenu' || item.label === 'View',
  )
  const viewSubmenu = viewMenuItem?.submenu

  if (viewSubmenu) {
    viewSubmenu.insert(0, new MenuItem(sidebarItem))
    viewSubmenu.insert(1, new MenuItem({ type: 'separator' }))
    viewSubmenu.insert(2, new MenuItem(interactionsItem))
    viewSubmenu.insert(3, new MenuItem(inspectItem))
    viewSubmenu.insert(4, new MenuItem({ type: 'separator' }))
    viewSubmenu.insert(5, new MenuItem(scrollTopItem))
    viewSubmenu.insert(6, new MenuItem(scrollEndItem))
    viewSubmenu.insert(7, new MenuItem({ type: 'separator' }))
  }

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
  const windowBackground = nativeTheme.shouldUseDarkColors
    ? '#1a1a1e'
    : '#ffffff'
  win = new BrowserWindow({
    ...(isMac ? {} : { icon: windowIconPath }),
    backgroundColor: windowBackground,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  win.on('closed', () => {
    win = null
  })

  win.once('ready-to-show', () => {
    win?.show()
  })

  if (isMac && app.dock && !app.isPackaged && fs.existsSync(devDockIconPath)) {
    const icon = nativeImage.createFromPath(devDockIconPath)
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon)
    }
  }

  setAppMenu()

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    sendToWindow('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    void win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    void win.loadFile(path.join(RENDERER_DIST, 'index.html'))
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

void app.whenReady().then(() => {
  registerSecretHandlers()
  registerSidebarHandlers()
  createWindow()
})

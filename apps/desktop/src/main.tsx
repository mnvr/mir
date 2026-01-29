import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

let mainProcessListener:
  | ((event: unknown, message: unknown) => void)
  | null = null

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Use contextBridge when running inside Electron.
if (window.ipcRenderer) {
  if (mainProcessListener) {
    window.ipcRenderer.off('main-process-message', mainProcessListener)
  }

  mainProcessListener = (_event, message) => {
    console.log(message)
  }

  window.ipcRenderer.on('main-process-message', mainProcessListener)

  window.addEventListener('beforeunload', () => {
    if (mainProcessListener) {
      window.ipcRenderer?.off('main-process-message', mainProcessListener)
      mainProcessListener = null
    }
  })
}

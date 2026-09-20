import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './index.css'
// FIRST, FOR ITS SIDE EFFECT. It registers the `beforeinstallprompt` listener, and the browser
// fires that event around page load — before React has mounted anything that could listen. Its
// header has the detail. Imported here rather than left to the card that reads it, so the listener
// does not depend on which screen happens to be rendered first.
import './state/install'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

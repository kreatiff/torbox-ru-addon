import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Registered post-load so it never competes with the app's own initial
// fetches for bandwidth/priority. Scope defaults to the SW's own directory
// (/admin/), so it can never intercept the addon's Stremio routes outside
// /admin -- see public/sw.js's own comment for the caching strategy.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/admin/sw.js').catch((err: unknown) => {
      console.warn('Service worker registration failed', err)
    })
  })
}

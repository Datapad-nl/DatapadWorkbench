import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { watchChatWidth } from './chatWidth'
import './styles/globals.css'

watchChatWidth()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

import React from 'react'
import ReactDOM from 'react-dom/client'
import SaaSApp from './SaaSApp'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/manrope'
import './styles.css'
import './visual-system.css'
import './components/administration-theme.css'
import './components/calls-performance-theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><SaaSApp /></React.StrictMode>,
)

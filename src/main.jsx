import './debuglog.js';
import { initEnergy } from './energy.js';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initOta } from './ota.js';
import '@fontsource/anton/400.css';
import '@fontsource/yellowtail/400.css';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
initOta();
initEnergy();

// App in background / screen off: freeze every CSS animation (nobody sees them; zero visual cost).
document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('bg-idle', document.hidden));
import './lifecycle.js';

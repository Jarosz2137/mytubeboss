import './debuglog.js';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initOta } from './ota.js';
import '@fontsource/anton/400.css';
import '@fontsource/yellowtail/400.css';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
initOta();

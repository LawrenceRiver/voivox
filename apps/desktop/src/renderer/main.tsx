import { createRoot } from 'react-dom/client';

import { App, type DesktopClient } from './app.js';
import './styles.css';

const client = window.voivox as DesktopClient;

createRoot(document.getElementById('root')!).render(<App desktopClient={client} />);

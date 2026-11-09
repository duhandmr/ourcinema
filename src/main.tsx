import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root bulunamadı');

// Not: StrictMode bilinçli olarak kullanılmıyor; geliştirmede etkilerin iki kez
// çalışması aynı Realtime kanalına çift abonelik oluşturur.
createRoot(container).render(<App />);

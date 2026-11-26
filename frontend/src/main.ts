import './styles/fonts.css';
import { createApp } from 'vue';
import App from './App.vue';
import './styles/manor.css';
import './styles/dossier-theme.css';
import { loadStoredCustomFont } from './lib/typography';

createApp(App).mount('#root');
void loadStoredCustomFont();

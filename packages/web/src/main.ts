import './app.css';
import '@xterm/xterm/css/xterm.css';
import { mount } from 'svelte';
import App from './App.svelte';
// Instantiating the store applies the stored scheme and starts tracking the OS.
import './lib/theme.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('missing #app mount point');

export default mount(App, { target });

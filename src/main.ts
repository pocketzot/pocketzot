import './style.css'
import { initApp } from './app'
import { initUiScale } from './ui-scale'
import { initStatusBlur } from './status-blur'
import { maybeMountSafeAreaProbe } from './safe-area-probe'
import { registerServiceWorker } from './sw/register'
import { count } from './counter'
import { consumeStaleShellHeal } from './util/self-heal'

// First: "booted" for the stale-shell heal means this chunk ran, and the
// healed-load mark must exist before anything below can fail (self-heal.ts).
const healed = consumeStaleShellHeal()

const appEl = document.getElementById('app')
if (!appEl) throw new Error('#app element not found')

// Before the first view mounts, so nothing lays out at stock size first.
initUiScale()
initStatusBlur()
initApp(appEl)
maybeMountSafeAreaProbe()
registerServiceWorker()
count('boot') // boot rows self-attach the W/C environment letters (counter.ts)
if (healed) count('stale-heal')
// __dcssCardDemo() — character-card gallery from fixtures (views/card-demo.ts).
// Dynamic import inside the DEV branch: the chunk isn't emitted in prod.
if (import.meta.env.DEV) void import('./views/card-demo').then((m) => m.installCardDemo())

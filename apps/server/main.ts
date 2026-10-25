import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadCatalog } from './catalog.ts';
import { Workbench } from './workbench.ts';
import { buildApp } from './app.ts';

const port = Number(process.env.AW_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AW_PORT must be between 1024 and 65535');
const origin = `http://127.0.0.1:${port}`;
const data = resolve(process.env.AW_DATA_DIR ?? 'data');
await mkdir(join(data, 'artifacts'), { recursive: true });
const web = resolve('dist/web');
const workbench = await Workbench.open(join(data, 'workbench.sqlite'), await loadCatalog());
const { app, bootstrapToken } = await buildApp({ workbench, origin, artifactRoot: join(data, 'artifacts'),
  ...(existsSync(join(web, 'index.html')) ? { webRoot: web } : {}) });
try {
  await app.listen({ host: '127.0.0.1', port });
  workbench.kick();
  console.log(`AgentWindTunnel · local scripted workspace\nOpen once to sign in: ${origin}/#bootstrap=${bootstrapToken}`);
} catch (error) { await app.close(); throw error; }
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

import { resolve } from 'node:path';
import { Workbench } from '../apps/server/workbench.ts';
import { loadCatalog } from '../apps/server/catalog.ts';
import { seedPresets } from '../apps/server/presets.ts';
const service = await Workbench.open(resolve(process.env.AW_DATA_DIR ?? 'data', 'workbench.sqlite'), await loadCatalog());
try {
  seedPresets(service);
  console.log(JSON.stringify({ providers: service.providers('local-owner').map(p => ({ id: p.id, enabled: p.enabled, model: p.model })),
    agents: service.agents('local-owner').map(a => ({ id: a.id, tools: a.tools })) }, null, 2));
} finally { await service.close(); }

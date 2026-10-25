import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/app.ts';
import { Workbench } from '../../apps/server/workbench.ts';
import { loadCatalog } from '../../apps/server/catalog.ts';
import type { Scenario } from '../../packages/contracts/scenario.ts';

export async function openBrowserWorkspace(options: { catalog?: Scenario[]; width?: number; height?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aw-browser-'));
  let api: Awaited<ReturnType<typeof buildApp>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(join(directory, 'artifacts'));
    const workbench = await Workbench.open(join(directory, 'browser.sqlite'), options.catalog ?? await loadCatalog());
    api = await buildApp({ workbench, artifactRoot: join(directory, 'artifacts'), webRoot: resolve('dist/web') });
    const address = await api.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: options.height ?? 1000 } });
    const page = await context.newPage();
    return { api, address, page, context, directory,
      async signIn() {
        await page.goto(`${address}/#bootstrap=${api!.bootstrapToken}`);
        await page.getByRole('heading', { name: 'Refund workbench', exact: true }).waitFor();
      },
      async close() {
        await browser!.close();
        await api!.app.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser?.close();
    await api?.app.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

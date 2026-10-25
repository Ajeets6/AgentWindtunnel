import { readFileSync } from 'node:fs';
import type { Attack } from './contracts.ts';
export const attacks: Attack[] = JSON.parse(readFileSync(new URL('../../scenarios/security/injection.json', import.meta.url), 'utf8'));

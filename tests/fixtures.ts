import { fileURLToPath } from 'node:url';
import { openDocumentFile } from '../src/core/rhwp-node.ts';

export const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
export const openFixture = (name: string) => openDocumentFile(fixturePath(name));

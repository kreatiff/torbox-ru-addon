import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface FixtureFile {
  id: number;
  rawPath: string;
  size: number;
  isVideo: boolean;
}

export interface TorrentFixture {
  hash: string;
  torrentName: string;
  files: FixtureFile[];
  expectedSeason?: number;
  expectedXOfY?: { present: number; total: number };
  expectedEpisode?: number;
  expectedAbsoluteHint?: number;
  expectedAirDate?: string;
}

async function load(name: string): Promise<TorrentFixture> {
  const path = join(__dirname, 'torrents', `${name}.json`);
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as TorrentFixture;
}

export const sokrovishchaImperatora = () => load('sokrovishcha-imperatora');
export const stavkaNaLyubov = () => load('stavka-na-lyubov');
export const bolshoyKush = () => load('bolshoy-kush');

export async function loadAllFixtures(): Promise<Record<string, TorrentFixture>> {
  return {
    sokrovishchaImperatora: await sokrovishchaImperatora(),
    stavkaNaLyubov: await stavkaNaLyubov(),
    bolshoyKush: await bolshoyKush(),
  };
}

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.cwd());
const spaceUrl = process.env.HF_SPACE_URL;

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function sanitized(value: string): string {
  return spaceUrl ? value.replaceAll(spaceUrl, '[HF_SPACE_URL]') : value;
}

async function main(): Promise<void> {
  if (!spaceUrl) throw new Error('HF_SPACE_URL is required.');
  if (!/^https?:\/\//.test(spaceUrl)) throw new Error('HF_SPACE_URL must be an HTTPS or HTTP Git URL.');
  const status = run('git', ['status', '--porcelain'], root).trim();
  if (status) throw new Error('Refusing to deploy with a dirty working tree. Commit or stash local changes first.');

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'image-similarity-space-'));
  const archivePath = path.join(temporaryDirectory, 'repository.tar');
  try {
    run('git', ['archive', '--format=tar', '--output', archivePath, 'HEAD'], root);
    run('tar', ['-xf', archivePath, '-C', temporaryDirectory], root);
    const metadata = await readFile(path.join(root, 'deploy', 'hf', 'README.md'), 'utf8');
    await writeFile(path.join(temporaryDirectory, 'README.md'), metadata, 'utf8');
    await rm(archivePath, { force: true });
    run('git', ['init'], temporaryDirectory);
    run('git', ['config', 'user.name', 'Image Similarity Space Deploy'], temporaryDirectory);
    run('git', ['config', 'user.email', 'deploy@image-similarity.invalid'], temporaryDirectory);
    run('git', ['add', '-A'], temporaryDirectory);
    run('git', ['commit', '-m', 'deploy: publish image similarity API'], temporaryDirectory);
    run('git', ['push', '--force', spaceUrl, 'HEAD:main'], temporaryDirectory);
    console.log('Hugging Face Space deployment completed.');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(sanitized(message));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? sanitized(error.message) : 'Hugging Face Space deployment failed.');
  process.exitCode = 1;
});

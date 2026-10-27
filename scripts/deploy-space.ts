import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.cwd());
const spaceId = process.env.HF_SPACE_ID ?? 'beluga-69/securepixel-ai-service';
const explicitSpaceUrl = process.env.HF_SPACE_URL;
const environmentToken = process.env.HF_TOKEN;

interface DeploymentTarget {
  remoteUrl: string;
  username: string;
  token: string;
}

function resolveTarget(): DeploymentTarget {
  if (!explicitSpaceUrl && !environmentToken) {
    throw new Error('Set HF_SPACE_URL, or set HF_TOKEN for the configured Hugging Face Space.');
  }

  let remoteUrl = `https://huggingface.co/spaces/${spaceId}`;
  let username = 'hf_user';
  let token = environmentToken;
  if (explicitSpaceUrl) {
    let parsed: URL;
    try {
      parsed = new URL(explicitSpaceUrl);
    } catch {
      throw new Error('HF_SPACE_URL must be a valid HTTPS or HTTP Git URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('HF_SPACE_URL must be an HTTPS or HTTP Git URL.');
    }
    username = decodeURIComponent(parsed.username) || username;
    token = decodeURIComponent(parsed.password) || token;
    parsed.username = '';
    parsed.password = '';
    remoteUrl = parsed.toString().replace(/\/$/, '');
  }
  if (!token) throw new Error('A Hugging Face write token is required through HF_TOKEN or HF_SPACE_URL.');
  return { remoteUrl, username, token };
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sanitized(value: string): string {
  return environmentToken ? value.replaceAll(environmentToken, '[HF_TOKEN]') : value;
}

async function main(): Promise<void> {
  const target = resolveTarget();
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
    const auth = Buffer.from(`${target.username}:${target.token}`).toString('base64');
    run('git', ['push', '--force', target.remoteUrl, 'HEAD:main'], temporaryDirectory, {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
      GIT_TERMINAL_PROMPT: '0',
    });
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

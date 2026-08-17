/**
 * One-step launcher.
 *
 * Written in plain Node with **no dependencies and no build step**, because it has to be able to
 * run *before* `npm install` has ever happened. Anything importing from `node_modules` here would
 * be useless to the person this script exists for: someone who has just downloaded the project
 * and wants to see it work.
 *
 * It checks the Node version, installs dependencies if they are missing, starts the dev server,
 * waits until it is genuinely answering requests, and only then opens a browser. Waiting for a
 * real response rather than guessing with a timer is the difference between landing on the app
 * and landing on a connection-refused page.
 *
 *   node scripts/start.mjs            start and open a browser
 *   node scripts/start.mjs --no-open  start without opening a browser
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 1430;
const ADDRESS = `http://localhost:${PORT}/`;

/** Vite 6 needs a modern Node. Failing here beats failing later with a cryptic syntax error. */
const MINIMUM_NODE_MAJOR = 20;

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';

function say(text = '') {
  process.stdout.write(`${text}\n`);
}

function fail(heading, detail) {
  say('');
  say(`${RED}${BOLD}${heading}${RESET}`);
  say('');
  for (const line of detail) say(`  ${line}`);
  say('');
  process.exitCode = 1;
}

/** npm is a shell script on POSIX and a .cmd shim on Windows. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Runs a command line through a shell.
 *
 * The whole command goes in as a single string with no separate `args` array, which is not a
 * style choice: Node warns (DEP0190) when args are passed alongside `shell: true`, because they
 * are concatenated rather than escaped. Only used for `npm install`, where the arguments are
 * fixed literals rather than anything derived from input.
 */
function runShell(commandLine) {
  return new Promise((resolve) => {
    const child = spawn(commandLine, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/** Where Vite's own entry point lives, once dependencies are installed. */
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR) return true;

  fail(`Node ${MINIMUM_NODE_MAJOR} or newer is required.`, [
    `You are running Node ${process.versions.node}.`,
    '',
    'Install a current version from https://nodejs.org and run this again.',
  ]);
  return false;
}

/** True when something is already listening, so we do not start a second copy. */
async function portInUse() {
  try {
    await fetch(ADDRESS, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(ADDRESS, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // Not up yet. Vite is still starting, or this is the first cold transform.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? // The empty string is the window title, which `start` requires before a quoted URL.
        ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  // A machine with no default browser must not take the server down with it.
  child.on('error', () => {});
  child.unref();
}

async function main() {
  const openWhenReady = !process.argv.includes('--no-open');

  say('');
  say(`${BOLD}Personal Finance Tool${RESET}`);
  say(`${DIM}Starting up. No API key is needed to look around.${RESET}`);
  say('');

  if (!checkNode()) return;

  if (await portInUse()) {
    fail(`Port ${PORT} is already in use.`, [
      'The tool may already be running. Try opening:',
      `  ${ADDRESS}`,
      '',
      'If something else is using that port, stop it and run this again.',
    ]);
    return;
  }

  if (!existsSync(join(ROOT, 'node_modules'))) {
    say(`${YELLOW}First run: installing dependencies. This takes a minute.${RESET}`);
    say('');
    const code = await runShell(`${NPM} install`);
    if (code !== 0) {
      fail('Installing dependencies failed.', [
        code === -1
          ? 'npm could not be found. Install Node.js from https://nodejs.org, which includes it.'
          : 'The npm output above says what went wrong.',
      ]);
      return;
    }
    say('');
  }

  if (!existsSync(VITE_BIN)) {
    fail('Dependencies look incomplete.', [
      'Vite is missing from node_modules. Run this to repair it:',
      '  npm install',
    ]);
    return;
  }

  // Vite is started directly with this same Node binary rather than via `npm run dev`. That
  // skips a shell and an npm process, so Ctrl+C reaches the server cleanly instead of orphaning
  // it behind a shim.
  const server = spawn(process.execPath, [VITE_BIN], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  server.on('error', () => {
    fail('The dev server could not be started.', [
      'Try running it directly to see the error:',
      '  npm run dev',
    ]);
  });

  const stop = () => {
    if (server.exitCode === null) server.kill();
  };
  process.on('SIGINT', () => {
    stop();
    say('');
    say(`${DIM}Stopped.${RESET}`);
    process.exit(0);
  });
  process.on('SIGTERM', stop);
  process.on('exit', stop);

  const ready = await waitForServer(server);

  if (!ready) {
    fail('The dev server did not start.', [
      'Any error above says why. You can also try running it directly:',
      '  npm run dev',
    ]);
    stop();
    return;
  }

  say(`${GREEN}${BOLD}Ready.${RESET}  ${BOLD}${ADDRESS}${RESET}`);
  say('');
  say(`  ${DIM}Opens on fictional demo data, so every screen has something to show.${RESET}`);
  say(`  ${DIM}For live AI commentary, paste an Anthropic API key into Settings.${RESET}`);
  say(`  ${DIM}Without one it uses recorded commentary; every figure is still calculated.${RESET}`);
  say('');
  say(`  ${DIM}Press Ctrl+C to stop.${RESET}`);
  say('');

  if (openWhenReady) openBrowser(ADDRESS);

  // Stay alive as long as the server does, so Ctrl+C reaches both.
  server.on('close', (code) => process.exit(code ?? 0));
}

await main();

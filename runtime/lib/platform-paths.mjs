import os from 'node:os';
import path from 'node:path';

function requirePath(value, label, paths) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return paths.resolve(value);
}

export function resolveDesktopPaths({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  appData = undefined,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const resolvedHome = requirePath(home, 'home', paths);
  let root;
  let cache;

  if (platform === 'win32') {
    const local = requirePath(appData ?? env.LOCALAPPDATA, 'LOCALAPPDATA', paths);
    root = paths.join(local, 'GitHubModelRelay');
    cache = paths.join(root, 'cache');
  } else if (platform === 'darwin') {
    root = paths.join(
      appData ?? paths.join(resolvedHome, 'Library', 'Application Support'),
      'GitHub Model Relay',
    );
    cache = paths.join(
      env.XDG_CACHE_HOME
        ? paths.resolve(env.XDG_CACHE_HOME)
        : paths.join(resolvedHome, 'Library', 'Caches'),
      'github-model-relay',
    );
  } else if (platform === 'linux') {
    root = paths.join(
      env.XDG_STATE_HOME
        ? paths.resolve(env.XDG_STATE_HOME)
        : paths.join(resolvedHome, '.local', 'state'),
      'github-model-relay',
    );
    cache = paths.join(
      env.XDG_CACHE_HOME
        ? paths.resolve(env.XDG_CACHE_HOME)
        : paths.join(resolvedHome, '.cache'),
      'github-model-relay',
    );
  } else {
    throw new Error(`Unsupported desktop platform: ${platform}`);
  }

  return {
    root: paths.resolve(root),
    cache: paths.resolve(cache),
    legacyWindowsRoot: platform === 'win32'
      ? paths.join(
          requirePath(env.LOCALAPPDATA, 'LOCALAPPDATA', paths),
          'CopilotHarnessGateway',
        )
      : null,
  };
}

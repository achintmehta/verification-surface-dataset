import { resolveConfig } from 'vite';
for (const root of [undefined, 'client']) {
  try {
    const cfg = await resolveConfig({ root }, 'serve');
    const cf = cfg.configFile ? cfg.configFile.replace(process.cwd(),'.') : 'NONE (config not found)';
    console.log('vite ' + (root ? 'client' : '(no positional)') + '  ->  configFile:', cf,
                '| proxy:', JSON.stringify(cfg.server?.proxy));
  } catch (e) { console.log('root=', root, 'ERROR', e.message); }
}

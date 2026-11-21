'use strict';
// Bridges the MCP tool interface to Electron desktopCapturer, Windows probe,
// Hands actions, and saved routines from the main process.

const path = require('path');
const { createActions, createBrowserLaunch, createDefaultBrowser, createFileSearch } = require('../hands/actions');
const routinesMod = require('../reflex/routines');

function createElectronMcpToolDeps({ electron, app, shell, companion, userData, routinesFile } = {}) {
  const { execFile } = require('child_process');
  const os = require('os');
  let probe = null;
  try { probe = require('../win/probe'); } catch (_) { probe = null; }

  function getActions() {
    return createActions({
      probe: probe ? { request: (op, p, ms) => probe.request(op, p, ms) } : null,
      shell,
      launchBrowser: createBrowserLaunch({ execFile }),
      defaultBrowser: createDefaultBrowser({ execFile }),
      searchFiles: createFileSearch({ homedir: os.homedir(), execFile }),
      log: (m) => console.log('[mcp-hands]', m),
      selfPid: process.pid,
    });
  }

  async function readScreen() {
    if (!probe || !probe.request) return { fg: null, elements: [], cursor: null };
    try {
      const res = await probe.request('read', {}, 2500);
      return { fg: (res && res.fg) || null, elements: (res && res.elements) || [], cursor: (res && res.cursor) || null };
    } catch (_) {
      return { fg: null, elements: [], cursor: null };
    }
  }

  return {
    screenshot: async ({ maxSide } = {}) => {
      const { desktopCapturer, screen } = electron;
      const disp = screen.getPrimaryDisplay();
      const scale = disp.scaleFactor || 1;
      const w = Math.min(maxSide || 1440, Math.round(disp.size.width * scale));
      const h = Math.min(maxSide || 1440, Math.round(disp.size.height * scale));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
      const src = sources[0];
      if (!src) throw new Error('No screen source available.');
      const jpg = src.thumbnail.toJPEG(82);
      return {
        dataUrl: 'data:image/jpeg;base64,' + jpg.toString('base64'),
        pxWidth: src.thumbnail.getSize().width,
        pxHeight: src.thumbnail.getSize().height,
        displayId: disp.id,
      };
    },
    getScreenState: async () => {
      const s = await readScreen();
      return {
        window: s.fg ? { title: s.fg.title || '', process: s.fg.process || '', pid: s.fg.pid || null } : null,
        cursor: s.cursor || null,
        elements: (s.elements || []).slice(0, 80).map((e) => ({ id: e.id, name: e.name, type: e.type, rect: e.rect })),
      };
    },
    pointAtElement: async (args = {}) => {
      if (companion && typeof companion.ask === 'function') {
        const label = args.message || args.text || (args.id != null ? `element ${args.id}` : 'here');
        companion.ask(`point at ${label}`);
        return { ok: true, pointed: label };
      }
      return { ok: false, error: 'Companion overlay not ready.' };
    },
    click: async (args = {}) => {
      const s = await readScreen();
      return getActions().click.run(args, { elements: s.elements, fg: s.fg, originPhys: { x: 0, y: 0 } });
    },
    type: async (args = {}) => {
      const s = await readScreen();
      return getActions().type.run(args, { elements: s.elements, fg: s.fg, originPhys: { x: 0, y: 0 } });
    },
    pressKey: async (args = {}) => {
      const s = await readScreen();
      return getActions().press.run(args, { elements: s.elements, fg: s.fg });
    },
    scroll: async (args = {}) => {
      const s = await readScreen();
      return getActions().scroll.run(args, { elements: s.elements, fg: s.fg });
    },
    launchApp: async (args = {}) => {
      const s = await readScreen();
      return getActions().open_app.run({ name: args.app }, { elements: s.elements, fg: s.fg });
    },
    runRoutine: async (args = {}) => {
      const rFile = routinesFile || path.join(userData || app.getPath('userData'), 'reflex-routines.json');
      const list = routinesMod.load(rFile);
      const match = args.name
        ? list.find((r) => String(r.name || '').toLowerCase().includes(String(args.name).toLowerCase()))
        : routinesMod.latest(rFile);
      if (!match) return { ok: false, error: 'No matching saved routine found.' };
      if (companion && typeof companion.ask === 'function') {
        companion.ask(`run routine ${match.name}`);
      }
      return { ok: true, routine: match.name, steps: (match.steps || []).length };
    },
  };
}

module.exports = { createElectronMcpToolDeps };

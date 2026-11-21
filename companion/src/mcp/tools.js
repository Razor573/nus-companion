'use strict';
// MCP tool definitions and dependency-injected handlers for Nūs Companion.
// Exposes 9 tools: screenshot, get_screen_state, point_at_element, click,
// type, press_key, scroll, launch_app, run_routine.

const TOOL_SPECS = [
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the current active display.',
    inputSchema: {
      type: 'object',
      properties: {
        maxSide: { type: 'number', description: 'Optional max pixel dimension (default 1440).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_screen_state',
    description: 'Get the current front window title, process, cursor position, and visible UI elements.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'point_at_element',
    description: 'Point the Knot and thread at a screen element by id, label text, or normalized (0..1) coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Element ID from get_screen_state.' },
        text: { type: 'string', description: 'Element label or text to point at.' },
        x: { type: 'number', description: 'Normalized X coordinate (0..1).' },
        y: { type: 'number', description: 'Normalized Y coordinate (0..1).' },
        message: { type: 'string', description: 'Optional short guiding message for the bubble.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click a UI element by id, text, or normalized (0..1) coordinates using Hands.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Element ID from get_screen_state.' },
        text: { type: 'string', description: 'Visible text/label of the element to click.' },
        near: { type: 'string', description: 'Optional nearby label to disambiguate.' },
        x: { type: 'number', description: 'Normalized X coordinate (0..1).' },
        y: { type: 'number', description: 'Normalized Y coordinate (0..1).' },
        doubleClick: { type: 'boolean', description: 'Whether to double-click.' },
        rightClick: { type: 'boolean', description: 'Whether to right-click.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description: 'Type text into the focused field or a target element using Hands.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        id: { type: 'number', description: 'Optional element ID to focus first.' },
        targetText: { type: 'string', description: 'Optional element label to focus first.' },
        pressEnter: { type: 'boolean', description: 'Whether to press Enter after typing.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key or shortcut chord (e.g., "enter", "ctrl+s", "alt+tab").',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'Key or chord such as "enter", "ctrl+c", "alt+tab".' },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the active window or area.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
        amount: { type: 'number', description: 'Number of scroll pages/steps (1..5).' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'launch_app',
    description: 'Launch or focus an installed application by name.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Application name (e.g., "Notepad", "Chrome").' },
      },
      required: ['app'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_routine',
    description: 'Run a saved Nūs routine by name (or the most recently saved routine).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional routine name to match.' },
      },
      additionalProperties: false,
    },
  },
];

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(String(dataUrl || ''));
  return m ? { mimeType: m[1], data: m[2] } : null;
}

function createToolHandlers(deps = {}) {
  return {
    async screenshot(args = {}) {
      if (typeof deps.screenshot !== 'function') {
        throw new Error('Screenshot capability is not wired.');
      }
      const cap = await deps.screenshot({ maxSide: Number(args.maxSide) || 1440 });
      const parsed = stripDataUrl(cap && cap.dataUrl);
      if (!parsed) throw new Error('Failed to capture screenshot.');
      return {
        content: [
          { type: 'image', data: parsed.data, mimeType: parsed.mimeType },
          {
            type: 'text',
            text: JSON.stringify({
              width: cap.pxWidth || cap.width || null,
              height: cap.pxHeight || cap.height || null,
              displayId: cap.displayId || null,
            }),
          },
        ],
      };
    },

    async get_screen_state() {
      if (typeof deps.getScreenState !== 'function') {
        throw new Error('Screen state capability is not wired.');
      }
      const state = await deps.getScreenState();
      return {
        content: [{ type: 'text', text: JSON.stringify(state || {}) }],
      };
    },

    async point_at_element(args = {}) {
      if (typeof deps.pointAtElement !== 'function') {
        throw new Error('Pointing capability is not wired.');
      }
      const res = await deps.pointAtElement(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(res || { ok: true }) }],
      };
    },

    async click(args = {}) {
      if (typeof deps.click !== 'function') {
        throw new Error('Hands click capability is not wired.');
      }
      const res = await deps.click(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(res || { ok: true }) }],
        isError: res && res.ok === false ? true : undefined,
      };
    },

    async type(args = {}) {
      if (typeof deps.type !== 'function') {
        throw new Error('Hands type capability is not wired.');
      }
      if (typeof args.text !== 'string') throw new Error('text is required.');
      const res = await deps.type(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(res || { ok: true }) }],
        isError: res && res.ok === false ? true : undefined,
      };
    },

    async press_key(args = {}) {
      if (typeof deps.pressKey !== 'function') {
        throw new Error('Hands press_key capability is not wired.');
      }
      if (!args.keys) throw new Error('keys is required.');
      const res = await deps.pressKey(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(res || { ok: true }) }],
        isError: res && res.ok === false ? true : undefined,
      };
    },

    async scroll(args = {}) {
      if (typeof deps.scroll !== 'function') {
        throw new Error('Hands scroll capability is not wired.');
      }
      const res = await deps.scroll(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(res || { ok: true }) }],
        isError: res && res.ok === false ? true : undefined,
      };
    },

    async launch_app(args = {}) {
      if (typeof deps.launchApp !== 'function') {
        throw new Error('App launch capability is not wired.');
      }
      if (!args.app) throw new Error('app is required.');
      const res = await deps.launchApp(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(res || { ok: true }) }],
        isError: res && res.ok === false ? true : undefined,
      };
    },

    async run_routine(args = {}) {
      if (typeof deps.runRoutine !== 'function') {
        throw new Error('Routine runner capability is not wired.');
      }
      const res = await deps.runRoutine(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(res || { ok: true }) }],
        isError: res && res.ok === false ? true : undefined,
      };
    },
  };
}

module.exports = { TOOL_SPECS, createToolHandlers };
